-- Project-local development only. Use independently managed secrets in deployment.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentzero_migrator') THEN
    CREATE ROLE agentzero_migrator LOGIN PASSWORD 'local-migration-only' NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentzero_app') THEN
    CREATE ROLE agentzero_app LOGIN PASSWORD 'local-app-only' NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
SELECT 'CREATE DATABASE agentzero_dev OWNER agentzero_migrator'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'agentzero_dev') \gexec
SELECT 'CREATE DATABASE agentzero_test OWNER agentzero_migrator'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'agentzero_test') \gexec
