-- Public display items travel with the existing versioned studio configuration.
ALTER TABLE public.land_plots ADD COLUMN showcase jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(showcase)='array' AND jsonb_array_length(showcase)<=8);
