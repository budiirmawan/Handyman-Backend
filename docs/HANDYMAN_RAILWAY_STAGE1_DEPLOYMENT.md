# Handyman Railway Stage 1 deployment

CR-HM-DEPLOY-PORTABILITY-01 · 2026-10-17 · **operator procedure, not executed in Arena**.
Backend repository only. Vercel remains the Frontend host. Do not create a
second domain audit or enable BM SSO, Tenant decision execution, or Care
quotation/variation/BAST approval. Business architecture remains
TENANT/PIC ↔ CUSTOMER CARE BUILDING ↔ HANDYMAN.

Companions: [environment matrix](HANDYMAN_DEPLOYMENT_ENV_MATRIX.md),
[backup/recovery](HANDYMAN_DATABASE_EVIDENCE_BACKUP_RECOVERY.md),
[GO/NO-GO](HANDYMAN_STAGE1_GO_NO_GO_CHECKLIST.md),
[future migration](HANDYMAN_RAILWAY_TO_BIZNET_MIGRATION.md).

## 0. Release and safety prerequisites

1. Obtain an approved release SHA/image digest from this Backend PR after review.
   `git rev-parse HEAD`; record `package-lock.json` hash and image digest. Deploy
   the same artifact for migration and server. Docker stages use Node 22
   bookworm-slim; floating upstream tags require recording the resolved digest
   per release (this repository does not promise bit-identical future rebuilds).
2. Use an isolated Railway project/environment with access restricted to approved
   operators. Keep Backend auto-deploy/public routing off during initial setup.
   **Never expose the new API before migrations and readiness pass.** A failed
   pre-migration server boot is expected, not a reason to reset schema.
3. Obtain actual HTTPS Vercel origin, stable API domain if available, backup
   destination, maintenance owner and approved Care provisioning path. No live
   origin/accounts/credentials were supplied or inspected in Arena.
4. Prepare PostgreSQL CLI tools matching the server major and Python ≥3.11 on
   an approved operator host for backups and evidence verification. The runtime
   image deliberately does not include these administration tools.

## 1. Provision PostgreSQL FIRST

1. Create the Railway project/environment, then add PostgreSQL (not Backend).
2. Confirm the chosen PostgreSQL major, supported extensions, disk capacity,
   backup features and **persistent database volume** in Railway's service UI.
   PostgreSQL data-directory layout is version-dependent; use the database
   image's correct PGDATA mount. Never guess the PG18 layout from a PG16 example.
   Record database image/version and actual persistent mount. A running
   PostgreSQL process is not proof that persistence/backups are configured.
3. Prefer service-to-service private networking. Obtain internal hostname/port,
   database name and transport/TLS requirements from that service's settings.
   Do not hardcode private addresses in Git or copy a public URL into logs.
4. Create migration/owner and runtime roles using the least-privilege procedure
   below. Use platform-managed secrets; do not paste passwords into terminal
   command arguments or SQL files. Never print `DATABASE_URL` or `env`.
5. Validate connectivity from a one-shot process in the same Railway environment.
   Test TLS and extensions before connecting the API. If private networking is
   unavailable in a platform pre-deploy phase, use a private-network one-shot
   service from the identical image; do not silently fall back to a public DB.

## 2. Roles: schema needs and reviewed provisioning example

Canonical migrations use `public`, tables, indexes, foreign/check/exclusion
constraints, sequences, PL/pgSQL functions/triggers and standard PostgreSQL
extensions **pgcrypto** (0230) and **btree_gist** (0278 and later). These are
existing PostgreSQL extensions, not Railway dependencies. No new extension is
introduced. The migration role needs ownership of the objects it changes,
CREATE/USAGE on public and ability to install those trusted extensions in this
database (or have the DBA install them first). Runtime needs DML on business
tables, sequence access and SELECT on migration history; it does **not** need
DDL, superuser, CREATEDB, CREATEROLE or permission to rewrite history.

For a **new dedicated database only**, an authorized DBA may use the following
reviewed pattern. Adapt ownership for an existing/restored database; do not
blindly transfer all objects in a shared database. Connect interactively with
`psql -X -v ON_ERROR_STOP=1 -v db_name='<dedicated-db-name>'` using a protected
passfile/private connection. `\password` prompts, not plaintext SQL, set secrets.

```sql
CREATE ROLE hm_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
\password hm_migrator
CREATE ROLE hm_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
\password hm_app
GRANT CONNECT ON DATABASE :"db_name" TO hm_migrator, hm_app;
GRANT CREATE ON DATABASE :"db_name" TO hm_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO hm_migrator;
GRANT USAGE ON SCHEMA public TO hm_app;
```

