CREATE TABLE public.arcade_games (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_agent_id uuid NOT NULL REFERENCES public.agents(id),
  owner_user_id uuid NOT NULL REFERENCES public.users(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  description text NOT NULL CHECK (length(description)<=1000),
  entry_fee bigint NOT NULL CHECK (entry_fee>0),
  max_reward bigint NOT NULL CHECK (max_reward>0),
  minimum_pool bigint NOT NULL CHECK (minimum_pool>=max_reward),
  source jsonb NOT NULL CHECK (source->>'type' IN ('url','bundle')),
  status text NOT NULL DEFAULT 'paused' CHECK (status IN ('active','paused')),
  version bigint NOT NULL DEFAULT 1 CHECK (version>0),
  pool_hold_id uuid REFERENCES public.credit_holds(id),
  pool_balance bigint NOT NULL DEFAULT 0 CHECK (pool_balance>=0),
  pool_committed bigint NOT NULL DEFAULT 0 CHECK (pool_committed>=0 AND pool_committed<=pool_balance),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX arcade_games_owner_idx ON public.arcade_games(owner_user_id,created_at);
CREATE TABLE public.arcade_game_machines (
  placement_id uuid PRIMARY KEY REFERENCES public.world_model_placements(id) ON DELETE CASCADE,
  game_id uuid NOT NULL REFERENCES public.arcade_games(id)
);
CREATE TABLE public.arcade_game_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES public.arcade_games(id),
  player_agent_id uuid NOT NULL REFERENCES public.agents(id),
  player_user_id uuid NOT NULL REFERENCES public.users(id),
  fee_hold_id uuid NOT NULL UNIQUE REFERENCES public.credit_holds(id),
  game_version bigint NOT NULL CHECK (game_version>0),
  entry_fee bigint NOT NULL CHECK (entry_fee>0),
  max_reward bigint NOT NULL CHECK (max_reward>0),
  status text NOT NULL DEFAULT 'playing' CHECK (status IN ('playing','submitted','settled','refunded')),
  score bigint CHECK (score>=0), reward_requested bigint CHECK (reward_requested>=0 AND reward_requested<=max_reward),
  reward_points bigint CHECK (reward_points>=0 AND reward_points<=max_reward),
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp()+interval '30 minutes'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at timestamptz,
  CHECK ((status IN ('settled','refunded'))=(settled_at IS NOT NULL))
);
CREATE INDEX arcade_sessions_player_idx ON public.arcade_game_sessions(player_user_id,created_at);
CREATE INDEX arcade_sessions_game_idx ON public.arcade_game_sessions(game_id,created_at);
CREATE INDEX arcade_sessions_expiry_idx ON public.arcade_game_sessions(expires_at) WHERE status IN ('playing','submitted');
GRANT SELECT,INSERT,UPDATE,DELETE ON public.arcade_games,public.arcade_game_machines,public.arcade_game_sessions TO agentzero_app;
