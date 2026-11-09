ALTER TABLE public.world_model_placements DROP CONSTRAINT world_model_placements_model_id_check;
ALTER TABLE public.world_model_placements ADD CONSTRAINT world_model_placements_model_id_check
  CHECK (model_id IN ('studio','tree','lamp','bench','fountain','plant','bookshelf','cabin','shed','tent','fence','rock','flowerbox','pine','picnic','chair','barrel','crate','signpost','well','arcade'));
ALTER TABLE public.world_model_placements ADD COLUMN room_id uuid;
ALTER TABLE public.world_model_placements ADD CONSTRAINT world_model_placements_id_land_unique UNIQUE(id,land_id);
ALTER TABLE public.world_model_placements ADD CONSTRAINT world_model_placements_room_fk
  FOREIGN KEY(room_id,land_id) REFERENCES public.world_model_placements(id,land_id) ON DELETE CASCADE;
ALTER TABLE public.world_model_placements ADD CONSTRAINT world_model_placements_room_check
  CHECK (room_id IS NULL OR (room_id<>id AND model_id NOT IN ('studio','cabin','shed')));
CREATE INDEX world_model_placements_room_idx ON public.world_model_placements(room_id);

ALTER TABLE public.world_positions ADD COLUMN room_id uuid REFERENCES public.world_model_placements(id) ON DELETE SET NULL;
CREATE INDEX world_positions_room_idx ON public.world_positions(room_id);

-- Return occupants outside when a house is removed, including a land sale.
CREATE FUNCTION public.leave_removed_world_room() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.world_positions p SET room_id=NULL,x=l.x+OLD.x,y=l.y+OLD.y+1,
    updated_at=clock_timestamp()
  FROM public.land_plots l WHERE p.room_id=OLD.id AND l.id=OLD.land_id;
  RETURN OLD;
END;
$$;
CREATE TRIGGER world_room_removal BEFORE DELETE ON public.world_model_placements
  FOR EACH ROW WHEN (OLD.model_id IN ('studio','cabin','shed')) EXECUTE FUNCTION public.leave_removed_world_room();
