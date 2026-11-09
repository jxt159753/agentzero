-- Execute on an isolated PostgreSQL 18 test database after migrations.
-- Every fixture and test journal is rolled back, including successful assertions.
BEGIN;
SET LOCAL ROLE agentzero_app;
DO $$
DECLARE
  u uuid := gen_random_uuid();
  agent_a uuid := gen_random_uuid();
  agent_b uuid := gen_random_uuid();
  available_a uuid;
  reserved_a uuid;
  available_b uuid;
  reserved_b uuid;
  reward_pool uuid;
  reward_reserved uuid;
  control uuid;
  recovery uuid;
  header jsonb;
  entries jsonb;
  result record;
  first_id uuid;
  amount bigint;
  denied boolean;
  prefix text := 'sql-test:' || gen_random_uuid()::text;
BEGIN
  IF current_setting('server_version_num')::integer NOT BETWEEN 180000 AND 189999 THEN
    RAISE EXCEPTION 'PostgreSQL 18 is required';
  END IF;
  INSERT INTO public.users(id, github_user_id, github_login, display_name, status)
    VALUES(u, -abs(hashtext(u::text)::bigint) + 9000000000000000000, prefix, 'SQL test', 'active');
  INSERT INTO public.agents(id, owner_user_id, name) VALUES(agent_a, u, 'A'), (agent_b, u, 'B');
  INSERT INTO public.agent_policies(agent_id) VALUES(agent_a), (agent_b);
  PERFORM ledger.open_agent_accounts(agent_a);
  PERFORM ledger.open_agent_accounts(agent_a);
  PERFORM ledger.open_agent_accounts(agent_b);
  IF (SELECT count(*) FROM public.ledger_accounts WHERE agent_id IN (agent_a, agent_b)) <> 4 THEN
    RAISE EXCEPTION 'Account opening is not idempotent';
  END IF;
  SELECT id INTO available_a FROM public.ledger_accounts WHERE agent_id = agent_a AND bucket = 'AVAILABLE';
  SELECT id INTO reserved_a FROM public.ledger_accounts WHERE agent_id = agent_a AND bucket = 'RESERVED';
  SELECT id INTO available_b FROM public.ledger_accounts WHERE agent_id = agent_b AND bucket = 'AVAILABLE';
  SELECT id INTO reserved_b FROM public.ledger_accounts WHERE agent_id = agent_b AND bucket = 'RESERVED';
  SELECT id INTO reward_pool FROM public.ledger_accounts WHERE system_key = 'REWARD_POOL';
  SELECT id INTO reward_reserved FROM public.ledger_accounts WHERE system_key = 'REWARD_RESERVED';
  SELECT id INTO control FROM public.ledger_accounts WHERE system_key = 'ISSUANCE_CONTROL';
  SELECT id INTO recovery FROM public.ledger_accounts WHERE system_key = 'RECOVERY';
  header := jsonb_build_object('kind', 'ISSUE', 'business_key', prefix || ':issue', 'actor_type', 'user',
    'actor_user_id', u, 'spend_points', '0', 'business_date', current_date, 'reason', 'isolated SQL assertion');
  entries := jsonb_build_array(jsonb_build_object('account_id', reward_pool, 'side', 'debit', 'amount', '9007199254740993'),
    jsonb_build_object('account_id', control, 'side', 'credit', 'amount', '9007199254740993'));
  SELECT * INTO result FROM ledger.post_journal(header, entries);
  IF NOT result.created THEN RAISE EXCEPTION 'First posting was not created'; END IF;
  first_id := result.transaction_id;
  SELECT * INTO result FROM ledger.post_journal(header, jsonb_build_array(entries->1, entries->0));
  IF result.created OR result.transaction_id <> first_id THEN RAISE EXCEPTION 'Idempotent posting changed'; END IF;
  IF (SELECT e.amount FROM public.journal_entries e WHERE e.transaction_id = first_id AND e.account_id = reward_pool) <> 9007199254740993 THEN
    RAISE EXCEPTION 'Bigint precision was lost';
  END IF;

  denied := false;
  BEGIN
    PERFORM ledger.post_journal(header || '{"reason":"different"}', entries);
  EXCEPTION WHEN unique_violation THEN denied := true; END;
  IF NOT denied THEN RAISE EXCEPTION 'Changed business payload was accepted'; END IF;

  denied := false;
  BEGIN
    PERFORM ledger.post_journal(header || jsonb_build_object('business_key', prefix || ':unbalanced'),
      jsonb_build_array(entries->0, jsonb_build_object('account_id', control, 'side', 'credit', 'amount', '1')));
  EXCEPTION WHEN check_violation THEN denied := true; END;
  IF NOT denied THEN RAISE EXCEPTION 'Unbalanced journal was accepted'; END IF;

  denied := false;
  BEGIN
    PERFORM ledger.post_journal(header || jsonb_build_object('business_key', prefix || ':bad-issue'),
      jsonb_build_array(jsonb_build_object('account_id', available_a, 'side', 'debit', 'amount', '1'),
        jsonb_build_object('account_id', control, 'side', 'credit', 'amount', '1')));
  EXCEPTION WHEN check_violation THEN denied := true; END;
  IF NOT denied THEN RAISE EXCEPTION 'Issuance into arbitrary wallet was accepted'; END IF;

  PERFORM ledger.post_journal(header || jsonb_build_object('kind', 'RESERVE', 'business_key', prefix || ':reserve'),
    jsonb_build_array(jsonb_build_object('account_id', reward_reserved, 'side', 'debit', 'amount', '100'),
      jsonb_build_object('account_id', reward_pool, 'side', 'credit', 'amount', '100')));
  PERFORM ledger.post_journal(header || jsonb_build_object('kind', 'FINALIZE_HOLD', 'business_key', prefix || ':split'),
    jsonb_build_array(jsonb_build_object('account_id', reward_reserved, 'side', 'credit', 'amount', '100'),
      jsonb_build_object('account_id', available_a, 'side', 'debit', 'amount', '70'),
      jsonb_build_object('account_id', available_b, 'side', 'debit', 'amount', '30')));
  IF (SELECT balance FROM public.ledger_accounts WHERE id = available_a) <> 70
    OR (SELECT balance FROM public.ledger_accounts WHERE id = available_b) <> 30 THEN
    RAISE EXCEPTION 'Split settlement did not preserve amounts';
  END IF;

  denied := false;
  BEGIN
    PERFORM ledger.post_journal(header || jsonb_build_object('kind', 'RESERVE', 'business_key', prefix || ':cross-owner'),
      jsonb_build_array(jsonb_build_object('account_id', available_a, 'side', 'credit', 'amount', '10'),
        jsonb_build_object('account_id', reserved_b, 'side', 'debit', 'amount', '10')));
  EXCEPTION WHEN check_violation THEN denied := true; END;
  IF NOT denied THEN RAISE EXCEPTION 'Reservation across wallets was accepted'; END IF;

  denied := false;
  BEGIN
    PERFORM ledger.post_journal(header || jsonb_build_object('kind', 'RESERVE', 'business_key', prefix || ':overdraw'),
      jsonb_build_array(jsonb_build_object('account_id', available_a, 'side', 'credit', 'amount', '80'),
        jsonb_build_object('account_id', reserved_a, 'side', 'debit', 'amount', '80')));
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'INSUFFICIENT_FUNDS' THEN RAISE; END IF;
    denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Overdraft was accepted'; END IF;
  IF EXISTS(SELECT 1 FROM public.journal_transactions WHERE business_key = prefix || ':overdraw') THEN
    RAISE EXCEPTION 'Failed journal was not rolled back';
  END IF;

  SELECT balance INTO amount FROM public.ledger_accounts WHERE id = available_a;
  BEGIN
    PERFORM ledger.post_journal(header || jsonb_build_object('kind', 'PAY', 'business_key', prefix || ':outer-rollback',
      'payer_agent_id', agent_a, 'spend_points', '20'),
      jsonb_build_array(jsonb_build_object('account_id', available_a, 'side', 'credit', 'amount', '20'),
        jsonb_build_object('account_id', recovery, 'side', 'debit', 'amount', '20')));
    RAISE EXCEPTION 'TEST_OUTER_ROLLBACK';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'TEST_OUTER_ROLLBACK' THEN RAISE; END IF;
  END;
  IF (SELECT balance FROM public.ledger_accounts WHERE id = available_a) <> amount
    OR EXISTS(SELECT 1 FROM public.journal_transactions WHERE business_key = prefix || ':outer-rollback') THEN
    RAISE EXCEPTION 'Outer rollback did not remove ledger effects';
  END IF;

  denied := false;
  BEGIN UPDATE public.ledger_accounts SET balance = 999 WHERE id = available_a;
  EXCEPTION WHEN insufficient_privilege THEN denied := true; END;
  IF NOT denied THEN RAISE EXCEPTION 'Runtime can update balances directly'; END IF;
  denied := false;
  BEGIN INSERT INTO public.journal_entries VALUES(first_id, 99, available_a, 'debit', 1);
  EXCEPTION WHEN insufficient_privilege THEN denied := true; END;
  IF NOT denied THEN RAISE EXCEPTION 'Runtime can append old entries'; END IF;
  denied := false;
  BEGIN DELETE FROM public.journal_transactions WHERE id = first_id;
  EXCEPTION WHEN insufficient_privilege THEN denied := true; END;
  IF NOT denied THEN RAISE EXCEPTION 'Runtime can delete journals'; END IF;
  denied := false;
  BEGIN UPDATE public.agents SET owner_user_id = u WHERE id = agent_a;
  EXCEPTION WHEN insufficient_privilege THEN denied := true; END;
  IF NOT denied THEN RAISE EXCEPTION 'Runtime can change Agent ownership'; END IF;
  denied := false;
  BEGIN EXECUTE 'CREATE TABLE ledger.unauthorized_test(id integer)';
  EXCEPTION WHEN insufficient_privilege THEN denied := true; END;
  IF NOT denied THEN RAISE EXCEPTION 'Runtime can create objects in trusted schema'; END IF;
  denied := false;
  BEGIN
    INSERT INTO public.idempotency_requests(principal_key, route_key, idempotency_key, request_hash, status, response_body)
      VALUES(prefix, 'sql-test', 'missing-status', decode('aa', 'hex'), 'completed', '{}'::jsonb);
  EXCEPTION WHEN check_violation THEN denied := true; END;
  IF NOT denied THEN RAISE EXCEPTION 'Completed receipt without response status was accepted'; END IF;
  RAISE NOTICE 'Ledger SQL assertions passed (fixtures roll back).';
END;
$$;
ROLLBACK;
