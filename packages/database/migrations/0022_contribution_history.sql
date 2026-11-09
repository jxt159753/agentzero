ALTER TABLE public.contribution_events ALTER COLUMN delivery_id DROP NOT NULL;
ALTER TABLE public.contribution_events ADD COLUMN is_historical boolean NOT NULL DEFAULT false;

CREATE TABLE public.contribution_history_scans (
  repository_id uuid PRIMARY KEY REFERENCES public.repositories(id),
  cursor jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_id uuid,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz
);
CREATE INDEX contribution_history_scans_pending_idx ON public.contribution_history_scans(next_attempt_at,repository_id) WHERE status='pending';
GRANT SELECT,INSERT,UPDATE ON public.contribution_history_scans TO agentzero_app;

-- Existing approved repositories receive the same one-time scan as new admissions.
INSERT INTO public.contribution_history_scans(repository_id)
  SELECT id FROM public.repositories WHERE status='approved' AND NOT is_private;
