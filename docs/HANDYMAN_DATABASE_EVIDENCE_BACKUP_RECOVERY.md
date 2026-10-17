# Handyman database + evidence backup and recovery

CR-HM-DEPLOY-PORTABILITY-01 · 2026-10-17 · Operator-owned procedures.
**No automatic backup service, retention service or live restore was deployed by
this change.** Scripts support offline inventory/copy/verification, not scheduling,
encryption, replication or provider volume export.

## 1. What must be protected

1. Full PostgreSQL database: business rows, immutable histories, users/password
   hashes, session token hashes, migrations, schema/functions/triggers/extensions,
   sequence states and configuration. Treat dumps as highly sensitive.
2. Evidence root mounted at `/app/.data/evidence` in the shipped image, with
   **both** `evidence/` and `reports/`. Byte storage is local filesystem only.
   Database `evidence_submissions.file_reference` and related storage references
   point to those keys; database dumps do **not** include the bytes.
3. Reviewed database ownership/grants, version/extension/locale inventory, release
   SHA/image digest, platform configuration, domains/DNS and volume mapping.
4. Secrets and access recovery: runtime/migration/backup role secrets, provider
   secrets if enabled, TLS CA/key material where self-managed, GitHub/Coolify and
   Railway recovery access. Keep them in a separate encrypted secret manager,
   **never** in Git or the backup manifest. Keep encryption recovery keys outside
   the machine and test access with an authorized second operator.

## 2. Recommended policy (not implemented automation)

For small Stage 1, begin with daily paired encrypted off-host backups and an
additional pair before migrations, major configuration changes and cutover.
Suggested retention: 7 daily, 4 weekly, 3 monthly pairs with a documented legal/
privacy retention review. Prefer versioned/immutable off-host storage and a
separate account/access boundary. Provider snapshots are useful but are not the
only copy. Evidence can be large: monitor backup size/duration and transfer cost.

Daily dumps imply **up to 24h RPO**, not zero data loss. If business requirements
need less, design and test PostgreSQL WAL/PITR plus corresponding evidence
versioning/snapshots as a separately authorized operation. PostgreSQL-only PITR
without matched evidence recovery is insufficient. Agree RTO based on measured
restore drills, not resource guesses. Monthly restore drill and after each
migration/storage change are recommended; record which backup was restored,
exit codes, checksums, row/relationship checks, artifact version and elapsed time.
A backup is not validated until the restore path has actually been exercised.

## 3. Capture a consistent pair

Use the [migration runbook section B](HANDYMAN_RAILWAY_TO_BIZNET_MIGRATION.md)
commands verbatim for pg_dump custom format, TOC, migration inventory, complete
row counts, schema dump, reference CSV, file manifest and safe copy.

- Freeze all writers/API/scheduler/external producers, drain and inspect active
  transactions. There is no application maintenance/read-only flag. pg_dump is
  DB-transaction consistent while online but does not make separately changing
  filesystem bytes consistent. Use the stopped-writer window for the pair.
- Use unique private snapshot directories with umask 077. Never run with shell
  tracing, echo secrets/URLs, or send live dumps to chat. Use protected libpq
  passfiles, approved private networking or verified TLS.
- A backup login must cover every table/sequence, not just rows visible to a Care
  user. No table filters, schema-only shortcut or silent pg_dump errors.
- Export `scripts/evidence-references.sql` against that frozen DB. It includes
  retained submission keys, report archives, Handyman evidence files and byte-
  staged/verified field uploads. Intentionally purged submissions and pending-
  bytes reservations do not prove a file should exist. External/legacy references
  and any discrepancies require explicit review and a proven separate backup.
- `python3 scripts/evidence-transfer.py inventory <root> <manifest>` hashes files;
  `verify <root> <manifest> --references <reference.csv>` checks retained DB
  association, sizes and available DB hashes; `copy` only accepts an empty private
  destination. Python ≥3.11, scripts checked out separately from runtime image.
- No arbitrary archive extraction, symlinks, path traversal or overwrite is
  supported. Script assumes a trusted offline operator-owned directory with no
  concurrent writers. Unknown files/probes stop the procedure for review.
- Encrypt/upload completed artifacts and metadata, verify authenticated off-host
  readback/hash, mark pair complete only when **both** components exist. If any
  stage fails, preserve diagnostic artifacts, mark pair incomplete and do not
  prune the previous valid pair. Resume writes only after operator sign-off.

