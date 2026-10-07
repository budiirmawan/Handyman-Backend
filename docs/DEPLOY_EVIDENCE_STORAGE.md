# Evidence Storage — Deploy & Persistence (D03)

Local-driver production readiness for evidence and report-artifact file bytes.
Interface: `EvidenceStorage` (`src/modules/evidence/storage/`).

## Driver

- `EVIDENCE_STORAGE_DRIVER` must be `local` — the only shipped driver. Any
  other value fails fast at config load. No MinIO/S3 adapter exists in this
  codebase; none was added.
- `EVIDENCE_STORAGE_DIR` selects the root directory (default `.data/evidence`;
  the production image pins the absolute path `/app/.data/evidence`).
- Storage keys are backend-generated (`evidence/<uuid>`, `reports/<uuid>`);
  client paths never reach the filesystem.

## Compose wiring (already in place, verified by D03)

- `docker-compose.yml` mounts the named volume `handyman-evidence` at
  `/app/.data/evidence`, matching the image's `EVIDENCE_STORAGE_DIR`.
- The volume survives `docker compose down` and container rebuilds. It is
  destroyed only by an explicit `docker compose down -v`.

## Boot gate (fail fast)

- `src/server.ts` runs `verifyEvidenceStorageReady()` during boot, after the
  database check: the directory is created (recursive) and writability is
  proven with a probe file that is removed immediately.
- An invalid or unwritable directory aborts startup with exit 1 and a
  `ConfigError` naming the resolved path (missing mount, wrong ownership).

## Backup / persistence responsibility

- **The operator owns backups.** The backend persists bytes to the named
  volume but performs no replication, snapshotting, or off-site copy.
- Recommended: snapshot or back up the `handyman-evidence` volume on the
  same schedule as the `handyman-postgres-data` volume — database rows
  reference storage keys, so restore both from the same point in time.
- `docker compose down -v` deletes evidence bytes irreversibly; never use
  `-v` outside a deliberate, backed-up teardown.
- Restore = repopulate the volume at the same keys, then boot normally; the
  readiness gate confirms the restored directory is writable.

## Verification

- `npm run build` — must stay green.
- `NODE_ENV=test LOG_LEVEL=error npx tsx --test tests/evidence-storage-readiness.test.ts`
  — storage config, local-driver round-trip, key validation, and the
  readiness gate (hermetic; uses OS temp dirs, no database).
