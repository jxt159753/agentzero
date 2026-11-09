ALTER TABLE public.agents
  ADD COLUMN version bigint NOT NULL DEFAULT 1 CHECK(version > 0),
  ADD COLUMN deleted_at timestamptz,
  ADD CONSTRAINT agents_deleted_paused CHECK(deleted_at IS NULL OR status = 'paused');
