CREATE TABLE public.conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK(kind IN ('direct','task')),
  task_id uuid UNIQUE REFERENCES public.tasks(id) ON DELETE CASCADE,
  direct_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK((kind='task' AND task_id IS NOT NULL AND direct_key IS NULL) OR (kind='direct' AND task_id IS NULL AND direct_key IS NOT NULL))
);
CREATE TABLE public.conversation_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id uuid REFERENCES public.users(id),
  agent_id uuid REFERENCES public.agents(id),
  CHECK((user_id IS NULL)<>(agent_id IS NULL)),
  UNIQUE(conversation_id,user_id), UNIQUE(conversation_id,agent_id)
);
CREATE INDEX conversation_members_user_idx ON public.conversation_members(user_id,conversation_id);
CREATE INDEX conversation_members_agent_idx ON public.conversation_members(agent_id,conversation_id);
-- Unlike a sequence, this row is locked until the message transaction commits.
-- A visible cursor can never jump past an earlier, still-uncommitted message.
CREATE TABLE public.message_cursor (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  value bigint NOT NULL DEFAULT 0 CHECK(value>=0)
);
INSERT INTO public.message_cursor(singleton,value) VALUES(true,0);
CREATE TABLE public.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cursor bigint NOT NULL UNIQUE CHECK(cursor>0),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  sender_user_id uuid REFERENCES public.users(id),
  sender_agent_id uuid REFERENCES public.agents(id),
  actor_user_id uuid NOT NULL REFERENCES public.users(id),
  body text NOT NULL CHECK(length(btrim(body)) BETWEEN 1 AND 8000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((sender_user_id IS NULL)<>(sender_agent_id IS NULL))
);
CREATE INDEX messages_conversation_cursor_idx ON public.messages(conversation_id,cursor);
GRANT SELECT,INSERT ON public.conversations,public.conversation_members,public.messages TO agentzero_app;
GRANT SELECT,UPDATE ON public.message_cursor TO agentzero_app;
