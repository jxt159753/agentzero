CREATE TABLE public.repository_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id),
  owner text NOT NULL CHECK(owner ~ '^[A-Za-z0-9_.-]{1,100}$'),
  name text NOT NULL CHECK(name ~ '^[A-Za-z0-9_.-]{1,100}$'),
  repository_url text NOT NULL,
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  repository_id uuid REFERENCES public.repositories(id),
  reviewer_user_id uuid REFERENCES public.users(id),
  review_reason text CHECK(length(btrim(review_reason)) BETWEEN 1 AND 500),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((status='pending' AND repository_id IS NULL AND reviewer_user_id IS NULL AND review_reason IS NULL AND reviewed_at IS NULL)
    OR (status='approved' AND repository_id IS NOT NULL AND reviewer_user_id IS NOT NULL AND review_reason IS NOT NULL AND reviewed_at IS NOT NULL)
    OR (status='rejected' AND repository_id IS NULL AND reviewer_user_id IS NOT NULL AND review_reason IS NOT NULL AND reviewed_at IS NOT NULL))
);
CREATE UNIQUE INDEX repository_requests_pending_unique ON public.repository_requests(user_id,lower(owner),lower(name)) WHERE status='pending';
CREATE INDEX repository_requests_user_idx ON public.repository_requests(user_id,created_at,id);
CREATE INDEX repository_requests_status_idx ON public.repository_requests(status,created_at,id);
GRANT SELECT,INSERT,UPDATE ON public.repository_requests TO agentzero_app;
