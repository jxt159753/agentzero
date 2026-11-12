-- Administrator adjustments redistribute existing points; they never mint or touch escrow.
ALTER TABLE public.journal_transactions
  DROP CONSTRAINT journal_transactions_kind_check,
  ADD CONSTRAINT journal_transactions_kind_check
    CHECK (kind IN ('ISSUE', 'INITIAL_GRANT', 'TRANSFER', 'RESERVE', 'ADJUST_HOLD', 'FINALIZE_HOLD', 'PAY', 'REFUND', 'RECYCLE', 'ADMIN_ADJUST'));

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
    OR v_kind IS NULL OR v_kind NOT IN ('ISSUE', 'INITIAL_GRANT', 'TRANSFER', 'RESERVE', 'ADJUST_HOLD', 'FINALIZE_HOLD', 'PAY', 'REFUND', 'RECYCLE', 'ADMIN_ADJUST')
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
    -- Historical journals can replay above; public registrations no longer mint currency.
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'INITIAL_GRANT_DISABLED';
  ELSIF v_kind = 'RECYCLE' THEN
    IF v_count <> 2
      OR header->>'payer_agent_id' IS NOT NULL
      OR (header->>'spend_points')::bigint <> 0
      OR header->>'correction_of' IS NOT NULL
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_entries) e
        JOIN public.ledger_accounts a ON a.id = (e->>'account_id')::uuid
        WHERE ((a.system_key = 'RECOVERY' AND e->>'side' = 'credit')
          OR (a.system_key = 'REWARD_POOL' AND e->>'side' = 'debit')) IS NOT TRUE)
    THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'INVALID_ACCOUNT_COMBINATION'; END IF;
  ELSIF v_kind = 'ADMIN_ADJUST' THEN
    IF v_count <> 2
      OR header->>'actor_type' IS DISTINCT FROM 'user'
      OR header->>'payer_agent_id' IS NOT NULL
      OR (header->>'spend_points')::bigint <> 0
      OR header->>'correction_of' IS NOT NULL
      OR (SELECT count(*) FROM jsonb_array_elements(v_entries) e
        JOIN public.ledger_accounts a ON a.id = (e->>'account_id')::uuid
        WHERE a.bucket IN ('USER_AVAILABLE','AVAILABLE')) <> 1
      OR NOT (
        NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_entries) e
          JOIN public.ledger_accounts a ON a.id = (e->>'account_id')::uuid
          WHERE ((a.system_key='REWARD_POOL' AND e->>'side'='credit')
            OR (a.bucket IN ('USER_AVAILABLE','AVAILABLE') AND e->>'side'='debit')) IS NOT TRUE)
        OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_entries) e
          JOIN public.ledger_accounts a ON a.id = (e->>'account_id')::uuid
          WHERE ((a.bucket IN ('USER_AVAILABLE','AVAILABLE') AND e->>'side'='credit')
            OR (a.system_key='RECOVERY' AND e->>'side'='debit')) IS NOT TRUE))
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

    IF v_kind IN ('RESERVE', 'ADJUST_HOLD') THEN
      SELECT a.*, e->>'side' AS side INTO v_source FROM jsonb_array_elements(v_entries) e
        JOIN public.ledger_accounts a ON a.id = (e->>'account_id')::uuid WHERE a.bucket IN ('AVAILABLE', 'USER_AVAILABLE', 'REWARD_POOL');
      SELECT a.*, e->>'side' AS side INTO v_reserved FROM jsonb_array_elements(v_entries) e
        JOIN public.ledger_accounts a ON a.id = (e->>'account_id')::uuid WHERE a.bucket IN ('RESERVED', 'USER_RESERVED', 'REWARD_RESERVED');
      IF v_count <> 2 OR v_source.id IS NULL OR v_reserved.id IS NULL
        OR ((v_source.bucket = 'AVAILABLE' AND v_reserved.bucket = 'RESERVED'
            AND v_source.agent_id IS NOT NULL AND v_source.agent_id = v_reserved.agent_id)
          OR (v_source.bucket = 'USER_AVAILABLE' AND v_reserved.bucket = 'USER_RESERVED'
            AND v_source.user_id IS NOT NULL AND v_source.user_id = v_reserved.user_id)
          OR (v_source.bucket = 'REWARD_POOL' AND v_reserved.bucket = 'REWARD_RESERVED')) IS NOT TRUE
        OR v_source.side = v_reserved.side
        OR (v_kind = 'RESERVE' AND v_reserved.side <> 'debit')
      THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'INVALID_ACCOUNT_COMBINATION'; END IF;
    ELSIF v_kind = 'FINALIZE_HOLD' THEN
      IF (SELECT count(*) FROM jsonb_array_elements(v_entries) e WHERE e->>'side' = 'credit') <> 1
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_entries) e JOIN public.ledger_accounts a
          ON a.id = (e->>'account_id')::uuid WHERE
          (e->>'side' = 'credit' AND a.bucket NOT IN ('RESERVED', 'USER_RESERVED', 'REWARD_RESERVED'))
          OR (e->>'side' = 'debit' AND a.bucket NOT IN ('AVAILABLE', 'USER_AVAILABLE', 'REWARD_POOL')))
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

  -- PAY/REFUND keep the recovery account locked until their redemption row is
  -- inserted/updated. Use a fresh snapshot after locking and resolving replay.
  IF v_kind = 'RECYCLE' AND
    (SELECT a.balance::numeric FROM public.ledger_accounts a WHERE a.system_key='RECOVERY')
    - (SELECT COALESCE(sum(r.points_cost::numeric),0) FROM public.reward_redemptions r WHERE r.status IN ('pending','processing'))
    < v_debits
  THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INSUFFICIENT_FUNDS'; END IF;

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

