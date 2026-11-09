ALTER TABLE public.ledger_accounts
  ADD COLUMN user_id uuid REFERENCES public.users(id),
  ADD CONSTRAINT ledger_accounts_user_id_bucket_key UNIQUE(user_id, bucket),
  DROP CONSTRAINT ledger_accounts_check,
  ADD CONSTRAINT ledger_accounts_check CHECK (
    (agent_id IS NOT NULL AND user_id IS NULL AND system_key IS NULL
      AND bucket IN ('AVAILABLE', 'RESERVED') AND normal_side = 'debit')
    OR (agent_id IS NULL AND user_id IS NOT NULL AND system_key IS NULL
      AND bucket = 'USER_AVAILABLE' AND normal_side = 'debit')
    OR (agent_id IS NULL AND user_id IS NULL AND system_key IS NOT NULL AND bucket = system_key
      AND ((system_key IN ('REWARD_POOL', 'REWARD_RESERVED', 'RECOVERY') AND normal_side = 'debit')
        OR (system_key = 'ISSUANCE_CONTROL' AND normal_side = 'credit')))
  );

ALTER TABLE public.journal_transactions DROP CONSTRAINT journal_transactions_kind_check;
ALTER TABLE public.journal_transactions ADD CONSTRAINT journal_transactions_kind_check
  CHECK (kind IN ('ISSUE', 'INITIAL_GRANT', 'TRANSFER', 'RESERVE', 'ADJUST_HOLD', 'FINALIZE_HOLD', 'PAY', 'REFUND'));

