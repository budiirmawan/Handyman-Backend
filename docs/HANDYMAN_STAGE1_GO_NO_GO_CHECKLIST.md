# Stage 1 Railway GO / NO-GO checklist

CR-HM-DEPLOY-PORTABILITY-01 · 2026-10-17.
**Current verdict: source prepared for review/operator rehearsal; LIVE Stage 1
NO-GO until every required operational gate below has evidence and an owner.**
No Railway/Biznet/Vercel live test, real account creation, production migration,
production data change or deployment was performed from Arena.

## A. Source/release evidence

- [x] Clean baseline verified on `arena/56bc7428-handyman-backend`; HEAD and fetched
  origin/main both `da78bbb4cc791650787e207d8288204abc86c439` before changes.
- [x] Backend-only source inspection; Frontend repository not accessed.
- [x] TypeScript typecheck and production build pass on Node 22.22.3.
- [x] Existing tracked `node_modules` left unchanged (baseline repository content);
  Docker excludes it and builds with `npm ci` from the lockfile. New ignores do
  not retroactively untrack dependencies; no unrelated bulk cleanup was made.
- [x] Production artifact design: Node 22 multi-stage non-root dist-only Dockerfile,
  locked npm dependency install, no secrets baked into build context.
- [x] Canonical migration registry: 450 IDs, latest 0451; 0450 included, 0449
  unclaimed. No new schema migration introduced by this CR.
- [x] Explicit one-shot migration, advisory lock, per-ID transactional bookkeeping,
  pending/unknown history fail-closed startup/readiness; no boot seed/reset/down.
- [x] Local disposable DB, outage/recovery, failure/lock/shutdown, storage tooling,
  Care HTTP and CORS checks pass; see validation record below.
- [ ] PR reviewed/approved and production release SHA/image digest recorded.
- [ ] Docker build/image smoke on a host with Docker; validate node UID and image.
- [ ] Rehearse on the **actual chosen PostgreSQL major** (local engine was 18.4;
  Compose example uses 16; Railway version has not been selected/inspected here).

## B. Database BEFORE API

- [ ] Railway project/environment created by approved operator; DB provisioned first.
- [ ] Correct PGDATA persistent volume and capacity verified in platform settings.
- [ ] Private DB networking and TLS/certificate policy tested from workload network.
- [ ] Runtime vs migration credentials separated; reviewed owner/schema/table/
  sequence/function grants applied and runtime denied DDL/history modification.
- [ ] Exactly one migration job from the release artifact exits 0; all 450 canonical
  IDs/applied_at verified, no pending/unknown IDs; no seed or schema reset used.
- [ ] Runtime can connect/query business data; database ready before public routing.
- [ ] Capacity budget: max 10 connections per API, migration/backup/admin headroom.
- [ ] Native pg_dump/pg_restore paired recovery rehearsal exits 0 and schema,
  ownership/grants, indexes/constraints/triggers, history and row counts verified.

## C. Evidence bytes, not just metadata

- [ ] Backend Railway Volume mounted at `/app/.data/evidence`, same env path.
- [ ] Verify actual attachment and non-root UID permissions **after** mounting.
- [ ] File manifest + metadata reference CSV verified, no unexplained missing,
  corrupt, symlinked, unmanaged or external/legacy references.
- [ ] Approved upload/download hashes survive **restart and redeployment**; both
  evidence and reports namespace accounted for. Writable boot probe is insufficient.
- [ ] Actual Railway volume export/backup access exercised by approved helper.
- [ ] Paired off-host encrypted DB + evidence backup and restore drill complete.
  Successful database dump is not proof evidence was backed up.

## D. Runtime/health/scheduler/security

- [ ] Production environment values from matrix set; no URLs/secrets in Git/logs.
- [ ] HTTPS stable API domain/certificate and reverse-proxy upload limits verified.
- [ ] Liveness `/api/v1/health` and readiness `/api/v1/health/database` both 200.
- [ ] Controlled DB outage makes readiness 503 and recovery returns 200; do not
  conduct a production outage without its own authorization/maintenance plan.
- [ ] One API replica/region, no old/new deployment overlap; sole scheduler enabled
  only after activation. Target migration/rehearsal scheduler remains false.
- [ ] Stop-before-start/restart plan, ≥30s supervisor grace and bounded restart
  policy; no resets/seeds/down/infinite retries as recovery.
- [ ] Monitoring/alert destinations, backup owners, capacity/connection thresholds,
  restore results and incident escalation assigned.

## E. Real Care staff + actual Vercel browser (mandatory live checks)

- [ ] ACTIVE real local staff User and valid credential; no fabricated BM actor.
- [ ] Dedicated `handyman.care.building` explicitly granted; not automatically
  granted by migration or substituted with tenant-company administration.
- [ ] ACTIVE exact Building assignment, ACTIVE Building/Property/Client lineage.
- [ ] Approved service requests/demo data; minimum extra evidence permissions as
  required by the existing routes. No automatic production seed.
- [ ] Actual Vercel production origin confirmed; exact `CORS_ORIGINS` set. Actual
  Frontend API config/domain confirmed by Frontend owner without modifying it here.
  CR-HM-BE-CORS-PRODUCTION-01 confirms the origin as
  `https://handyman-frontend-alpha.vercel.app`, so the Railway value is exactly
  `CORS_ORIGINS=https://handyman-frontend-alpha.vercel.app` — no wildcard, no
  trailing slash, no path. Handoff and the reproducible preflight command:
  `docs/CR-HM-BE-CORS-PRODUCTION-01_CORS_DEPLOYMENT_HANDOFF.md`.
- [ ] Browser HTTPS preflight allows Content-Type, Authorization, X-Request-ID
  and Idempotency-Key; no wildcard credentials; sibling preview origins remain
  unlisted unless approved.
