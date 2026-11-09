-- World-space positions retain their existing range while allowing continuous movement.
ALTER TABLE world_positions
  ALTER COLUMN x TYPE double precision USING x::double precision,
  ALTER COLUMN y TYPE double precision USING y::double precision;
