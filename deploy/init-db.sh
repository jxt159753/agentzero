#!/bin/sh
set -eu
# Executed only for an empty Docker PostgreSQL volume. Passwords come from deployment secrets.
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1 \
  --set=migration_password="$MIGRATION_PASSWORD" --set=runtime_password="$APP_PASSWORD" <<'SQL'
CREATE ROLE agentzero_migrator LOGIN PASSWORD :'migration_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE agentzero_app LOGIN PASSWORD :'runtime_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE agentzero OWNER agentzero_migrator;
SQL
