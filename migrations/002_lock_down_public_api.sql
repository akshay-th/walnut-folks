-- Supabase automatically exposes tables in the public schema through its REST
-- API (PostgREST), reachable with the publishable "anon" key. This service
-- talks to Postgres directly as the tables' owner, which row level security
-- does not restrict, so nothing should be reachable through that API.
--
-- RLS enabled with no policies = no rows for any non-owner role. The REVOKEs
-- are belt and braces; they only run where Supabase's roles exist, so the same
-- migration works on plain PostgreSQL.
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON transactions, schema_migrations FROM %I', role_name);
    END IF;
  END LOOP;
END $$;
