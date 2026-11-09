CREATE TABLE public.github_installations (
  installation_id text PRIMARY KEY CHECK (installation_id ~ '^[1-9][0-9]*$'),
  account_login text NOT NULL,
  status text NOT NULL CHECK (status IN ('active','suspended','deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.repositories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  github_id text NOT NULL UNIQUE CHECK (github_id ~ '^[1-9][0-9]*$'),
  installation_id text NOT NULL REFERENCES public.github_installations(installation_id),
  owner text NOT NULL,
  name text NOT NULL,
  full_name text NOT NULL,
  is_private boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'approved' CHECK (status IN ('approved','disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT is_private OR status = 'disabled')
);
CREATE INDEX repositories_installation_idx ON public.repositories(installation_id);
CREATE TABLE public.github_deliveries (
  delivery_id text PRIMARY KEY,
  event_name text NOT NULL,
  payload_hash bytea NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processed')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX github_deliveries_pending_idx ON public.github_deliveries(next_attempt_at) WHERE status='pending';
GRANT SELECT, INSERT, UPDATE ON public.github_installations, public.repositories, public.github_deliveries TO agentzero_app;
