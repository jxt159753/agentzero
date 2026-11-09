CREATE TABLE public.reward_pools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  month date NOT NULL UNIQUE CHECK(extract(day FROM month)=1),
  total_quantity bigint NOT NULL DEFAULT 0 CHECK(total_quantity>=0),
  allocated_quantity bigint NOT NULL DEFAULT 0 CHECK(allocated_quantity>=0 AND allocated_quantity<=total_quantity),
  user_monthly_limit bigint NOT NULL DEFAULT 0 CHECK(user_monthly_limit>=0 AND user_monthly_limit<=total_quantity),
  contact_qq text NOT NULL CHECK(contact_qq ~ '^[1-9][0-9]{4,19}$'),
  instructions text NOT NULL CHECK(length(btrim(instructions)) BETWEEN 1 AND 2000),
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused')),
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  created_by uuid NOT NULL REFERENCES public.users(id),
  updated_by uuid NOT NULL REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.reward_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id uuid NOT NULL REFERENCES public.reward_pools(id),
  title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 80),
  description text NOT NULL CHECK(length(btrim(description)) BETWEEN 1 AND 2000),
  points_cost bigint NOT NULL CHECK(points_cost>0),
  total_quantity bigint NOT NULL DEFAULT 0 CHECK(total_quantity>=0),
  redeemed_quantity bigint NOT NULL DEFAULT 0 CHECK(redeemed_quantity>=0 AND redeemed_quantity<=total_quantity),
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused')),
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  created_by uuid NOT NULL REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(id,pool_id)
);
CREATE INDEX reward_offers_pool_idx ON public.reward_offers(pool_id,created_at,id);
CREATE TABLE public.reward_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_code text NOT NULL UNIQUE CHECK(claim_code ~ '^RWD-[A-F0-9]{32}$'),
  user_id uuid NOT NULL REFERENCES public.users(id),
  agent_id uuid NOT NULL REFERENCES public.agents(id),
  pool_id uuid NOT NULL REFERENCES public.reward_pools(id),
  offer_id uuid NOT NULL,
  title text NOT NULL,
  description text NOT NULL,
  points_cost bigint NOT NULL CHECK(points_cost>0),
  contact_qq text NOT NULL CHECK(contact_qq ~ '^[1-9][0-9]{4,19}$'),
  instructions text NOT NULL,
  claimant_qq text NOT NULL CHECK(claimant_qq ~ '^[1-9][0-9]{4,19}$'),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','fulfilled','cancelled')),
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  payment_transaction_id uuid NOT NULL UNIQUE REFERENCES public.journal_transactions(id),
  refund_transaction_id uuid UNIQUE REFERENCES public.journal_transactions(id),
  fulfillment_reference text CHECK(length(btrim(fulfillment_reference)) BETWEEN 1 AND 500),
  admin_note text CHECK(length(btrim(admin_note)) BETWEEN 1 AND 500),
  processed_by uuid REFERENCES public.users(id),
  fulfilled_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(offer_id,pool_id) REFERENCES public.reward_offers(id,pool_id),
  CHECK((status IN ('pending','processing') AND refund_transaction_id IS NULL AND fulfillment_reference IS NULL AND fulfilled_at IS NULL AND cancelled_at IS NULL)
    OR (status='fulfilled' AND refund_transaction_id IS NULL AND fulfillment_reference IS NOT NULL AND fulfilled_at IS NOT NULL AND cancelled_at IS NULL)
    OR (status='cancelled' AND refund_transaction_id IS NOT NULL AND fulfillment_reference IS NULL AND fulfilled_at IS NULL AND cancelled_at IS NOT NULL)),
  CHECK(status NOT IN ('processing','fulfilled') OR processed_by IS NOT NULL)
);
CREATE INDEX reward_redemptions_user_pool_idx ON public.reward_redemptions(user_id,pool_id);
CREATE INDEX reward_redemptions_user_page_idx ON public.reward_redemptions(user_id,created_at,id);
CREATE INDEX reward_redemptions_agent_page_idx ON public.reward_redemptions(agent_id,created_at,id);
CREATE INDEX reward_redemptions_status_page_idx ON public.reward_redemptions(status,created_at,id);

GRANT SELECT,INSERT,UPDATE ON public.reward_pools,public.reward_offers,public.reward_redemptions TO agentzero_app;