Run canonical migrations **as hm_migrator**, then as that role grant the runtime
permissions on its newly owned objects:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hm_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hm_app;
REVOKE INSERT, UPDATE, DELETE ON schema_migrations, schema_foundation FROM hm_app;
GRANT SELECT ON schema_migrations TO hm_app;
ALTER DEFAULT PRIVILEGES FOR ROLE hm_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hm_app;
ALTER DEFAULT PRIVILEGES FOR ROLE hm_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO hm_app;
```

Re-audit grants after each release/restore; default privileges apply only to
objects created by that owner. Functions retain PostgreSQL's default EXECUTE
privileges; if your hardening revokes them, inventory required trigger/function
execution and grant it explicitly rather than dropping triggers. API authorization
remains the business boundary; a database login is never a Care permission.
This is one application-wide runtime role, not per-Care-user database roles.

## 3. Create Backend service, keep it private/stopped

1. Connect **Handyman-Backend** GitHub source at the approved release. Do not
   connect the Frontend repository. Railway uses `railway.json` → `Dockerfile`.
   Build = `npm ci` + `npm run build`; runtime = `node dist/server.js`.
2. Set `NODE_ENV=production`, `API_PREFIX=/api/v1`, explicit `DB_HOST/PORT/NAME`,
   **runtime** `DB_USER/DB_PASSWORD`, and approved `DB_SSL`. Railway database
   reference fields must map to these names; `DATABASE_URL` alone is ignored.
3. Set exact HTTPS `CORS_ORIGINS`, `LOG_LEVEL=info`, providers `noop`, and
   `SCHEDULER_ENABLED=false` until authorized activation. See matrix for the
   complete settings. No JWT/session signing secret is used by this flow.
4. Set one API replica (also specified in `railway.json`); disable autoscaling,
   multi-region copies and deployment overlap. A process singleton prevents
   duplicate timers **inside one process only**. Dispatcher claims exist, but
   this rollout does not certify all jobs across replicas. Stage 1 uses one.
5. Add a **Railway Volume** to Backend at `/app/.data/evidence`; set
   `EVIDENCE_STORAGE_DRIVER=local` and `EVIDENCE_STORAGE_DIR=/app/.data/evidence`.
   This root contains `evidence/` and `reports/`. Keep the same mount through
   redeploy. Railway volumes can constrain replicas/zero-downtime deploys; accept
   a controlled restart rather than mount different writable copies.
6. Runtime is non-root `node` (standard image UID/GID 1000:1000; verify the built
   image with `id`). Verify mounted volume ownership **after attachment**. Image
   directory chown does not guarantee a mounted volume's ownership. If required,
   perform an approved one-time `chown -R 1000:1000 <actual-volume-root>` using a
   private maintenance container after checking the mount. Do not run the API
   as root or use chmod 777 to bypass it.
7. Verify the platform volume attachment in its UI and read/write checks under
   the node user. The boot probe only proves a writable path: an absent volume
   can leave a writable ephemeral directory and still pass. Persistence requires
   the explicit mount plus restart/redeployment evidence described below.

## 4. Run exactly one authorized one-shot migration

Choose **one** execution path, never both:

- Preferred initial deployment: a private one-shot service/job using the same
  image/release and **migration-role** `DB_*` variables, with no public domain,
  no restart loop and scheduler false. Command:
  `node dist/database/cli.js migrate`. Wait for exit **0**, retain sanitized log.
- Platform pre-deploy hook is acceptable only if its current behavior provides
  private DB networking, exactly one runner, failure-blocking promotion and
  separate migration secrets. No such hook is wired in `railway.json`; do not
  add the owner password to the normal API environment for convenience.

Then with migration credentials execute:

```sh
node dist/database/cli.js status
```

Confirm all **450** canonical IDs applied through
`0450_handyman_care_building_authority_permission` and
`0451_handyman_care_communications`, no unknown IDs. Registry is
`src/database/migrations/index.ts`; **0449 is unclaimed**, gaps are valid.
Save ordered `SELECT id, applied_at FROM schema_migrations ORDER BY id` output
privately. Status reports history and may create an absent history table; it is
an operator command, not the runtime readiness implementation.

The runner uses a database-session advisory lock and refuses a concurrent runner
immediately. Each migration and its bookkeeping commit in one transaction;
re-running up skips committed IDs. A failed migration can leave earlier migrations
committed. Stop promotion, inspect the error/failed ID and repair through an
approved forward fix; **never reset, seed, drop/recreate schema or run down** to
make a healthcheck green. Unknown newer IDs block migration-up and readiness;
use the matching artifact. The API never runs migrations or seeds itself.

Apply reviewed runtime grants, then remove migration secrets from transient jobs
according to policy. Keep a controlled operator recovery path.

## 5. Start Backend → health → persistence

1. Start the sole API with runtime credentials. No HTTP listener or scheduler is
   admitted until connectivity, exact migration history and writable evidence
   storage pass. Startup fails without an endless retry loop.
2. Railway's deployment healthcheck is `/api/v1/health/database`, timeout 300s,
   restart-on-failure max 5. Keep `/api/v1` prefix or explicitly update platform
   checks. This setting gates promotion, not continuous production monitoring.
3. In a private smoke or once public routing is approved, verify:

```sh
curl --fail --silent --show-error 'https://<api-domain>/api/v1/health'
curl --fail --silent --show-error 'https://<api-domain>/api/v1/health/database'
```

Liveness returns 200 without DB access. Database readiness requires both a DB
query and exact migration history; a temporary outage yields sanitized 503
`DATABASE_UNAVAILABLE`, while liveness stays 200. Recovery uses the existing pg
pool on later probes; no database initialization occurs. There is no ongoing
storage-volume monitoring in this HTTP endpoint.
4. Perform an approved non-sensitive evidence upload, record its request/evidence
   IDs and SHA-256, restart then redeploy the service with the same volume, and
   download bytes to compare hash. Verify metadata, history and report namespace
   if used. A successful writable-path probe alone is **not** this test.
5. Enable `SCHEDULER_ENABLED=true` only for the sole active service after data and
   provider policies are approved. Use stop-before-start deployment maintenance;
   do not overlap old and new schedulers. Supervisor termination grace must exceed
   the application's 25s deadline (recommend ≥30s).

## 6. Provision real Care staff through approved administration

An authorized administrator, **not Arena**, must provision/verify:

- Real local Handyman staff User **ACTIVE**, valid password credential.
- Explicit `handyman.care.building` capability. Migration 0450 grants it to **no
  role** automatically. Generic `tenant_company.manage` is not a substitute.
- ACTIVE `user_building_assignments` for the **exact** Building; ACTIVE Building,
  Property and Client lineage. No same-Client sibling shortcut.
- Authorized service requests and non-sensitive presentation data. Do not seed
  production automatically. Seed CLI exists but is never a deployment step.
- For intake evidence list/upload also the existing `tenant_company.read` /
  `tenant_company.manage` permissions as appropriate, and byte download
  `evidence.read` (file administration `evidence.manage` only if genuinely needed).
  Grant narrowly through the existing role/assignment model, not a generic admin
  role. Care permission by itself does not unlock these separate evidence routes.

## 7. Vercel connectivity and presentation smoke

Frontend owner configures their existing API base URL to `https://<api-domain>`
using their actual variable name (not established by this Backend-only audit).
HTTPS everywhere. Prefer stable custom domain over platform service URLs.
Check the **real browser** Network panel and preflight, not just curl:

