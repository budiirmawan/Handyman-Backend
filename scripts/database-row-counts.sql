-- psql -X -v ON_ERROR_STOP=1 -At -F, -f scripts/database-row-counts.sql
-- Read-only; run during the stopped-writer snapshot window on source/destination.
SELECT format('SELECT %L, count(*) FROM %I.%I;',
              schemaname || '.' || tablename, schemaname, tablename)
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY schemaname, tablename
\gexec