## 4. Restore drill / disaster recovery

1. Declare incident, fence production writers and jobs, preserve logs/current
   damaged state where possible. Never run destructive repair against the only
   copy. Agree the exact recovery point and any acceptable data loss.
2. Prepare an isolated database with matching PostgreSQL major, encoding/locale,
   required pgcrypto/btree_gist extensions and correct migration-owner role.
   Prepare empty persistent evidence storage; no public routing/scheduler.
3. Verify backup identity, pair time, manifest, dump hash and encryption integrity.
   Use `pg_restore --exit-on-error --single-transaction --no-owner --no-privileges
   --role=hm_migrator --dbname=<empty-recovery-db> <database.dump>` with protected
   libpq environment/passfile. See migration guide for exact setup and commands.
   Require exit 0; inspect TOC/schema inventory. Never restore over live schema
   with `--clean` or use drop/recreate to conceal failure.
4. Reapply least-privilege runtime grants from Railway runbook. Restored objects
   must be owned by the migration role, not runtime. Validate functions/triggers,
   constraints, indexes, sequence state, extensions, full row counts, migration
   **IDs and applied_at**, and representative business relationships.
5. Import evidence with the safe copy procedure into the empty volume, verify
   manifest and DB reference CSV from the **restored** database, correct node
   UID/GID and permission modes. Verify both report and evidence namespaces.
6. Start identical Backend image privately using runtime DB credentials and
   scheduler false. Exact migration-history readiness must pass; already-applied
   migrations are not replayed. Verify liveness, readiness, Care auth, assignment,
   request/progress/history, evidence downloads and hashes, restart and redeploy.
   Test writes must be approved/documented; a private test instance is not
   automatically an authorized production writer.
7. Commander chooses the single authoritative recovery environment, fences the
   other one, switches routing and resumes writes/jobs once. Monitor closely.
   Measure and retain restore results. Only then label this backup pair validated.

## 5. Startup/crash prevention already in source

- API never automatically migrates, seeds or resets schema. One-shot migration
  runner has a portable PostgreSQL advisory lock, transactional per-ID history,
  no concurrent runners, unknown-newer-history rejection and idempotent up.
- API opens its listener only after `SELECT 1`, exact canonical history and
  evidence-root writability. Missing/pending/unknown history blocks startup.
  Failed storage/history boot closes the initialized pool. Writable path is not
  proof of a persistent volume; verify actual mount/restart persistence.
- pg pool: **max 10**, connection/acquisition timeout **5s**, idle cleanup **30s**;
  SSL true verifies certificates. No endless startup retry or destructive
  initialization on connection failure. Railway supervisor retries are bounded.
- Idle pool errors are handled/logged; credentials are not intentionally logged
  and DB-password occurrences in connectivity/pool errors are sanitized. Do not
  enable verbose secret-bearing provider logs or log environment dumps.
- `/api/v1/health` is liveness. `/api/v1/health/database` queries DB and exact
  canonical history; failures return sanitized 503. Platform rollout checks use
  readiness. Add external continuous monitoring; rollout checks are not alerts.
- Pool reconnects on later queries after an outage. In-flight business
  transactions are **not** automatically retried, preventing duplicate effects;
  consumers must inspect outcomes and use existing idempotency semantics.
- SIGTERM/SIGINT stop accepting HTTP immediately, stop/drain scheduler up to 5s,
  drain active HTTP, then close pool. Overall shutdown deadline **25s** terminates
  stuck requests/checked-out clients with exit 1. Configure supervisor grace ≥30s.
  A forced exit may roll back unfinished work; inspect before retrying commands.
- Scheduler is in-process, one timer per process, no certified cross-replica
  scheduling guarantee. Stage 1 uses **one API replica** with stop-before-start
  deployments. Do not start the migration destination scheduler alongside source.
- General SQL statement/transaction execution timeouts are not globally added by
  this CR; the bounded pool connect timeout does not cancel every running SQL.
  PostgreSQL lock/statement timeout policy requires workload review. A connected
  but unresponsive DB may cause a health probe to time out at the supervisor.

## 6. Operational incident playbooks

