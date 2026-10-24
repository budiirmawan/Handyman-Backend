# Handyman Biznet VPS + Coolify deployment (Phase 2)

CR-HM-DEPLOY-PORTABILITY-01 · 2026-10-17 · Future operator procedure; **no VPS,
Coolify installation or live deployment was accessed/tested from Arena**.

## Target and sizing

Vercel Frontend → HTTPS stable API domain → Coolify reverse proxy → one Backend
container → private PostgreSQL container with persistent PGDATA. Backend also
mounts persistent evidence at `/app/.data/evidence`. Backups must leave the VPS.
Only Backend source is used. No vendor-specific business behavior is needed.

Planning floor for a small Stage 1 workload: **2 vCPU, 4 GiB RAM, 60 GiB SSD**.
Recommended starting point: **4 vCPU, 8 GiB RAM, ≥100 GiB SSD**, expandable volume
and off-host encrypted backups. These are **capacity recommendations, not
benchmarks**. Coolify control plane, Docker build workers, Node, PostgreSQL,
reverse proxy, scheduler, OS and file cache share the machine. Prefer building in
CI/registry to avoid build-time memory pressure. Allow roughly 3× current DB +
evidence footprint for restore staging, WAL, growth and backup workspace; video
can dominate disk. Measure actual RSS, CPU, DB size, evidence growth and I/O before
choosing a plan. Reserve memory for the OS; use alerts/limits rather than an
arbitrary tiny Node heap that breaks PDF/Excel/evidence work. Single VPS is not
high availability; agree RPO/RTO and a provider failure recovery location.

## 1. Prepare VPS and access

1. Provision a supported x86_64 Linux LTS release per the current official
   Coolify requirements (e.g. Ubuntu 24.04 LTS), reliable SSD, static address,
   supported Docker Engine and Compose plugin. Record OS/Docker/Coolify versions.
   Check Biznet networking, DNS, storage and snapshot behavior with the provider.
2. Use a non-root admin SSH account with keys, restricted management IP/VPN,
   tested sudo, recovery console and offline recovery credentials. Disable
   password/root remote login after confirming alternative access. Apply security
   patches, time synchronization and log rotation. Docker membership is root
   equivalent; restrict it.
3. Firewall: permit 80/443 for reverse proxy, SSH only from approved networks.
   Coolify administrative UI/internal control ports must be private or tightly
   restricted according to the installed version. Do not publish PostgreSQL 5432
   or Backend 3000 to the Internet. Check Docker's firewall rules from an external
   host: host firewall alone can fail to constrain published container ports.
4. Install Docker/Coolify using their current verified official release procedure
   at execution time. Inspect installer, source and version before running with
   root privileges; no unreviewed curl-pipe-shell command is prescribed here.
   Secure the dashboard (strong unique secret, MFA if supported, restricted
   access), backups and GitHub integration. No installation is executed in Arena.

## 2. Domains and HTTPS

1. Prepare `https://<stable-api-domain>` on the Coolify proxy with a valid
   certificate and automated renewal. Use a temporary validation hostname or
   operator-only routing until cutover. Lower DNS TTL ahead of migration and
   record old DNS targets; do not switch the production domain yet.
2. Proxy to Backend port 3000 over the private Docker network. Configure request
   body allowance/timeouts for the existing maximum 50 MB multipart upload plus
   overhead. Do not increase the application's 1 MB JSON limit unnecessarily.
   Confirm proxy buffering/temp files have capacity and no evidence URLs bypass
   authentication. Proxy HTTPS is independent of PostgreSQL TLS.
3. Preserve the Vercel production origin in `CORS_ORIGINS`. Domain changes only
   affect the Frontend's existing API configuration/DNS; no Frontend code change
   or API alias is assumed. Do not blindly trust forwarded client IP headers.

## 3. PostgreSQL FIRST, private and persistent

1. Provision a PostgreSQL service on a private Docker network. Pin an approved
   supported major matching the source server initially; do not combine a
   platform migration with an untested major upgrade. The supplied local Compose
   example is PostgreSQL **16**, while Arena's available embedded test engine was
   **18.4**. This is not proof that all majors were exercised. Rehearse on the
   actual chosen source/destination major before production.
2. Mount the database image's actual PGDATA path on dedicated persistent storage,
   with correct UID/permissions. Set `POSTGRES_DB/USER/PASSWORD` only during
   provisioning as required by that image; these are database image settings,
   not Backend config. Check restart persistence. Never use `compose down -v`.
3. Ensure existing standard `pgcrypto` and `btree_gist` extensions are available;
   inventory source versions (`pg_extension`). Establish owner/migration and
   runtime roles as in the [Railway runbook](HANDYMAN_RAILWAY_STAGE1_DEPLOYMENT.md).
   Runtime must not own schema or change migration history. Backend pool is
   fixed at 10 connections; budget database max_connections for the sole API,
   one-shot migrations, backups, monitoring, Coolify and an admin reserve.
4. Decide TLS policy explicitly. Keep DB private. If TLS is used, provision a
   valid trusted certificate/CA and use `DB_SSL=true`; do not disable certificate
   verification to silence errors. Test role grants after restore.
