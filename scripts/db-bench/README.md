# scripts/db-bench — CR-HM-DB-OPT-01 benchmark tooling

Synthetic-fixture benchmark and schema-capture helpers for the CR-HM-DB-OPT-01
DB optimization work. **Everything here targets disposable scratch databases
only** — never run against a shared or production PostgreSQL.

## Files

| File | Purpose |
| --- | --- |
| `run-bench.ts` | Creates/drops `asentra_bench`, applies all migrations, loads clearly-labeled SYNTHETIC fixtures, measures the 8 query shapes that motivated migration `0434` before/after its indexes, writes `out/bench-results.json` (latencies + full `EXPLAIN (ANALYZE, BUFFERS)` plans + table/index sizes). |
| `capture-schema.ts` | Applies the migration chain to a scratch database and dumps a schema/index/FK inventory JSON (source of the `CR-HM-DB-OPT-01_TABLE-INVENTORY.md` appendix). |
| `gen-table-inventory.ts` | Renders the inventory JSON into the markdown appendix. |
| `out/bench-results.json` | Committed measurement evidence from the CR run (PostgreSQL 16.14). Regenerating overwrites it. |

## Running the benchmark

```bash
# scratch PostgreSQL 14+ (the CR evidence used PostgreSQL 16.14)
DB_HOST=127.0.0.1 DB_PORT=55432 DB_USER=postgres DB_PASSWORD=postgres \
  npx tsx scripts/db-bench/run-bench.ts
```

- The harness refuses to touch any database other than `asentra_bench` and
  drops/recreates only that database.
- Fixtures are generated with `generate_series` (60k requests, 40k
  appointments, 40k assignments, 36k arrival results, 36k warranty claims,
  200k auth-audit events). FK trigger enforcement is disabled while loading
  (`session_replication_role = replica`); CHECK constraints are satisfied with
  real domain values. Planner statistics come from `ANALYZE` after loading.
- Protocol: 3 warmups + 10 timed runs per query, median/p95 reported; one
  `EXPLAIN (ANALYZE, BUFFERS)` sample per query per phase.

## Honesty rules (do not weaken)

- Results are **synthetic fixture measurements**, not production traffic.
- Do not quote these numbers as production SLAs; use them to compare planner
  behavior before/after schema changes on identical data.