```sh
curl --silent --show-error --include -X OPTIONS \
  'https://<api-domain>/api/v1/auth/login' \
  -H 'Origin: https://<actual-vercel-origin>' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization,content-type,x-request-id'
```

Expect exact allow-origin, permitted methods/headers, no wildcard and no
allow-credentials. Login returns `data.sessionToken`; send it only in
Authorization headers, never URL/query/logs. Do not put live tokens/passwords
in shared curl history or screenshots. Logout must revoke that session.

All paths below are verified from Backend source, relative to `/api/v1`:

| Step | Method/path | Expected check |
|---|---|---|
| Login | POST `/auth/login` | JSON email/password; real staff authenticates |
| Identity | GET `/auth/me` | authenticated staff, correct permissions |
| Building | GET `/handyman/care/buildings` | only exact assigned active Building |
| Requests | GET `/handyman/care/buildings/{buildingId}/requests` | authorized request list |
| Detail | GET `/handyman/care/buildings/{buildingId}/requests/{requestId}` | allow-listed detail |
| Progress | GET same request path + `/progress` | operational progress, not decision execution |
| Record | POST same request path + `/communications` | one scoped communication; replay idempotent |
| History | GET same request path + `/communications` | saved communication and evidence IDs |
| Intake evidence | GET/POST `/handyman/requests/{handymanRequestId}/intake-evidence` | request-owned, not a Care-path alias |
| Evidence bytes | GET `/evidence/{evidenceId}/file/content` | authenticated authorized bytes |
| Logout | POST `/auth/logout` | revoked; subsequent me is denied |

Intake POST is multipart `file` + `evidenceKind=PHOTO|VIDEO`, up to 50 MB with
source MIME allowlist; request must be **INTAKE**. `JSON_BODY_LIMIT` does not
increase multipart limit. Existing request evidence can be selected for a
communication at other operational stages. Communication POST fields include
`purpose=SERVICE_REQUEST_FOLLOW_UP`, `reportedContactName`, `channel=PHONE`,
`statement`, unique `idempotencyKey`, and `evidenceIds` of ACTIVE evidence owned
by that exact request. It records reported communication, not Tenant approval.
No speculative `/care/.../intake-evidence` alias is added.

Presentation: Care Login → Authorized Building → Request List → Detail → Progress
→ Communication POST (with selected existing evidence, if required) → Evidence
selection/readback → History → Logout. If the UI selects evidence before POST,
that is expected because evidenceIds are part of the POST; this API has no
speculative attach-later endpoint. Verify sibling Building and inactive access
are denied. BM Super App is not needed.

## 8. Release decision

Complete the GO/NO-GO checklist, including live persistence and tested backup
restore. Connect external readiness/error/disk/DB monitoring. Source validation
in Arena is **not** Railway/Vercel live E2E. Until these operator checks are
complete, live Stage 1 is **NO-GO**, even if the source is ready for deployment
preparation. Do not deploy simply to close this CR.