CREATE OR REPLACE FUNCTION ledger.post_journal(header jsonb, entries jsonb)
RETURNS TABLE(transaction_id uuid, created boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_kind text := header->>'kind';
  v_business_key text := header->>'business_key';
  v_header jsonb;
  v_entries jsonb;
  v_hash bytea;
  v_existing public.journal_transactions%ROWTYPE;
  v_transaction_id uuid;
  v_count integer;
  v_debits numeric;
  v_credits numeric;
  v_source record;
  v_reserved record;
BEGIN
  IF jsonb_typeof(header) IS DISTINCT FROM 'object'
    OR v_kind IS NULL OR v_kind NOT IN ('ISSUE', 'INITIAL_GRANT', 'TRANSFER', 'RESERVE', 'ADJUST_HOLD', 'FINALIZE_HOLD', 'PAY', 'REFUND')
    OR v_business_key IS NULL OR length(btrim(v_business_key)) = 0
    OR header->>'reason' IS NULL OR length(btrim(header->>'reason')) = 0
    OR header->>'business_date' IS NULL
    OR NOT coalesce((header->>'spend_points') ~ '^(0|[1-9][0-9]*)$', false)
    OR jsonb_typeof(entries) IS DISTINCT FROM 'array'
  THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'INVALID_JOURNAL'; END IF;

  IF EXISTS (SELECT 1 FROM jsonb_array_elements(entries) e WHERE
    jsonb_typeof(e) IS DISTINCT FROM 'object'
    OR NOT coalesce((e->>'account_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false)
    OR NOT coalesce(e->>'side' IN ('debit', 'credit'), false)
    OR jsonb_typeof(e->'amount') IS DISTINCT FROM 'string'
    OR NOT coalesce((e->>'amount') ~ '^[1-9][0-9]*$', false))
  THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'INVALID_JOURNAL_ENTRY'; END IF;

  IF EXISTS (SELECT 1 FROM jsonb_array_elements(entries) e WHERE (e->>'amount')::numeric > 9223372036854775807)
    OR (header->>'spend_points')::numeric > 9223372036854775807
  THEN RAISE EXCEPTION USING ERRCODE = '22003', MESSAGE = 'AMOUNT_OUT_OF_RANGE'; END IF;

  -- Canonical net entries make input ordering and split lines immaterial.
  SELECT coalesce(jsonb_agg(jsonb_build_object('account_id', account_id::text,
    'side', CASE WHEN net > 0 THEN 'debit' ELSE 'credit' END, 'amount', abs(net)::text) ORDER BY account_id), '[]'::jsonb)
  INTO v_entries FROM (
    SELECT (e->>'account_id')::uuid AS account_id,
      sum(CASE WHEN e->>'side' = 'debit' THEN (e->>'amount')::numeric ELSE -(e->>'amount')::numeric END) AS net
    FROM jsonb_array_elements(entries) e GROUP BY (e->>'account_id')::uuid
  ) net_entries WHERE net <> 0;

  SELECT count(*), coalesce(sum(CASE WHEN e->>'side' = 'debit' THEN (e->>'amount')::numeric ELSE 0 END), 0),
    coalesce(sum(CASE WHEN e->>'side' = 'credit' THEN (e->>'amount')::numeric ELSE 0 END), 0)
  INTO v_count, v_debits, v_credits FROM jsonb_array_elements(v_entries) e;
  IF v_count < 2 OR v_debits <> v_credits OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_entries) e WHERE (e->>'amount')::numeric > 9223372036854775807)
  THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'UNBALANCED_JOURNAL'; END IF;

  v_header := jsonb_build_object(
    'kind', v_kind, 'business_key', v_business_key, 'actor_type', header->>'actor_type',
    'actor_user_id', (header->>'actor_user_id')::uuid, 'actor_agent_id', (header->>'actor_agent_id')::uuid,
    'represented_agent_id', (header->>'represented_agent_id')::uuid, 'credential_id', (header->>'credential_id')::uuid,
    'payer_agent_id', (header->>'payer_agent_id')::uuid, 'spend_points', ((header->>'spend_points')::bigint)::text,
    'business_date', (header->>'business_date')::date, 'correction_of', (header->>'correction_of')::uuid,
    'reason', header->>'reason');
  v_hash := sha256(convert_to(jsonb_build_object('header', v_header, 'entries', v_entries)::text, 'UTF8'));

  SELECT j.* INTO v_existing FROM public.journal_transactions j WHERE j.business_key = v_business_key;
  IF FOUND THEN
    IF v_existing.payload_hash <> v_hash THEN
      RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'BUSINESS_KEY_CONFLICT';
    END IF;
    RETURN QUERY SELECT v_existing.id, false;
    RETURN;
  END IF;

  -- Every writer acquires account locks in the same UUID order.
  PERFORM a.id FROM public.ledger_accounts a
    WHERE a.id IN (SELECT (e->>'account_id')::uuid FROM jsonb_array_elements(v_entries) e)
    ORDER BY a.id FOR UPDATE;
  IF (SELECT count(*) FROM public.ledger_accounts a
    WHERE a.id IN (SELECT (e->>'account_id')::uuid FROM jsonb_array_elements(v_entries) e)) <> v_count
  THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'UNKNOWN_LEDGER_ACCOUNT'; END IF;

  IF v_kind = 'INITIAL_GRANT' THEN
    IF v_count <> 2 OR v_debits <> 1000
      OR header->>'actor_type' IS DISTINCT FROM 'system'
      OR header->>'payer_agent_id' IS NOT NULL
      OR (header->>'spend_points')::bigint <> 0
      OR header->>'correction_of' IS NOT NULL
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_entries) e
        JOIN public.ledger_accounts a ON a.id = (e->>'account_id')::uuid
        WHERE ((a.bucket = 'USER_AVAILABLE' AND e->>'side' = 'debit'
            AND v_business_key = 'initial-funds:user:' || a.user_id::text)
          OR (a.system_key = 'ISSUANCE_CONTROL' AND e->>'side' = 'credit')) IS NOT TRUE)
    THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'INVALID_ACCOUNT_COMBINATION'; END IF;
  ELSIF v_kind = 'TRANSFER' THEN
    IF v_count <> 2
      OR (SELECT count(*) FROM jsonb_array_elements(v_entries) e WHERE e->>'side' = 'credit') <> 1
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_entries) e
        JOIN public.ledger_accounts a ON a.id = (e->>'account_id')::uuid
        WHERE a.bucket NOT IN ('USER_AVAILABLE', 'AVAILABLE'))
    THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'INVALID_ACCOUNT_COMBINATION'; END IF;
  ELSIF v_kind = 'ISSUE' THEN
    IF v_count <> 2 OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_entries) e
      JOIN public.ledger_accounts a ON a.id = (e->>'account_id')::uuid
      WHERE ((a.system_key = 'REWARD_POOL' AND e->>'side' = 'debit')
        OR (a.system_key = 'ISSUANCE_CONTROL' AND e->>'side' = 'credit')) IS NOT TRUE)
    THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'INVALID_ACCOUNT_COMBINATION'; END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_entries) e JOIN public.ledger_accounts a
      ON a.id = (e->>'account_id')::uuid WHERE a.system_key = 'ISSUANCE_CONTROL')
    THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'ISSUANCE_CONTROL_RESTRICTED'; END IF;

    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_entries) e JOIN public.ledger_accounts a
      ON a.id = (e->>'account_id')::uuid WHERE a.bucket = 'USER_AVAILABLE')
    THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'INVALID_ACCOUNT_COMBINATION'; END IF;

    IF v_kind IN ('RESERVE', 'ADJUST_HOLD') THEN
      SELECT a.*, e->>'side' AS side INTO v_source FROM jsonb_array_elements(v_entries) e
        JOIN public.ledger_accounts a ON a.id = (e->>'account_id')::uuid WHERE a.bucket IN ('AVAILABLE', 'REWARD_POOL');
      SELECT a.*, e->>'side' AS side INTO v_reserved FROM jsonb_array_elements(v_entries) e
        JOIN public.ledger_accounts a ON a.id = (e->>'account_id')::uuid WHERE a.bucket IN ('RESERVED', 'REWARD_RESERVED');
      IF v_count <> 2 OR v_source.id IS NULL OR v_reserved.id IS NULL
        OR v_source.agent_id IS DISTINCT FROM v_reserved.agent_id
        OR v_source.side = v_reserved.side
        OR (v_kind = 'RESERVE' AND v_reserved.side <> 'debit')
      THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'INVALID_ACCOUNT_COMBINATION'; END IF;
    ELSIF v_kind = 'FINALIZE_HOLD' THEN
      IF (SELECT count(*) FROM jsonb_array_elements(v_entries) e WHERE e->>'side' = 'credit') <> 1
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_entries) e JOIN public.ledger_accounts a
          ON a.id = (e->>'account_id')::uuid WHERE
          (e->>'side' = 'credit' AND a.bucket NOT IN ('RESERVED', 'REWARD_RESERVED'))
          OR (e->>'side' = 'debit' AND a.bucket NOT IN ('AVAILABLE', 'REWARD_POOL')))
        OR (EXISTS (SELECT 1 FROM jsonb_array_elements(v_entries) e JOIN public.ledger_accounts a
          ON a.id = (e->>'account_id')::uuid WHERE a.bucket = 'REWARD_POOL')
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_entries) e JOIN public.ledger_accounts a
            ON a.id = (e->>'account_id')::uuid WHERE a.bucket = 'REWARD_RESERVED'))
      THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'INVALID_ACCOUNT_COMBINATION'; END IF;
    ELSIF v_kind IN ('PAY', 'REFUND') THEN
      IF v_count <> 2 OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_entries) e JOIN public.ledger_accounts a
        ON a.id = (e->>'account_id')::uuid WHERE NOT
        ((a.bucket = 'AVAILABLE' AND e->>'side' = CASE WHEN v_kind = 'PAY' THEN 'credit' ELSE 'debit' END)
          OR (a.bucket = 'RECOVERY' AND e->>'side' = CASE WHEN v_kind = 'PAY' THEN 'debit' ELSE 'credit' END)))
      THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'INVALID_ACCOUNT_COMBINATION'; END IF;
    END IF;
  END IF;

  INSERT INTO public.journal_transactions (kind, business_key, payload_hash, actor_type, actor_user_id,
    actor_agent_id, represented_agent_id, credential_id, payer_agent_id, spend_points, business_date, correction_of, reason)
  VALUES (v_kind, v_business_key, v_hash, v_header->>'actor_type', (v_header->>'actor_user_id')::uuid,
    (v_header->>'actor_agent_id')::uuid, (v_header->>'represented_agent_id')::uuid, (v_header->>'credential_id')::uuid,
    (v_header->>'payer_agent_id')::uuid, (v_header->>'spend_points')::bigint, (v_header->>'business_date')::date,
    (v_header->>'correction_of')::uuid, v_header->>'reason')
  ON CONFLICT (business_key) DO NOTHING RETURNING id INTO v_transaction_id;
  IF v_transaction_id IS NULL THEN
    SELECT j.* INTO v_existing FROM public.journal_transactions j WHERE j.business_key = v_business_key;
    IF v_existing.payload_hash <> v_hash THEN
      RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'BUSINESS_KEY_CONFLICT';
    END IF;
    RETURN QUERY SELECT v_existing.id, false;
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_entries) e JOIN public.ledger_accounts a
    ON a.id = (e->>'account_id')::uuid WHERE a.balance::numeric +
      CASE WHEN a.normal_side = e->>'side' THEN (e->>'amount')::numeric ELSE -(e->>'amount')::numeric END < 0)
  THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INSUFFICIENT_FUNDS'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_entries) e JOIN public.ledger_accounts a
    ON a.id = (e->>'account_id')::uuid WHERE a.balance::numeric +
      CASE WHEN a.normal_side = e->>'side' THEN (e->>'amount')::numeric ELSE -(e->>'amount')::numeric END > 9223372036854775807)
  THEN RAISE EXCEPTION USING ERRCODE = '22003', MESSAGE = 'AMOUNT_OUT_OF_RANGE'; END IF;

  INSERT INTO public.journal_entries(transaction_id, line_no, account_id, side, amount)
    SELECT v_transaction_id, ordinal::integer, (e->>'account_id')::uuid, e->>'side', (e->>'amount')::bigint
    FROM jsonb_array_elements(v_entries) WITH ORDINALITY AS item(e, ordinal);
  UPDATE public.ledger_accounts a SET balance = (a.balance::numeric +
    CASE WHEN a.normal_side = e->>'side' THEN (e->>'amount')::numeric ELSE -(e->>'amount')::numeric END)::bigint
    FROM jsonb_array_elements(v_entries) e WHERE a.id = (e->>'account_id')::uuid;
  RETURN QUERY SELECT v_transaction_id, true;
