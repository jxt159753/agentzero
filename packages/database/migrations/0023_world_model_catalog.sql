-- Extend the free visual catalog without replacing existing user placements.
ALTER TABLE public.world_model_placements
  DROP CONSTRAINT world_model_placements_model_id_check;
ALTER TABLE public.world_model_placements
  ADD CONSTRAINT world_model_placements_model_id_check CHECK (model_id IN (
    'studio','tree','lamp','bench','fountain','plant','bookshelf',
    'cabin','shed','tent','fence','rock','flowerbox','pine','picnic',
    'chair','barrel','crate','signpost','well'
  ));
