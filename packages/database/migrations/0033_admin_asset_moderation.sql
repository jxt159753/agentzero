-- Moderation changes availability only; ownership, inventory and funded obligations remain intact.
ALTER TABLE public.land_plots
  ADD COLUMN trading_frozen boolean NOT NULL DEFAULT false,
  ADD COLUMN showcase_hidden boolean NOT NULL DEFAULT false;
ALTER TABLE public.item_instances ADD COLUMN trading_frozen boolean NOT NULL DEFAULT false;
ALTER TABLE public.arcade_games ADD COLUMN moderation_blocked boolean NOT NULL DEFAULT false;
