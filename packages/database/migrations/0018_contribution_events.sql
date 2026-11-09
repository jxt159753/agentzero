CREATE TABLE public.contribution_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id uuid NOT NULL REFERENCES public.repositories(id),
  installation_id text NOT NULL REFERENCES public.github_installations(installation_id),
  delivery_id text NOT NULL REFERENCES public.github_deliveries(delivery_id),
  kind text NOT NULL CHECK (kind IN ('commit','pull_request','issue')),
  object_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processed','skipped')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_id uuid,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  processed_at timestamptz,
  UNIQUE (repository_id,kind,object_id),
  CHECK ((kind='commit' AND object_id ~ '^[0-9a-f]{40}$') OR (kind IN ('pull_request','issue') AND object_id ~ '^[1-9][0-9]*$'))
);
CREATE INDEX contribution_events_pending_idx ON public.contribution_events(next_attempt_at,id) WHERE status='pending';
GRANT SELECT,INSERT,UPDATE ON public.contribution_events TO agentzero_app;
