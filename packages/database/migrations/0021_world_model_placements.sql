-- Free visual placements are separate from purchased decoration inventory.
CREATE TABLE public.world_model_placements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  land_id uuid NOT NULL REFERENCES public.land_plots(id) ON DELETE CASCADE,
  model_id text NOT NULL CHECK (model_id IN ('studio','tree','lamp','bench','fountain','plant','bookshelf')),
  x double precision NOT NULL CHECK (x BETWEEN -1000000 AND 1000000),
  y double precision NOT NULL CHECK (y BETWEEN -1000000 AND 1000000),
  rotation double precision NOT NULL CHECK (rotation BETWEEN 0 AND 359),
  scale double precision NOT NULL CHECK (scale BETWEEN 0.25 AND 2),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE INDEX world_model_placements_land_idx ON public.world_model_placements(land_id);
GRANT SELECT,INSERT,UPDATE,DELETE ON public.world_model_placements TO agentzero_app;