| Symptom | Safe response |
|---|---|
| Database unavailable at startup | Keep traffic fenced. Check DB provision/health, private DNS/port, DB name/role/password, TLS chain, firewall and connection capacity. Correct configuration, retry intentionally. Never reset/seed schema. |
| Readiness 503 after running | Check source DB availability and history mismatch; liveness may stay 200. Pause write attempts, alert, inspect pool errors and active transactions. Recovery probes should return 200 after DB returns. Verify ambiguous transaction outcomes before retry. |
| Failed migration | Stop promotion; identify last committed and failed IDs and error. Earlier migrations can be committed. Back up, fix forward/re-run reviewed up only after diagnosis. Do not run down or edit bookkeeping manually to force readiness. |
| Another migration runner active | Identify owner/job, wait for intentional completion; no retry storm. PostgreSQL releases session advisory lock when session closes. Do not kill an unknown active migration casually. |
| Unknown/newer migration IDs | Wrong/older artifact or unexplained history. Use matching release and investigate. Do not remove IDs to launch an old image. |
| Missing/corrupt evidence | Stop affected writes/retention jobs; preserve volume, compare trusted manifest/DB hashes. Restore paired recovery tree privately. Never fabricate empty files or delete metadata to hide missing bytes. If no valid backup exists, escalate data loss and do not claim integrity. |
| Volume corruption | Fence app, preserve image/snapshot, use storage/provider recovery procedures. Restore to a new empty healthy volume and verified database pair. No blind fsck/chown on an unchecked path. |
| Disk/inodes/WAL full | Alert before capacity (recommend warning 70%, critical 85%, tune to growth). Inspect postgres data/WAL, evidence, backups, Docker layers and logs separately. Expand or safely move completed off-host backups/rotate logs. Never delete PostgreSQL WAL/data or evidence manually. |
| DB connections exhausted | Inspect pg_stat_activity, pool errors and API/job replica count; preserve admin headroom. One API uses at most 10, plus migration/admin/backup clients. Stop accidental duplicate instances and diagnose stuck transactions before increasing max_connections/memory. |
| Restart loop / OOM | Disable auto-promotion, inspect config/storage/schema and memory/build overlap. Bound restart policy, alert on churn, fix cause; do not add infinite retry code. |
| Scheduler failures/backlog | Pause activation/migration cutover, inspect dispatcher/provider errors and due backlog. Confirm one active timer/service. Do not create a new distributed job architecture as incident repair. |

Suggested monitoring: external HTTPS readiness, 5xx and latency, restart count/OOM,
DB max connections/active waits/locks, disk/inode/free capacity, backup age and
last successful restore, evidence integrity sampling, scheduler failures/backlog,
TLS expiry and off-host backup availability. These are policy recommendations,
not newly shipped dashboards. Logs are JSON stderr in production with request
IDs; request logging excludes query strings, auth headers, bodies and evidence
payloads. Restrict log access, retention and exports.

## 7. Secret rotation and controlled restart

- Store/recover secrets via the platform vault/password manager, not application
  dumps alone. Backup inventory lists secret **names/owners**, never values.
- To rotate DB secrets, coordinate maintenance or staged role rotation, update
  platform secrets, restart the sole API to discard old pool connections and
  verify auth/readiness. Keep migration secrets separate from runtime. Revoke
  old credentials only once new access and recovery access are verified.
- Opaque session tokens have no signing secret to copy; their hashes are in the
  DB. Decide whether to revoke active sessions after an incident/cutover through
  approved account/session administration. Never extract/print live raw tokens.
- Stop new traffic, drain/stop scheduler and HTTP, restart with unchanged volume,
  DB and approved image, verify readiness and byte integrity, then restore traffic.
  Do not use `docker compose down -v`, volume prune or database down migrations.
- Post-write platform rollback requires reverse transfer/reconciliation under a
  new freeze, not DNS-only rollback; see migration runbook decision points.

## Validation boundary

Arena exercised disposable PostgreSQL bootstrap and outage/restart behavior,
filesystem-copy round-trip and negative integrity/path tests. Native `pg_dump`,
`pg_restore`, Docker daemon, Railway volumes and Biznet access were unavailable;
**portable native backup/restore and live volume export/import remain operator
validation gates**, not claimed PASS. The commands above are procedures to
rehearse on the chosen production-compatible PostgreSQL version.
