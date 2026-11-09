-- The user owns land; the existing Agent remains its purchasing and managing representative.
ALTER TABLE public.agents
  ADD CONSTRAINT agents_id_owner_user_id_key UNIQUE(id,owner_user_id);

ALTER TABLE public.land_plots
  ADD COLUMN owner_user_id uuid REFERENCES public.users(id);

UPDATE public.land_plots AS land
SET owner_user_id=agent.owner_user_id
FROM public.agents AS agent
WHERE land.owner_agent_id=agent.id;

ALTER TABLE public.land_plots
  ADD CONSTRAINT land_plots_ownership_check CHECK((owner_user_id IS NULL)=(owner_agent_id IS NULL)),
  ADD CONSTRAINT land_plots_owner_agent_user_fkey
    FOREIGN KEY(owner_agent_id,owner_user_id) REFERENCES public.agents(id,owner_user_id);

CREATE INDEX land_plots_owner_user_idx ON public.land_plots(owner_user_id);