END;
$$;
REVOKE ALL ON FUNCTION ledger.post_journal(jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ledger.post_journal(jsonb, jsonb) TO agentzero_app;

CREATE FUNCTION ledger.open_user_account(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_account_id uuid;
  v_control_id uuid;
  v_key text := 'initial-funds:user:' || p_user_id::text;
  v_existing_kind text;
  v_transaction_id uuid;
  v_created boolean;
BEGIN
  -- Share the owner lock used by account status changes and wallet commands.
  PERFORM u.id FROM public.users u WHERE u.id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'UNKNOWN_USER'; END IF;

  INSERT INTO public.ledger_accounts(user_id, bucket, normal_side)
    VALUES(p_user_id, 'USER_AVAILABLE', 'debit')
    ON CONFLICT(user_id, bucket) DO NOTHING;
  SELECT a.id INTO v_account_id FROM public.ledger_accounts a
    WHERE a.user_id = p_user_id AND a.bucket = 'USER_AVAILABLE';
  SELECT j.kind INTO v_existing_kind FROM public.journal_transactions j WHERE j.business_key = v_key;
  IF FOUND THEN
    IF v_existing_kind <> 'INITIAL_GRANT' THEN
      RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'BUSINESS_KEY_CONFLICT';
    END IF;
    RETURN;
  END IF;

  SELECT a.id INTO v_control_id FROM public.ledger_accounts a WHERE a.system_key = 'ISSUANCE_CONTROL';
  IF v_control_id IS NULL THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'UNKNOWN_LEDGER_ACCOUNT'; END IF;
  IF EXISTS (SELECT 1 FROM public.audit_events a WHERE a.action = 'ledger.quarantined'
    AND (a.target_type = 'ledger' OR (a.target_type = 'account' AND a.target_id IN (v_account_id::text, v_control_id::text))))
  THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'LEDGER_QUARANTINED'; END IF;

  SELECT j.transaction_id, j.created INTO v_transaction_id, v_created FROM ledger.post_journal(
    jsonb_build_object('kind', 'INITIAL_GRANT', 'business_key', v_key, 'actor_type', 'system',
      'spend_points', '0', 'business_date', (clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date,
      'reason', '用户初始资金'),
    jsonb_build_array(
      jsonb_build_object('account_id', v_account_id::text, 'side', 'debit', 'amount', '1000'),
      jsonb_build_object('account_id', v_control_id::text, 'side', 'credit', 'amount', '1000'))
  ) j;
  IF v_created THEN
    INSERT INTO public.audit_events(actor_type, action, target_type, target_id, request_id, business_key, details)
      VALUES('system', 'wallet.initial_grant', 'user', p_user_id::text, v_key, v_key,
        jsonb_build_object('user_id', p_user_id::text, 'account_id', v_account_id::text,
          'transaction_id', v_transaction_id::text, 'amount', '1000'));
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION ledger.open_user_account(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ledger.open_user_account(uuid) TO agentzero_app;

-- Existing people receive the same one-time grant as future registrations.
DO $$
DECLARE v_user_id uuid;
BEGIN
  FOR v_user_id IN SELECT id FROM public.users ORDER BY id LOOP
    PERFORM ledger.open_user_account(v_user_id);
  END LOOP;
END;
$$;
