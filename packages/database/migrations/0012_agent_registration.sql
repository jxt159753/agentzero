-- The client keeps the credential and browser verification code; only hashes reach storage.
CREATE TABLE public.agent_registrations (
  id uuid PRIMARY KEY,
  client text NOT NULL CHECK(client IN ('codex','dsh')),
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 80),
  credential_hash bytea NOT NULL CHECK(octet_length(credential_hash)=32),
  verification_hash bytea NOT NULL CHECK(octet_length(verification_hash)=32),
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp()+interval '10 minutes'),
  owner_user_id uuid REFERENCES public.users(id),
  agent_id uuid REFERENCES public.agents(id),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((approved_at IS NULL AND owner_user_id IS NULL AND agent_id IS NULL)
    OR (approved_at IS NOT NULL AND owner_user_id IS NOT NULL AND agent_id IS NOT NULL))
);
CREATE INDEX agent_registrations_pending_expiry_idx ON public.agent_registrations(expires_at) WHERE approved_at IS NULL;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.agent_registrations TO agentzero_app;