- [ ] POST `/api/v1/auth/login` → GET `/api/v1/auth/me` identifies actual staff.
- [ ] GET Care buildings → authorized request list → detail → progress.
- [ ] Evidence selection lists ACTIVE exact-request-owned submissions; intake upload
  only on INTAKE request via existing request-owned route, not an invented alias.
- [ ] Communication POST (idempotent retry) → GET history shows correct staff,
  request, Building and evidence IDs. No Tenant approval/financial mutation occurs.
- [ ] Evidence bytes download authorized and SHA-256 checked; sibling Building /
  wrong request / inactive assignment denied.
- [ ] Logout revokes bearer session; subsequent authenticated call denied.
- [ ] Full live presentation journey signed off; no BM Super App dependency.

## F. Final decision record (operator fills)

Release SHA/digest: __________  Date/window: __________
DB version/extensions: __________  Volume IDs/mounts: __________
Actual Vercel/API origins: __________
Backup pair/restore drill record: __________
Care E2E evidence (redacted): __________
Monitoring and rollback owners: __________
Approver / GO decision: __________

**NO-GO** if any required database, migration, persistent evidence, authorization,
CORS, live E2E, monitoring or validated recovery gate is missing. Unit/mock/local
HTTP PASS cannot check the live boxes. Known optional legacy test discrepancy
below is not a reason to weaken authentication.

## Focused validation record (Arena, 2026-10-17)

| Check | Result | Evidence / limitation |
|---|---|---|
| TypeScript | PASS | `npm run typecheck` |
| Production build | PASS | `npm run build`; compiled server used in subprocess tests |
| Docker build/container/Compose runtime | SKIPPED | no Docker CLI/daemon available; source wiring inspected only |
| PostgreSQL fresh bootstrap/history/up idempotence | PASS | disposable embedded PostgreSQL 18.4; 450 registry IDs |
| Concurrent runner exclusion | PASS | independent DB session holds lock; second runner rejected; release/retry works |
| Migration failure bookkeeping | PASS | temporary test migration DDL + history roll back; lock released; no source registry change retained |
| Pending/missing/unknown history | PASS | listener refuses initial empty schema; readiness 503 for pending/unknown; no automatic history creation by app |
| Startup DB unavailable/config failures | PASS | compiled process exits 1, no secret output; malformed DB port/unsupported storage/unwritable path tested |
| Temporary DB outage/restoration | PASS | liveness 200, readiness 503, same pool recovers to 200 after PG restart |
| Graceful HTTP/pool shutdown | PASS | compiled server SIGTERM exits 0 with pool closed; overall deadline inspected |
| Read-only history permission | PASS | non-owner role with SELECT-only history passes readiness |
| Storage config/local bytes | PASS | temp-root storage tests, transfer round-trip, corruption/missing/hash/traversal/symlink/nonempty destination rejection |
| Metadata export SQL | PASS | SELECT branches executed against disposable migrated DB; key/sha256/size columns confirmed |
| Scheduler boot/stop guards | PASS | existing focused scheduler tests; test environment forced off |
| CORS | PASS | exact synthetic HTTPS Vercel-shaped origin preflight + disallowed sibling origin + wildcard rejection; `tests/deployment-cors-production.test.ts` covers the confirmed production origin `https://handyman-frontend-alpha.vercel.app`, the `Idempotency-Key` preflight and the refused sibling preview origin. Live Railway/Vercel preflight still SKIPPED below |
| Care HTTP | PASS (LOCAL) | embedded real DB, existing discovery/communication auth and denial tests; external DB intake scope/file API tests also pass |
| Native database dump/restore | SKIPPED | pg_dump/pg_restore/psql clients unavailable; runbook requires actual rehearsal |
| Railway/Biznet/Vercel integration, mounted-volume redeploy | SKIPPED | unauthorized/unavailable live infrastructure; never claimed tested |
| Existing unknown-route assertion | FAIL, reproduced on baseline | `tests/health.test.ts` expects anonymous unknown route 404 but actual is fail-closed 401 with unchanged baseline health router; unrelated to readiness change, not a business/security fix here |

Final focused command (after source changes), **72 passed, 0 failed, 0 skipped**:

```sh
NODE_ENV=test LOG_LEVEL=error npx tsx --test --test-concurrency=1 \
  tests/deployment-portability.test.ts tests/deployment-cors.test.ts \
  tests/config.test.ts tests/evidence-storage-readiness.test.ts \
  tests/cr-be-stab-01-due-job-scheduler.test.ts \
  tests/handyman-care-standalone-discovery-http.test.ts \
  tests/handyman-care-communications-http.test.ts
```

Additional disposable PostgreSQL at loopback port 57311 was bootstrapped and
migrated for existing DB-dependent tests. With local-only DB_* settings:
`tests/deployment-cors.test.ts tests/security.test.ts tests/database.test.ts
 tests/evidence-file-api.test.ts tests/handyman-intake-evidence-scope-guard.test.ts`
ran serially: **30 passed, 0 failed, 0 skipped**. These groups overlap (do not
sum them as unique coverage). `python3 tests/evidence-transfer.test.py`: **4
passed**. `git diff --check`: PASS. An earlier run had 9 skipped intake tests
without a local DB; they were subsequently run with disposable DB and all passed.

The existing health file's liveness/connected/readiness-unavailable checks passed;
its unrelated anonymous-unknown-route assertion above failed and was reproduced
using the baseline health router. No unrelated full legacy/domain suite was run.
Early new-test failures due to embedded PG deleting its test directory on stop
and an unsuitable /proc test fixture were corrected in the test harness; the
final tests above pass. No production schema migration was added or run.
