-- Positions survive disconnects; online status is a short, authenticated lease.
CREATE TABLE public.world_positions (
  kind text NOT NULL CHECK(kind IN ('visitor','agent')),
  subject_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id),
  agent_id uuid REFERENCES public.agents(id),
  session_id uuid REFERENCES public.user_sessions(id),
  credential_id uuid REFERENCES public.agent_keys(id),
  x integer NOT NULL DEFAULT 0 CHECK(x BETWEEN -1000000 AND 1000000),
  y integer NOT NULL DEFAULT 0 CHECK(y BETWEEN -1000000 AND 1000000),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(kind,subject_id),
  CHECK((kind='visitor' AND subject_id=user_id AND agent_id IS NULL AND session_id IS NOT NULL AND credential_id IS NULL)
    OR (kind='agent' AND subject_id=agent_id AND agent_id IS NOT NULL AND session_id IS NULL AND credential_id IS NOT NULL))
);

-- Public task evidence is opt-in by the owning human, not by an Agent credential.
CREATE TABLE public.world_publications (
  agent_id uuid NOT NULL REFERENCES public.agents(id),
  task_id uuid NOT NULL REFERENCES public.tasks(id),
  summary text NOT NULL CHECK(length(btrim(summary)) BETWEEN 1 AND 500),
  published_by uuid NOT NULL REFERENCES public.users(id),
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(agent_id,task_id)
);
CREATE INDEX world_publications_task_idx ON public.world_publications(task_id);
GRANT SELECT,INSERT,UPDATE ON public.world_positions TO agentzero_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.world_publications TO agentzero_app;
