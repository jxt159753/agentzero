CREATE TABLE public.market_settings (
  id integer PRIMARY KEY DEFAULT 1 CHECK(id=1),
  user_land_limit integer NOT NULL DEFAULT 3 CHECK(user_land_limit BETWEEN 0 AND 1000),
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO public.market_settings(id) VALUES(1);

CREATE TABLE public.land_plots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK(code ~ '^[A-Za-z0-9_-]{1,40}$'),
  x integer NOT NULL CHECK(x BETWEEN -1000000 AND 1000000),
  y integer NOT NULL CHECK(y BETWEEN -1000000 AND 1000000),
  area integer NOT NULL CHECK(area BETWEEN 1 AND 1000000),
  points_price bigint NOT NULL CHECK(points_price>0),
  building_template text NOT NULL DEFAULT 'studio' CHECK(building_template='studio'),
  owner_agent_id uuid REFERENCES public.agents(id),
  name text NOT NULL DEFAULT '默认工作室' CHECK(length(btrim(name)) BETWEEN 1 AND 80),
  works_url text CHECK(works_url ~ '^https://' AND length(works_url)<=2000),
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  created_by uuid NOT NULL REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(x,y), UNIQUE(id,owner_agent_id)
);
CREATE INDEX land_plots_owner_idx ON public.land_plots(owner_agent_id);

CREATE TABLE public.item_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 80),
  description text NOT NULL CHECK(length(btrim(description)) BETWEEN 1 AND 2000),
  appearance text NOT NULL CHECK(appearance IN ('plant','lamp','bookshelf','banner')),
  points_price bigint NOT NULL CHECK(points_price>0),
  total_quantity bigint NOT NULL DEFAULT 0 CHECK(total_quantity>=0),
  issued_quantity bigint NOT NULL DEFAULT 0 CHECK(issued_quantity>=0 AND issued_quantity<=total_quantity),
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused')),
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  created_by uuid NOT NULL REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.item_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES public.item_templates(id),
  owner_agent_id uuid NOT NULL REFERENCES public.agents(id),
  land_id uuid,
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(land_id,owner_agent_id) REFERENCES public.land_plots(id,owner_agent_id)
);
CREATE INDEX item_instances_owner_idx ON public.item_instances(owner_agent_id);
CREATE INDEX item_instances_land_idx ON public.item_instances(land_id);

CREATE TABLE public.market_listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_agent_id uuid NOT NULL REFERENCES public.agents(id),
  land_id uuid REFERENCES public.land_plots(id),
  item_id uuid REFERENCES public.item_instances(id),
  points_price bigint NOT NULL CHECK(points_price>0),
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','sold','cancelled')),
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  closed_at timestamptz,
  CHECK(num_nonnulls(land_id,item_id)=1),
  CHECK((status='active')=(closed_at IS NULL))
);
CREATE UNIQUE INDEX market_listings_active_land_idx ON public.market_listings(land_id) WHERE status='active';
CREATE UNIQUE INDEX market_listings_active_item_idx ON public.market_listings(item_id) WHERE status='active';
CREATE INDEX market_listings_seller_idx ON public.market_listings(seller_agent_id,created_at,id);

CREATE TABLE public.market_trades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid UNIQUE REFERENCES public.market_listings(id),
  land_id uuid REFERENCES public.land_plots(id),
  item_id uuid REFERENCES public.item_instances(id),
  buyer_agent_id uuid NOT NULL REFERENCES public.agents(id),
  seller_agent_id uuid REFERENCES public.agents(id),
  points_price bigint NOT NULL CHECK(points_price>0),
  transaction_id uuid NOT NULL UNIQUE REFERENCES public.journal_transactions(id),
  asset_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(num_nonnulls(land_id,item_id)=1),
  CHECK((listing_id IS NULL)=(seller_agent_id IS NULL)),
  CHECK(buyer_agent_id IS DISTINCT FROM seller_agent_id)
);
CREATE UNIQUE INDEX market_trades_initial_land_idx ON public.market_trades(land_id) WHERE listing_id IS NULL AND land_id IS NOT NULL;
CREATE UNIQUE INDEX market_trades_initial_item_idx ON public.market_trades(item_id) WHERE listing_id IS NULL AND item_id IS NOT NULL;
CREATE INDEX market_trades_buyer_idx ON public.market_trades(buyer_agent_id,created_at,id);
CREATE INDEX market_trades_seller_idx ON public.market_trades(seller_agent_id,created_at,id);

GRANT SELECT,UPDATE ON public.market_settings TO agentzero_app;
GRANT SELECT,INSERT,UPDATE ON public.land_plots,public.item_templates,public.item_instances,public.market_listings TO agentzero_app;
GRANT SELECT,INSERT ON public.market_trades TO agentzero_app;
