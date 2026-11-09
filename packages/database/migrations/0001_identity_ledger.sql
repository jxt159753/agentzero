REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA ledger AUTHORIZATION agentzero_migrator;
REVOKE ALL ON SCHEMA ledger FROM PUBLIC;
GRANT USAGE ON SCHEMA public, ledger TO agentzero_app;

CREATE TABLE public.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  github_user_id bigint NOT NULL UNIQUE CHECK (github_user_id > 0),
  github_login text NOT NULL,
  display_name text NOT NULL,
  avatar_url text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended')),
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.oauth_login_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_hash bytea NOT NULL UNIQUE,
  browser_binding_hash bytea NOT NULL,
  code_verifier text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oauth_login_states_expiry_idx ON public.oauth_login_states(expires_at);
CREATE TABLE public.user_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id),
  token_hash bytea NOT NULL UNIQUE,
  csrf_token_hash bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_sessions_user_idx ON public.user_sessions(user_id);
CREATE TABLE public.agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES public.users(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agents_owner_idx ON public.agents(owner_user_id);
CREATE TABLE public.agent_policies (
  agent_id uuid PRIMARY KEY REFERENCES public.agents(id),
  can_accept_task boolean NOT NULL DEFAULT false,
  can_collaborate boolean NOT NULL DEFAULT false,
  can_trade boolean NOT NULL DEFAULT false,
  can_redeem_api boolean NOT NULL DEFAULT false,
  single_spend_limit bigint NOT NULL DEFAULT 0 CHECK (single_spend_limit >= 0),
  daily_spend_limit bigint NOT NULL DEFAULT 0 CHECK (daily_spend_limit >= 0),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.agent_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES public.agents(id),
  label text NOT NULL,
  secret_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '90 days'),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_keys_agent_idx ON public.agent_keys(agent_id);
CREATE TABLE public.ledger_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid REFERENCES public.agents(id),
  system_key text UNIQUE,
  bucket text NOT NULL,
  normal_side text NOT NULL,
  balance bigint NOT NULL DEFAULT 0 CHECK (balance >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(agent_id, bucket),
  CHECK ((agent_id IS NOT NULL AND system_key IS NULL AND bucket IN ('AVAILABLE', 'RESERVED') AND normal_side = 'debit')
    OR (agent_id IS NULL AND system_key IS NOT NULL AND bucket = system_key
      AND ((system_key IN ('REWARD_POOL', 'REWARD_RESERVED', 'RECOVERY') AND normal_side = 'debit')
        OR (system_key = 'ISSUANCE_CONTROL' AND normal_side = 'credit'))))
);
CREATE TABLE public.journal_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('ISSUE', 'RESERVE', 'ADJUST_HOLD', 'FINALIZE_HOLD', 'PAY', 'REFUND')),
  business_key text NOT NULL UNIQUE,
  payload_hash bytea NOT NULL,
  actor_type text NOT NULL,
  actor_user_id uuid REFERENCES public.users(id),
  actor_agent_id uuid REFERENCES public.agents(id),
  represented_agent_id uuid REFERENCES public.agents(id),
  credential_id uuid REFERENCES public.agent_keys(id),
  payer_agent_id uuid REFERENCES public.agents(id),
  spend_points bigint NOT NULL DEFAULT 0 CHECK (spend_points >= 0),
  business_date date NOT NULL,
  correction_of uuid REFERENCES public.journal_transactions(id),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((actor_type = 'user' AND actor_user_id IS NOT NULL AND actor_agent_id IS NULL AND credential_id IS NULL)
    OR (actor_type = 'agent' AND actor_user_id IS NULL AND actor_agent_id IS NOT NULL AND credential_id IS NOT NULL)
    OR (actor_type = 'system' AND actor_user_id IS NULL AND actor_agent_id IS NULL AND credential_id IS NULL)),
  CHECK (spend_points = 0 OR payer_agent_id IS NOT NULL)
);
CREATE INDEX journal_payer_date_idx ON public.journal_transactions(payer_agent_id, business_date);
CREATE INDEX journal_created_idx ON public.journal_transactions(created_at, id);
CREATE TABLE public.journal_entries (
  transaction_id uuid NOT NULL REFERENCES public.journal_transactions(id),
  line_no integer NOT NULL CHECK (line_no > 0),
  account_id uuid NOT NULL REFERENCES public.ledger_accounts(id),
  side text NOT NULL CHECK (side IN ('debit', 'credit')),
  amount bigint NOT NULL CHECK (amount > 0),
  PRIMARY KEY(transaction_id, line_no),
  UNIQUE(transaction_id, account_id)
);
CREATE INDEX journal_entries_account_idx ON public.journal_entries(account_id, transaction_id);
CREATE TABLE public.credit_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_ref text NOT NULL UNIQUE,
  payer_agent_id uuid REFERENCES public.agents(id),
  source_account_id uuid NOT NULL REFERENCES public.ledger_accounts(id),
  reserved_account_id uuid NOT NULL REFERENCES public.ledger_accounts(id),
  reserved_total bigint NOT NULL CHECK (reserved_total >= 0),
  captured_total bigint NOT NULL DEFAULT 0 CHECK (captured_total >= 0),
  released_total bigint NOT NULL DEFAULT 0 CHECK (released_total >= 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CHECK (source_account_id <> reserved_account_id),
  CHECK (captured_total::numeric + released_total::numeric <= reserved_total::numeric),
  CHECK ((status = 'open' AND closed_at IS NULL) OR (status = 'closed' AND closed_at IS NOT NULL
    AND captured_total::numeric + released_total::numeric = reserved_total::numeric))
);
CREATE INDEX credit_holds_payer_status_idx ON public.credit_holds(payer_agent_id, status);
CREATE TABLE public.credit_issuance_periods (
  period date PRIMARY KEY CHECK (extract(day FROM period) = 1),
  limit_points bigint NOT NULL DEFAULT 0 CHECK (limit_points >= 0),
  issued_points bigint NOT NULL DEFAULT 0 CHECK (issued_points >= 0 AND issued_points <= limit_points),
  updated_by uuid NOT NULL REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.idempotency_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_key text NOT NULL,
  route_key text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash bytea NOT NULL,
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed')),
  response_status integer,
  response_body jsonb,
  resource_type text,
  resource_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(principal_key, route_key, idempotency_key),
  CHECK (status <> 'completed' OR (response_status BETWEEN 100 AND 599 AND response_body IS NOT NULL))
);
CREATE TABLE public.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type text NOT NULL,
  actor_user_id uuid REFERENCES public.users(id),
  actor_agent_id uuid REFERENCES public.agents(id),
  represented_agent_id uuid REFERENCES public.agents(id),
  credential_id uuid REFERENCES public.agent_keys(id),
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  request_id text NOT NULL,
  business_key text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((actor_type = 'user' AND actor_user_id IS NOT NULL AND actor_agent_id IS NULL AND credential_id IS NULL)
    OR (actor_type = 'agent' AND actor_user_id IS NULL AND actor_agent_id IS NOT NULL AND credential_id IS NOT NULL)
    OR (actor_type = 'system' AND actor_user_id IS NULL AND actor_agent_id IS NULL AND credential_id IS NULL))
);
CREATE INDEX audit_target_idx ON public.audit_events(target_type, target_id, created_at, id);
CREATE INDEX audit_actor_idx ON public.audit_events(actor_user_id, created_at, id);
CREATE INDEX audit_business_idx ON public.audit_events(business_key);

INSERT INTO public.ledger_accounts (system_key, bucket, normal_side) VALUES
  ('REWARD_POOL', 'REWARD_POOL', 'debit'), ('REWARD_RESERVED', 'REWARD_RESERVED', 'debit'),
  ('RECOVERY', 'RECOVERY', 'debit'), ('ISSUANCE_CONTROL', 'ISSUANCE_CONTROL', 'credit');

GRANT SELECT ON ALL TABLES IN SCHEMA public TO agentzero_app;
REVOKE ALL ON public._migrations FROM agentzero_app;
GRANT INSERT, UPDATE ON public.users, public.user_sessions, public.agent_policies, public.credit_issuance_periods, public.idempotency_requests TO agentzero_app;
GRANT INSERT, UPDATE, DELETE ON public.oauth_login_states TO agentzero_app;
GRANT INSERT ON public.agents, public.agent_keys, public.credit_holds, public.audit_events TO agentzero_app;
GRANT UPDATE(name, status, updated_at) ON public.agents TO agentzero_app;
GRANT UPDATE(revoked_at) ON public.agent_keys TO agentzero_app;
GRANT UPDATE(reserved_total, captured_total, released_total, status, version, closed_at) ON public.credit_holds TO agentzero_app;
