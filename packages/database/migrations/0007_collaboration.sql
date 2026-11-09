CREATE TABLE public.collaboration_agreements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.tasks(id),
  version bigint NOT NULL CHECK(version>0),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','superseded','rejected')),
  deadline_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  rejection_reason text CHECK(length(btrim(rejection_reason)) BETWEEN 1 AND 500),
  UNIQUE(task_id,version)
);
CREATE UNIQUE INDEX collaboration_active_idx ON public.collaboration_agreements(task_id) WHERE status='active';
CREATE UNIQUE INDEX collaboration_pending_idx ON public.collaboration_agreements(task_id) WHERE status='pending';
CREATE TABLE public.agreement_members (
  agreement_id uuid NOT NULL REFERENCES public.collaboration_agreements(id),
  agent_id uuid NOT NULL REFERENCES public.agents(id),
  role text NOT NULL CHECK(length(btrim(role)) BETWEEN 1 AND 80),
  deliverable text NOT NULL CHECK(length(btrim(deliverable)) BETWEEN 1 AND 2000),
  amount_points bigint NOT NULL CHECK(amount_points>=0),
  PRIMARY KEY(agreement_id,agent_id)
);
CREATE INDEX agreement_members_agent_idx ON public.agreement_members(agent_id,agreement_id);
CREATE TABLE public.agreement_confirmations (
  agreement_id uuid NOT NULL REFERENCES public.collaboration_agreements(id),
  subject_key text NOT NULL,
  agent_id uuid REFERENCES public.agents(id),
  user_id uuid NOT NULL REFERENCES public.users(id),
  accepted_at timestamptz,
  actor_type text CHECK(actor_type IN ('user','agent')),
  actor_user_id uuid REFERENCES public.users(id),
  actor_agent_id uuid REFERENCES public.agents(id),
  PRIMARY KEY(agreement_id,subject_key),
  CHECK(subject_key='publisher' OR subject_key='agent:'||agent_id::text)
);
CREATE TABLE public.task_contributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.tasks(id),
  agreement_id uuid REFERENCES public.collaboration_agreements(id),
  agent_id uuid NOT NULL REFERENCES public.agents(id),
  kind text NOT NULL CHECK(kind IN ('pr','test','note')),
  body text NOT NULL CHECK(length(btrim(body)) BETWEEN 1 AND 8000),
  url text CHECK(url ~ '^https://' AND length(url)<=2000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_contributions_task_idx ON public.task_contributions(task_id,created_at,id);
ALTER TABLE public.task_cancellation_proposals ADD COLUMN payments jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(payments)='array');
ALTER TABLE public.task_cancellation_proposals ADD COLUMN confirmations jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(confirmations)='array');
-- Preserve existing single-Agent cancellation agreements, including pending ones.
UPDATE public.task_cancellation_proposals p SET payments=jsonb_build_array(jsonb_build_object('agent_id',t.assignee_agent_id,'amount_points',p.payment_points::text)),
  confirmations=jsonb_build_array(
    jsonb_build_object('subject_key','publisher','agent_id',t.publisher_agent_id,'user_id',t.publisher_user_id,'accepted_at',CASE WHEN p.publisher_accepted THEN p.created_at ELSE NULL END),
    jsonb_build_object('subject_key','agent:'||a.id::text,'agent_id',a.id,'user_id',a.owner_user_id,'accepted_at',CASE WHEN p.assignee_accepted THEN p.created_at ELSE NULL END))
  FROM public.tasks t JOIN public.agents a ON a.id=t.assignee_agent_id WHERE p.task_id=t.id;
GRANT SELECT,INSERT,UPDATE ON public.collaboration_agreements,public.agreement_confirmations TO agentzero_app;
GRANT SELECT,INSERT ON public.agreement_members,public.task_contributions TO agentzero_app;
