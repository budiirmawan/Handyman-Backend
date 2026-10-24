# Railway → Biznet/Coolify migration: one writer, paired data

CR-HM-DEPLOY-PORTABILITY-01 · 2026-10-17 · Operator plan, **not executed against
live infrastructure**. Read [Railway](HANDYMAN_RAILWAY_STAGE1_DEPLOYMENT.md),
[Coolify](HANDYMAN_BIZNET_COOLIFY_DEPLOYMENT.md) and
[backup/recovery](HANDYMAN_DATABASE_EVIDENCE_BACKUP_RECOVERY.md) first.

## Non-negotiable invariants and decision owners

- One authoritative database and evidence tree accept production writes at a
  time. Never leave Railway and Biznet independently writable with divergent DBs.
- PostgreSQL metadata backup and evidence bytes backup are separate artifacts
  captured during the **same stopped-writer interval**. Include reports namespace.
- No database major upgrade, new business release, seed, schema reset or domain
  approval feature is bundled with the platform migration. Start with the same
  application SHA/image digest and schema version on both sides.
- Name cutover commander, DB operator, storage operator, Frontend smoke owner,
  backup owner and rollback approver. Agree maintenance window, measured RPO/RTO,
  abort criteria and customer communication. No measured RTO is claimed here.
- Application has no built-in maintenance/read-only flag. Fence routes and stop
  API containers/jobs; merely setting scheduler false does **not** stop writes.
  Login, audit and session-last-used updates are writes too.

## A. Before migration: rehearse without touching the active source

1. Record Railway release SHA/image digest, PostgreSQL `SHOW server_version`,
   extensions (`SELECT extname, extversion FROM pg_extension ORDER BY extname`),
   encoding/locale, timezone, database size and migration history. For the Part 04
   recovery release, canonical latest is **0480**, with **478 registered IDs**;
   0449 and 0469 are intentionally unclaimed. For any other artifact, derive the
   head/count from its matching release registry, never invent a missing migration.
2. Confirm PostgreSQL destination major is the same initially and extension
   packages pgcrypto/btree_gist are available. `pg_dump` client must not be older
   than the source server; prefer matching source/destination major CLI tools.
   Restoring into an older server is not supported by this plan. Match
   encoding/collation and validate index behavior if OS locale differs.
3. Inventory evidence references with `scripts/evidence-references.sql`; inventory
   files with `scripts/evidence-transfer.py`. Investigate non-managed references,
   pending uploads, missing files and hashes before the cutover window. Never
   rewrite database keys merely to silence verification. Legacy/external keys
   require a separately proven retrieval/backup plan or are a blocker.
4. Verify latest paired backups and protected off-host copies; exercise a restore
   on an isolated PostgreSQL instance plus empty evidence volume. `pg_restore -l`
   or a successful dump alone is **not** restore validation. Record exit codes,
   comparison results and duration. Retain the rehearsal artifacts securely.
5. Prepare Biznet OS, network, Coolify, HTTPS validation hostname, private DB,
   roles and empty persistent evidence mount. Use same Backend image, scheduler
   false, no production routing. Build must not run migrations/seeds.
6. Restore a rehearsal backup, validate schema/history/counts and checksums,
   exercise restart/redeployment and Care E2E with approved data. This test copy
   is disposable and never becomes a second production writer. Keep rehearsal
   changes out of the final restore. Lower stable API domain TTL in advance.

## B. Final freeze and capture

1. Announce maintenance and disable production routing/Frontend writes. Stop
   Railway API and all in-process scheduler instances; wait for shutdown/drain.
   List jobs/integration producers/admin sessions and stop any other writers.
   Verify no active writer transactions via `pg_stat_activity`. A 25s forced
   shutdown may roll back in-flight transactions; investigate before snapshot.
2. Fence old API access at proxy/platform, including old Railway hostname.
   Revoking a login alone does not kill existing sessions: a DBA may temporarily
   set the **dedicated app role** NOLOGIN and terminate its remaining connections
   after drain if needed. Do not kill the dump/admin session or change a shared
   role. Keep a recorded, approved restoration command for pre-write rollback.
