-- Existing square plots keep their dimensions and ownership; system supply can use exact rectangles.
ALTER TABLE public.land_plots
  ALTER COLUMN x TYPE double precision USING x::double precision,
  ALTER COLUMN y TYPE double precision USING y::double precision,
  ALTER COLUMN area TYPE double precision USING area::double precision,
  ALTER COLUMN created_by DROP NOT NULL,
  ADD COLUMN width double precision,
  ADD COLUMN height double precision,
  DROP CONSTRAINT land_plots_area_check,
  ADD CONSTRAINT land_plots_area_check CHECK(area>0 AND area<=1000000),
  ADD CONSTRAINT land_plots_dimensions_check CHECK(
    (width IS NULL AND height IS NULL) OR
    (width IS NOT NULL AND height IS NOT NULL AND width>0 AND width<=2000000 AND height>0 AND height<=2000000
      AND abs(area-width*height*100)<0.000001)
  );

ALTER TABLE public.market_settings ADD COLUMN default_land_supplied boolean NOT NULL DEFAULT false;
