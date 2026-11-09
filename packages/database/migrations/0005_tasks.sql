CREATE TABLE public.tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 80),
  description text NOT NULL CHECK(length(btrim(description)) BETWEEN 1 AND 8000),
  repository_id uuid NOT NULL REFERENCES public.repositories(id),
  issue_number integer CHECK(issue_number>0),
  acceptance_criteria text NOT NULL CHECK(length(btrim(acceptance_criteria)) BETWEEN 1 AND 8000),
  required_checks jsonb NOT NULL CHECK(jsonb_typeof(required_checks)='array'),
  reward_points bigint NOT NULL CHECK(reward_points>0),
  deadline_at timestamptz NOT NULL,
  publisher_user_id uuid NOT NULL REFERENCES public.users(id),
  publisher_agent_id uuid REFERENCES public.agents(id),
  payer_agent_id uuid REFERENCES public.agents(id),
  reviewer_user_id uuid NOT NULL REFERENCES public.users(id),
  assignee_agent_id uuid REFERENCES public.agents(id),
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','open','in_progress','submitted','changes_requested','settled','cancelled')),
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  hold_id uuid UNIQUE REFERENCES public.credit_holds(id),
  latest_delivery_id uuid,
  disputed boolean NOT NULL DEFAULT false,
  dispute_reason text,
  review_due_at timestamptz,
  review_reminded_at timestamptz,
  settled_journal_id uuid UNIQUE REFERENCES public.journal_transactions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  accepted_at timestamptz,
  finalized_at timestamptz,
  CHECK(payer_agent_id IS NULL OR payer_agent_id IS DISTINCT FROM assignee_agent_id),
  CHECK(status='draft' OR hold_id IS NOT NULL),
  CHECK(status NOT IN ('in_progress','submitted','changes_requested','settled') OR assignee_agent_id IS NOT NULL),
  CHECK((status IN ('settled','cancelled'))=(finalized_at IS NOT NULL)),
  CHECK(status NOT IN ('settled','cancelled') OR (settled_journal_id IS NOT NULL AND NOT disputed))
);
CREATE INDEX tasks_list_idx ON public.tasks(created_at DESC,id DESC);
CREATE INDEX tasks_publisher_idx ON public.tasks(publisher_user_id,status);
CREATE INDEX tasks_assignee_idx ON public.tasks(assignee_agent_id,status);
CREATE INDEX tasks_reviewer_idx ON public.tasks(reviewer_user_id,status);
CREATE INDEX tasks_deadline_idx ON public.tasks(deadline_at) WHERE status IN ('in_progress','changes_requested') AND NOT disputed;
CREATE INDEX tasks_review_due_idx ON public.tasks(review_due_at) WHERE status='submitted' AND review_reminded_at IS NULL;

CREATE TABLE public.task_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.tasks(id),
  agent_id uuid NOT NULL REFERENCES public.agents(id),
  pr_number integer NOT NULL CHECK(pr_number>0),
  head_sha text NOT NULL CHECK(head_sha ~ '^[0-9a-f]{40}$'),
  pr_url text NOT NULL,
  evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(task_id,id)
);
ALTER TABLE public.tasks ADD CONSTRAINT tasks_latest_delivery_fkey FOREIGN KEY(id,latest_delivery_id) REFERENCES public.task_deliveries(task_id,id);
CREATE INDEX task_deliveries_task_idx ON public.task_deliveries(task_id,created_at);

CREATE TABLE public.task_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.tasks(id),
  delivery_id uuid,
  reviewer_user_id uuid NOT NULL REFERENCES public.users(id),
  decision text NOT NULL CHECK(decision IN ('accept','request_changes','resolve_settled','resolve_cancelled')),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
  unmet_criteria text,
  evidence jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(task_id,delivery_id) REFERENCES public.task_deliveries(task_id,id),
  CHECK(decision<>'request_changes' OR length(btrim(unmet_criteria))>0)
);
CREATE INDEX task_reviews_task_idx ON public.task_reviews(task_id,created_at);

CREATE TABLE public.rewarded_pull_requests (
  repository_id uuid NOT NULL REFERENCES public.repositories(id),
  pr_number integer NOT NULL CHECK(pr_number>0),
  task_id uuid NOT NULL UNIQUE REFERENCES public.tasks(id),
  journal_id uuid NOT NULL UNIQUE REFERENCES public.journal_transactions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(repository_id,pr_number)
);

CREATE TABLE public.task_cancellation_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.tasks(id),
  payment_points bigint NOT NULL CHECK(payment_points>=0),
  refund_points bigint NOT NULL CHECK(refund_points>=0),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','superseded')),
  publisher_accepted boolean NOT NULL DEFAULT false,
  assignee_accepted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  CHECK(status<>'accepted' OR (publisher_accepted AND assignee_accepted AND accepted_at IS NOT NULL))
);
CREATE UNIQUE INDEX task_cancellation_pending_idx ON public.task_cancellation_proposals(task_id) WHERE status='pending';
CREATE INDEX task_cancellation_task_idx ON public.task_cancellation_proposals(task_id,created_at);

CREATE TABLE public.task_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  kind text NOT NULL,
  actor_type text NOT NULL CHECK(actor_type IN ('user','agent','system')),
  actor_user_id uuid REFERENCES public.users(id),
  actor_agent_id uuid REFERENCES public.agents(id),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_events_task_idx ON public.task_events(task_id,created_at,id);

GRANT SELECT,INSERT,UPDATE,DELETE ON public.tasks TO agentzero_app;
GRANT SELECT,INSERT ON public.task_deliveries,public.task_reviews,public.rewarded_pull_requests,public.task_events TO agentzero_app;
GRANT SELECT,INSERT,UPDATE ON public.task_cancellation_proposals TO agentzero_app;