3. With all writers stopped, capture final full PostgreSQL dump and row/schema/
   migration inventory. With the same freeze, export metadata reference CSV and
   evidence manifest, then copy the evidence tree. Keep Railway stopped until
   cutover or formally approved rollback.

### Exact portable PostgreSQL commands (placeholders only)

Run on an approved private-network operator host or tool container, not Arena.
Set libpq connection parameters using a protected mode-0600 passfile and TLS
policy. Never put secrets in URLs, command-line arguments, shell tracing or Git.
These are PostgreSQL CLI variables, not Backend environment variables.

```sh
set -eu
umask 077
# Fill names/paths, not password values, in the operator environment.
export PGHOST='<source-db-host>' PGPORT='<source-db-port>'
export PGDATABASE='<source-db-name>' PGUSER='<authorized-backup-role>'
export PGPASSFILE='<absolute-protected-source-passfile>'
# Public connection requires trusted TLS; supply CA when not in default trust.
export PGSSLMODE=verify-full
export PGSSLROOTCERT='<absolute-trusted-ca-file>'
# For an approved private non-TLS tool path only, explicitly choose its policy.
SNAPSHOT='<unique-private-snapshot-directory>'
mkdir -m 700 "$SNAPSHOT"
pg_dump --format=custom --file="$SNAPSHOT/database.dump"
pg_restore --list "$SNAPSHOT/database.dump" > "$SNAPSHOT/database.toc"
psql -X -v ON_ERROR_STOP=1 -At -F, -c \
  "SELECT id, applied_at AT TIME ZONE 'UTC' FROM schema_migrations ORDER BY id" > "$SNAPSHOT/migrations.txt"
psql -X -v ON_ERROR_STOP=1 -At -F, -f scripts/database-row-counts.sql \
  > "$SNAPSHOT/row-counts.csv"
pg_dump --schema-only --no-owner --no-privileges > "$SNAPSHOT/schema.sql"
psql -X -v ON_ERROR_STOP=1 -f scripts/evidence-references.sql \
  > "$SNAPSHOT/evidence-references.csv"
sha256sum "$SNAPSHOT/database.dump" > "$SNAPSHOT/database.dump.sha256"
```

The backup login needs access to **all** application tables/sequences and schema,
not merely Care-visible rows. Confirm no row-security/exclusion omitted data.
Review dump stderr/exit code. This is a full custom-format logical backup of one
database, **not** a roles/cluster backup; roles/secrets must be recreated securely.
Do not assume platform snapshots are portable logical dumps.

### Evidence export, transport and import

Use Python ≥3.11 and the checked-out operator scripts from this release. They are
not in the dist-only Backend image; use a private helper host/container mounting
the evidence volume read-only during export. If Railway offers no safe direct
volume export, attach an approved maintenance helper to the volume while Backend
is stopped and export over authenticated encrypted transport. Verify the actual
platform's supported volume access/backup mechanism **before** migration day.
No platform volume export API was tested in Arena.

```sh
# SOURCE_ROOT is the actually attached volume root, not a guessed container path.
SOURCE_ROOT='<mounted-source-volume-root>'
python3 scripts/evidence-transfer.py inventory "$SOURCE_ROOT" "$SNAPSHOT/evidence-manifest.json"
python3 scripts/evidence-transfer.py verify "$SOURCE_ROOT" "$SNAPSHOT/evidence-manifest.json" \
  --references "$SNAPSHOT/evidence-references.csv"
mkdir -m 700 "$SNAPSHOT/evidence"
python3 scripts/evidence-transfer.py copy "$SOURCE_ROOT" "$SNAPSHOT/evidence-manifest.json" \
  --destination "$SNAPSHOT/evidence"
```

Transfer the private snapshot over approved authenticated SSH or encrypted backup
transport to an operator-owned staging directory; for example:

```sh
rsync -a --checksum --safe-links -e 'ssh -i <operator-key-file>' \
  '<snapshot-directory>/' '<operator>@<biznet-host>:<private-staging-directory>/'
```

Check SSH host keys; do not disable host-key checking. Do not use arbitrary tar
extraction into the live volume. On destination verify the trusted manifest/dump
hash through an authenticated channel; hashes do not protect against replacement
of both data and manifest by an attacker. Keep metadata CSV private (identifiers
and relationships are sensitive).

```sh
# DEST_ROOT is an existing EMPTY, private volume root. No API uses it yet.
DEST_ROOT='<mounted-empty-destination-volume-root>'
python3 scripts/evidence-transfer.py copy '<private-staging-directory>/evidence' \
  '<private-staging-directory>/evidence-manifest.json' --destination "$DEST_ROOT"
python3 scripts/evidence-transfer.py verify "$DEST_ROOT" \
  '<private-staging-directory>/evidence-manifest.json' \
  --references '<private-staging-directory>/evidence-references.csv'
```

Tool validates only managed `evidence/<uuid>` / `reports/<uuid>` keys, rejects
symlinks, traversal, unmanaged files, overlap, nonempty destinations and overwrites;
copies exclusively and hashes every byte before/after. Stop all access to these
private directories during the operation (it is an offline tool, not protection
against a hostile concurrent filesystem writer). Unexpected files/probes require
review, not deletion. It retains unreferenced valid files; it never purges data.
Fix node UID/GID on the verified destination mount, keeping 0600/0700 or approved
equivalent. The runtime needs write access to both namespaces.

Metadata associations: intake/photo/video/payment proof uses
`evidence_submissions.file_reference` (intake parent execution_type HANDYMAN_REQUEST
and execution_id=request ID), content_sha256 and file_size. Report archives use
storage_reference/checksum/file_size. Handyman evidence file records use
storage_key/sha256_digest/byte_size; field upload staging uses
storage_key/sha256_checksum/verified_byte_size. Communications reference submission
IDs, not copied file paths. Purged submissions and PENDING_BYTES uploads are not
asserted to have bytes; SQL export excludes those. Missing retained references
are blockers; legacy records without stored SHA are checked by size + captured
manifest hash but that cannot establish historical integrity. Resolve unsupported
external references explicitly. There is no shared-S3 alternate path today; a
future adapter requires its own implementation/verification, not an env toggle.

## C. Restore final DB, not rehearsal DB

Use a fresh empty destination database created by the DBA with matching
encoding/locale and reviewed roles. Never restore with `--clean` against a live
schema; never drop/recreate source schema. If rehearsal populated the destination,
provision a separate empty final database and point Backend at it only after
validation. Do not merge rehearsal writes with production data.

```sh
# Destination connection; source passfile is not reused accidentally.
export PGHOST='<destination-private-host>' PGPORT='<destination-port>'
export PGDATABASE='<empty-final-database>' PGUSER='<restore-operator>'
export PGPASSFILE='<absolute-protected-destination-passfile>'
# Set PGSSLMODE/PGSSLROOTCERT according to the approved destination policy.
# Check the transferred dump hash against the recorded source SHA-256 first.
pg_restore --exit-on-error --single-transaction --no-owner --no-privileges \
  --role=hm_migrator --dbname="$PGDATABASE" '<staged-database.dump>'
psql -X -v ON_ERROR_STOP=1 -At -F, -c \
  "SELECT id, applied_at AT TIME ZONE 'UTC' FROM schema_migrations ORDER BY id" > '<private-destination-migrations.txt>'
psql -X -v ON_ERROR_STOP=1 -At -F, -f scripts/database-row-counts.sql \
  > '<private-destination-row-counts.csv>'
```

The restore operator must be permitted to SET ROLE hm_migrator; recreated objects
then belong to the migration role. Install/authorize required extensions first
according to the actual source TOC and PostgreSQL rules; review all restore errors.
No schema reset is a remedy for privilege errors. Reapply runtime grants from
Railway runbook; no privileges/owners are imported blindly from Railway.

