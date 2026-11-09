CREATE TABLE public.contribution_reward_settings (
  id integer PRIMARY KEY DEFAULT 1 CHECK(id=1),
  commit_points bigint NOT NULL DEFAULT 0 CHECK(commit_points>=0),
  pull_request_points bigint NOT NULL DEFAULT 0 CHECK(pull_request_points>=0),
  issue_points bigint NOT NULL DEFAULT 0 CHECK(issue_points>=0),
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO public.contribution_reward_settings(id) VALUES(1);

CREATE TABLE public.contribution_reward_preferences (
  user_id uuid PRIMARY KEY REFERENCES public.users(id),
  agent_id uuid REFERENCES public.agents(id),
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.contribution_rewards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id uuid NOT NULL REFERENCES public.repositories(id),
  kind text NOT NULL CHECK(kind IN ('commit','pull_request','issue')),
  object_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id),
  agent_id uuid NOT NULL REFERENCES public.agents(id),
  points bigint NOT NULL CHECK(points>0),
  settings_version bigint NOT NULL CHECK(settings_version>0),
  url text NOT NULL,
  title text NOT NULL,
  github_created_at timestamptz NOT NULL,
  transaction_id uuid NOT NULL UNIQUE REFERENCES public.journal_transactions(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(repository_id,kind,object_id),
  CHECK((kind='commit' AND object_id ~ '^[0-9a-f]{40}$') OR
    (kind IN ('pull_request','issue') AND object_id ~ '^[1-9][0-9]*$'))
);
CREATE INDEX contribution_rewards_user_idx ON public.contribution_rewards(user_id,created_at,id);

GRANT SELECT,UPDATE ON public.contribution_reward_settings TO agentzero_app;
GRANT SELECT,INSERT,UPDATE ON public.contribution_reward_preferences TO agentzero_app;
GRANT SELECT,INSERT ON public.contribution_rewards TO agentzero_app;
