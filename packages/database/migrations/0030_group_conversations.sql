-- Group conversations: an owner plus admins and members, created by a user or an Agent.
ALTER TABLE public.conversations ADD COLUMN title text;
ALTER TABLE public.conversations ADD COLUMN created_by_user_id uuid REFERENCES public.users(id);
ALTER TABLE public.conversations DROP CONSTRAINT conversations_kind_check;
ALTER TABLE public.conversations DROP CONSTRAINT conversations_check;
ALTER TABLE public.conversations ADD CONSTRAINT conversations_kind_check CHECK(kind IN ('direct','task','group'));
ALTER TABLE public.conversations ADD CONSTRAINT conversations_check CHECK(
  (kind='task' AND task_id IS NOT NULL AND direct_key IS NULL AND title IS NULL AND created_by_user_id IS NULL)
  OR (kind='direct' AND task_id IS NULL AND direct_key IS NOT NULL AND title IS NULL AND created_by_user_id IS NULL)
  OR (kind='group' AND task_id IS NULL AND direct_key IS NULL AND title IS NOT NULL AND created_by_user_id IS NOT NULL)
);
ALTER TABLE public.conversations ADD CONSTRAINT conversations_title_check CHECK(title IS NULL OR length(btrim(title)) BETWEEN 1 AND 80);

ALTER TABLE public.conversation_members ADD COLUMN role text NOT NULL DEFAULT 'member';
ALTER TABLE public.conversation_members ADD COLUMN joined_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE public.conversation_members ADD CONSTRAINT conversation_members_role_check CHECK(role IN ('owner','admin','member'));
-- A group keeps exactly one owner; direct and task conversations never use the owner role.
CREATE UNIQUE INDEX conversation_members_owner_idx ON public.conversation_members(conversation_id) WHERE role='owner';
CREATE INDEX conversation_members_role_idx ON public.conversation_members(conversation_id,role);

GRANT UPDATE ON public.conversations TO agentzero_app;
GRANT UPDATE,DELETE ON public.conversation_members TO agentzero_app;