5. For migration from Railway, **restore the dump before running any migration**
   on this new database. Follow the [migration runbook](HANDYMAN_RAILWAY_TO_BIZNET_MIGRATION.md).
   For a genuinely empty new installation only, run canonical migration-up once
   using the migration-role credentials and identical Backend image.

## 4. Evidence storage

1. Preserve `EVIDENCE_STORAGE_DRIVER=local`. Only this driver ships; there is no
   shared S3 adapter. Do not configure a bucket variable and claim persistence.
2. Create an empty private host directory (example `/srv/handyman/evidence`) or
   Coolify persistent volume. Mount it at `/app/.data/evidence` and set exactly
   that `EVIDENCE_STORAGE_DIR`. Verify no anonymous/ephemeral volume shadows it.
3. Determine image user (`id`), normally node UID/GID 1000. Prepare imported files
   and directories readable/writable by that UID, mode 0600/0700 or a reviewed
   equivalent, no world access. Keep the API non-root. Do not recursively chown
   an unchecked host path or the entire VPS.
4. Transfer **both** `evidence/` and `reports/`, with unchanged keys, through the
   manifest/metadata verification procedure. Fail on missing bytes, unsafe paths,
   symlinks or checksum mismatch. Mount does not prove data was imported.
5. Test upload/download, stop/start and redeployment on the same storage, then
   verify SHA-256 after each operation. Include private report archives if used.

## 5. GitHub artifact and deployment configuration

1. Connect a narrowly scoped GitHub integration for **budiirmawan/Handyman-Backend**.
   Use the approved release SHA. Build via Dockerfile, not a different generated
   Node start recipe. Alternatively deploy the same tested immutable image digest
   from an authorized registry. Retain digest, SHA, lockfile hash and build logs.
2. Dockerfile builds with devDependencies in a separate stage; runner has dist +
   production dependencies only, no tsx/source/test requirement. Entrypoint:
   `node dist/server.js`. One-shot migration/status:
   `node dist/database/cli.js migrate` / `status` in the same artifact.
3. Apply [environment matrix](HANDYMAN_DEPLOYMENT_ENV_MATRIX.md): production mode,
   correct internal DB_* runtime credentials, port/prefix, Vercel CORS, storage
   mount, providers and session policy. Use Coolify secrets, not committed env
   files. **Keep scheduler false** while destination is isolated.
4. One replica, one active deployment, no overlapping old/new scheduler. Disable
   production auto-promotion during migration. Configure ≥30s termination grace,
   readiness `/api/v1/health/database`, liveness `/api/v1/health`, sensible restart
   backoff and bounded retries/alerting. Never use restart loops as migrations.
5. Run exactly one authorized migration job if canonical status has pending IDs;
   advisory locking refuses concurrent runners. Migration failure blocks release.
   Apply runtime grants; no down, no seed and no schema recreation.
6. Initial API startup requires DB connectivity, exact history and writable local
   storage. During validation permit operator access only: health/login can write
   sessions/audit/throttle metadata, so this is **not** a magical read-only mode.
   The application has no maintenance/read-only switch. Fence routing and disable
   jobs; do not permit production users until the cutover decision.

## 6. Validate, activate, monitor

- Verify HTTP liveness/readiness, migration inventory, exact roles, extensions,
  table/index/constraint inventory, row counts and DB/evidence association.
- Rehearse the complete Care journey and denials using approved data, HTTPS and
  the actual Vercel browser. Do not claim unit tests are live E2E.
- Exercise paired DB/evidence restore in isolation and measure restore time.
- Activate only under the single-writer cutover plan. Enable scheduler only on
  Biznet after Railway API/jobs are fenced. Stable domain can leave Vercel
  configuration unchanged; verify DNS/TLS/browser preflight anyway.
- Alert on readiness 503, HTTP 5xx, PostgreSQL pool errors/connection exhaustion,
  scheduler failures/backlog, disk/inode/WAL growth, missing evidence, backup age,
  certificate expiry, OOM and container restart churn. Logging is JSON to stderr;
  arrange rotation, retention and off-host collection.

## 7. Backup and rollback

Follow [backup/recovery](HANDYMAN_DATABASE_EVIDENCE_BACKUP_RECOVERY.md).
Snapshots on this VPS alone do not protect against VPS loss. Keep PostgreSQL
native dumps, manifest-verified evidence snapshots and secrets/config backups in
separate protected storage with restore drills. Coolify deployment rollback only
rolls back the application image; it does not safely reverse database migrations
or evidence changes. Unknown/newer schema history intentionally blocks an older
artifact. Prefer compatible forward repair; use paired restore only with explicit
loss/reconciliation decisions. After Biznet accepts writes, **DNS-only rollback
is unsafe**; follow the migration runbook's post-write recovery plan.

For migration 0478 specifically, the current runner refuses to down any populated
SERVICE price catalog before destructive DDL. Treat its non-zero refusal as a
safety control, not an error to bypass by deleting tiers, editing ledger/history,
or calling the historical down directly. Keep 0478 applied and fix forward, or use
the paired-restore decision gate in the recovery runbook. An older application
image is not compatible merely because the database still has the new schema:
exact-history readiness rejects unknown IDs and old SERVICE writes omit the
required tier key. Prove the target forward/recovery path on a staging copy under
BA-08; automated native DB+evidence recovery and measured RPO/RTO remain BA-11.