Require restore exit 0, expected TOC, matching table counts (all tables), migration
IDs **and original applied_at history**, tables/indexes/constraints/triggers/
functions/extensions/sequences. Compare normalized schema dumps/information_schema
and pg_catalog inventories (pg_dump random restrict markers/version headers may
differ). Confirm constraints valid, sequence values present and representative
business integrity: request→Client/Property/Building chain, exact Care assignments,
communication→request/evidence links, retained evidence access, monetary/history
invariants as applicable. Row counts alone do not prove relationship integrity.

Run `node dist/database/cli.js status` with migration credentials from the
**same** artifact, then runtime readiness. Already-applied IDs must not be replayed.
No migrations are expected for an identical image/schema; if pending/unknown IDs
appear, stop and investigate rather than migrate blindly. Re-export references
from restored DB and compare them to source before enabling test writes.

## D. Cutover decision gates

1. Keep Railway API, scheduler, public platform hostname and any external writers
   fenced. Keep destination isolated and scheduler false during final checks.
2. Before any target test writes, compare final DB/evidence snapshots. Run private
   HTTPS health checks, permissions and approved Care E2E, downloads/checksums and
   restart persistence. E2E itself creates sessions/audit/communications: record
   the **first target write time** and disposition of approved test writes.
3. Commander signs off backups, restore, security, DNS/certificates, actual Vercel
   CORS and E2E. Abort if missing evidence, schema mismatch, restore errors,
   unacceptable performance or uncertain single-writer fencing remains.
4. Switch the stable API domain/proxy to Biznet. Verify DNS from multiple clients,
   certificate, Vercel preflight and full browser journey. Old cached DNS must
   hit fenced Railway, not an independently writable service.
5. Enable target production access/writes and then the sole scheduler. Verify old
   source remains stopped/NOLOGIN as applicable; remove transient restore secrets.
   Watch readiness, 5xx, DB errors, disk/IO/WAL, scheduler and evidence failures.
6. Retain protected Railway DB/volume snapshots and configuration through the
   approved observation period. Do not delete the old environment until fresh
   Biznet backups have been restore-validated and rollback retention is approved.

## E. Rollback / recovery decision points

**Before target writes (including E2E writes):** keep target fenced, stop target
API/jobs, route DNS back, restore source app-role login if disabled, verify source
DB/evidence unchanged and healthy, then resume only Railway writes/scheduler.
Account for DNS caches by leaving target fenced. Retain failed target artifacts.

**After target has accepted any writes:** DNS-only rollback would lose or split
transactions and evidence. Fence **both** sides and stop jobs immediately. Prefer
forward repair on Biznet. If infrastructure rollback is necessary, take a new
paired Biznet DB/evidence snapshot, restore/verify it into an isolated compatible
Railway database/volume or another recovery environment, reapply grants and
matching artifact, and cut over once under the same single-writer rules. Account
for post-cutover communication/evidence/session changes and external side effects;
do not merge databases by copying a few rows blindly. If reverting to the old
snapshot with data loss is unavoidable, require explicit business approval of
the loss window and a documented reconciliation process before resuming. No
automatic down migration or application-image rollback can solve this.

**0478 price-tier rule (Part 04):** populated SERVICE price data makes historical
0478 down unsafe. The current runner rejects it before DDL, including when only
one non-conflicting keyed tier exists; do not delete tiers or edit history to
obtain a successful rollback. Use a reviewed forward fix or the paired-restore
procedure above. Application-image rollback retaining 0478–0480 is not certified:
older exact-history readiness and SERVICE writes are incompatible. See the
[0478 recovery control](HANDYMAN_DATABASE_EVIDENCE_BACKUP_RECOVERY.md) for the
preflight behavior, validation inventory, RPO/RTO assumptions and write-freeze
boundary. Disposable Part 04 recovery proof does not replace the required staging
or native paired-restore rehearsal.
