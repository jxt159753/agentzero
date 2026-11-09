ALTER TABLE public.idempotency_requests DROP CONSTRAINT idempotency_requests_check;
ALTER TABLE public.idempotency_requests ADD CONSTRAINT idempotency_requests_check
  CHECK (status <> 'completed' OR (response_status IS NOT NULL
    AND response_status BETWEEN 100 AND 599 AND response_body IS NOT NULL));
