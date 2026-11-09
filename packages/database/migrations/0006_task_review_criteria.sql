ALTER TABLE public.task_reviews DROP CONSTRAINT task_reviews_check;
ALTER TABLE public.task_reviews ADD CONSTRAINT task_reviews_check
  CHECK (decision <> 'request_changes' OR (unmet_criteria IS NOT NULL AND length(btrim(unmet_criteria)) > 0));
