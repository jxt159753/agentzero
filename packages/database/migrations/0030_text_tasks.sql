ALTER TABLE public.tasks ALTER COLUMN repository_id DROP NOT NULL;
ALTER TABLE public.tasks ADD CONSTRAINT tasks_text_contract_check CHECK (
  repository_id IS NOT NULL OR (
    issue_number IS NULL AND required_checks='[]'::jsonb AND reviewer_user_id=publisher_user_id
  )
);

ALTER TABLE public.task_deliveries
  ALTER COLUMN pr_number DROP NOT NULL,
  ALTER COLUMN head_sha DROP NOT NULL,
  ALTER COLUMN pr_url DROP NOT NULL,
  ADD COLUMN content text;
ALTER TABLE public.task_deliveries ADD CONSTRAINT task_deliveries_content_check CHECK (
  (content IS NULL AND pr_number IS NOT NULL AND head_sha IS NOT NULL AND pr_url IS NOT NULL)
  OR (content IS NOT NULL AND length(btrim(content)) BETWEEN 1 AND 8000
    AND pr_number IS NULL AND head_sha IS NULL AND pr_url IS NULL)
);
