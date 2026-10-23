# CR-HM-BACKEND-RELEASE-INTEGRATION-01 — PART 02
# FINAL REVIEW & RELEASE PR

| Field | Value |
| --- | --- |
| Artifact | Handyman Backend — release candidate for controlled Coolify (Biznet) deployment |
| Branch | `arena/44decf3c-handyman-backend` |
| Base | `main` @ `e8b94af426d5d730900d98716135a7114e62e097` |
| Audit tip | `6f90266` (product code identical to PART 01 tip `3e5c40a`; only test tooling was added after it) |
| Reviewed at | 2026-10-23 |
| Product diff vs `main` | 178 files, +51,119 / −706 (the delta over PART 01's +50,814 is test-only) |
| Integrated sources | PR #55 `30be708e` · IAM revocation `63f3a851` · PR #56 `8f549dc9` — **all three are already integrated here** |
| Excluded by instruction | PR #47 (finance bank receipt attestation) — verified absent |

---

## 0. Verdict

> **GO** — the release candidate passes every gate that can be executed from
> this environment. One condition is attached and is operational, not
> technical: deploy behind a reviewed Coolify proxy with
> `CORS_ORIGINS` pinned to the exact Vercel origin, `EVIDENCE_STORAGE_DIR`
> backed by a persistent volume, and a verified backup pair taken immediately
> before `db:migrate:prod`.
>
> Nothing was merged, deployed, or run against a production database as part
> of this review.

| Gate | Scope | Result |
| --- | --- | --- |
| A | Final integration audit | **PASS** (A1–A7) |
| B | DB release gate (PostgreSQL 18) | **PASS** — 21/21 harness checks |
| C | Operational E2E gate | **PASS** — 11/11 merged seams + 17-step lifecycle suite |
| D | Release readiness | **PASS** — 343 focused assertions, 0 skipped |
| E | Delivery | Integration PR opened; PR #55/#56 need no further merge |

**Blockers: 0. Non-blockers: 5. Deferred: 6.**

---

## A. Final integration audit

### A1. Repository state

* `HEAD` = the FINAL REVIEW tip on `arena/44decf3c-handyman-backend`; `origin/main` = `e8b94af`.
* The branch is a strict fast-forward candidate: `main` contains no commit that
  the branch lacks (`git rev-list --count HEAD..origin/main` = 0).
* Working tree clean before the review commit; `dist/` untracked and ignored.
* The three sources are still ancestors of `HEAD`:
  `30be708e` (PR #55), `63f3a851` (IAM revocation), `8f549dc9` (PR #56).

### A2. Nothing lost from any source

| Check | Result |
| --- | --- |
| Files deleted vs each source branch | **0** for all three |
| Files a source *added* and this branch still carries byte-identically | **all** |
| Key artifacts present (services, routes, migrations, docs, tests) | all present |
| Files present here but owned by the integration | 7 (4 release docs + 3 release test files) — expected, no source content |

### A3. Conflict re-audit (the 11 conflicted files)

20/20 expected symbols from both sides are present at their reviewed
signatures; the assignment router registers 7 routes over 6 distinct paths
(`/work-orders/:id/assignments` carries GET + POST). Each of the four
assignment event types has exactly **one** emission site. No conflict marker,
duplicated registration, or dropped branch remains in the tree.

### A4. One authoritative transaction

`assignWorkOrder` and `reassignWorkOrder` both run inside a single
`withTransaction`: `SELECT … FOR UPDATE` on the work order → insert assignment
→ competency gate (decision row) → `ensurePendingForAssignment` → operational
event → IN_APP notification. Reassignment adds the status transition and
`recordSupersededEvent`. A refusal (competency, RBAC, isolation) rolls the
whole unit back — proven by S9 (rollback) and S10 (concurrency) in the E2E gate.

### A5. Contract and authority

* `vendor_id: string | null` (DIRECT workforce needs no vendor);
  `target_helper_user_id` nullable with `hasMobileAccount = helperUserId !== null`
  (Helper without login is first-class).
* Reimbursement is personal-funds only: both
  `handyman_material_reimbursement_personal_funds_only_chk` and
  `…_approval_gate_chk` exist in the upgraded schema.
* RBAC revocation takes effect without re-login (permission check is per
  request, not baked into the session).
* No business-authority change was introduced by conflict resolution: the
  reviewed authority owners are unchanged, and the parity suites that pin
  `x-required-permission` still pass.

### A6. No duplicates

| Surface | Result |
| --- | --- |
| Runtime routes (composed app, WhatsApp router included) | 2,034 total / 2,033 distinct — the only duplicate is the **pre-existing** `GET /tasks/{p}` normalization artifact |
| Registered migrations | 470, strictly ordered, 0 duplicate ids, `0469` absent |
| Assignment event emissions | 1 site per event type |

---

## B. DB release gate — 21/21 PASS

Disposable **PostgreSQL 18.4** only; no production connection.

| Scenario | Evidence |
| --- | --- |
| Fresh install | 470 migrations, tip `0472_handyman_assignment_responses` |
| History integrity | applied set == registered set; no `0469` |
| Re-run | 0 migrations re-applied (idempotent) |
| Biznet representation (`…0460`) | 459 migrations, upgrade applies **11** |
| Physical schema comparison | **16,982 vs 16,982 objects; only-fresh 0; only-upgraded 0** |
| Ledger fingerprint | `04a633b62936842c…` identical on both build paths |
| Data preservation | users, roles and password hashes byte-identical; historical assignments intact; provider contexts default to VENDOR (direct is additive) |
| Permissions | 15 → 18 rows |
| `0472` repair | stale notifications CHECK repaired without destructive rollback |
| Failure behaviour | a conflicting object **fails** the run (does not skip): history stops at 463, failing migration not recorded, later migrations never ran, no partial DDL survives |
| Recovery | forward recovery applies the remaining 7 → 470/470 at the canonical tip, no down-migration |

Failure and recovery are therefore *audited*, not assumed: the only supported
recovery is **forward** (fix + re-run). `migrateDown` is never part of it.

---

## C. Operational E2E gate

`tests/release-integration-merged-e2e.test.ts` — **11/11**

S1–S9 cover the lifecycle seams: Tenant → Customer Care → Service Request →
Work Order → Operations classification → competency-gated assignment → IN_APP
notification → TERIMA / TIDAK_BISA → reassignment → QR/GPS arrival → helper
attendance → photo evidence → material receipt → reimbursement → QC → closure.
S9 is the transaction-rollback negative case.

| Added this review | What it proves |
| --- | --- |
| S10 — concurrency | Two simultaneous assignments produce exactly one `201` + one `409`, one ACTIVE row, one PENDING response, one competency decision. No double write, no lost update. |
| S11 — superseded | Responding to a superseded assignment returns `409`; the response row is preserved and the append-only ledger holds `ASSIGNMENT_PENDING_CREATED → ASSIGNMENT_SUPERSEDED` with `previous_status = PENDING`. Supersession is an **event**, never a mutable status. |

Negative coverage in the same gate: RBAC denial, Client/Building isolation,
transaction rollback, duplicate-response replay, and the two cases above.

---

## D. Release readiness

### D1. Build gates

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | exit 0 |
| Build | `npm run build` | exit 0 (emits `dist/server.js`, `dist/database/cli.js`) |
| Focused matrix | 29 suites | **311/311 tests, 0 failed, 0 skipped** |
| Legacy reconciliation | 3 previously-skipped suites | **32/32 executed, 0 skipped** (see §D2) |
| OpenAPI parity | 3 suites | pass — 2,032 operations / 1,532 paths / 2,312 schemas / 0 duplicate operationIds |
| Migration harness | `tests/manual/release-integration-migration-check.ts` | 21/21 |
| Merged E2E | `tests/release-integration-merged-e2e.test.ts` | 11/11 |

Total focused assertions at this tip: **343**, none skipped.

The full repository suite was deliberately **not** run (instruction), so this
report claims coverage of the release surface only, never of all 850 suites.

### D2. The two legacy baseline failures — reconciled, not hidden

| Suite | Was | Cause | Now |
| --- | --- | --- | --- |
| `handyman-scope-assignments-api` | red on `main` | stale PART C namespace guard | 10/10 — guard kept, whitelist of separately-governed response routes refreshed |
| `openapi-operational-final-parity` / `…-structural-closure` | red on `main` | census pins superseded by later PARTs | 7/7 and 8/8 — numbers refreshed, arithmetic still 1,963 + 69 |

Both guards **still fail** on a genuinely new unmatched route; only the
expected inventory changed. Coverage was not weakened.

### D3. The three skipped suites — now executed, not relabelled

`work-order-assignment` (20), `handyman-evidence-commands` (7) and
`evidence-file-api` (5) skip themselves whenever no PostgreSQL answers, which
made "not tested" look like "pass". They are now run for real against a
disposable PostgreSQL 18 cluster by
`tests/manual/release-integration-legacy-suite-check.ts`, which **also pins the
expected test counts**: if a suite ever skips again, the gate fails instead of
silently shrinking.

Result: 20/20, 7/7, 5/5 — **32/32, 0 skipped**. Residual risk from the old skip
register is closed.

### D4. Security checks

| Check | Result |
| --- | --- |
| Tracked secrets / `.env` | none; only `.env.example` with placeholders. `.env*` and `.data/` ignored |
| Hard-coded credentials in `src/` | none found |
| Security headers | `helmet` (CSP off — no browser UI, CORP cross-origin), `x-powered-by` disabled |
| CORS | exact-origin allowlist from `CORS_ORIGINS`; empty by default in production |
| Session tokens | opaque random, stored as SHA-256 hashes (`user_sessions`) |
| SQL construction in release modules | all user input bound as `$n`; the only dynamic SQL joins fixed, pre-parameterised fragments |
| Evidence upload | `multer` memory storage, 1 file, 50 MB cap matching the DB constraint |
| Prompt-injection / model surfaces | none — no LLM or shell execution on request paths |

`npm audit --omit=dev` reports **7 advisories (3 moderate, 3 high, 1 critical in
`proxy-addr`)**. `package.json` / `package-lock.json` are **identical to
`origin/main`**, so every advisory is inherited, not introduced. They are
recorded as non-blockers with a remediation path (§F), not silently ignored.

### D5. Contract parity with Mobile and Operations

* All **31** release-related OpenAPI operations are documented in
  `MOBILE_API_HANDOFF.md` (§7 certifications, §8 helper attendance) or the
  per-CR handoff under `docs/handyman/` (assignment response, classification,
  competency decisions). Undocumented release paths: **0**.
* Backend↔Mobile field-level contract is pinned by
  `mobile-assignment-contract` (18/18) and `handyman-assignment-response-part02{a,b,c}`.
* Operations contract is pinned by `work-order-classification-03b2e` (19/19),
  `work-order-multitrade-03b2a` (17/17), `work-order-multiskill-03b2b` (11/11)
  and `handyman-direct-workforce-03b2d` (20/20).
* `WorkOrderAssignment` exposes `responseStatus`, `respondedByUserId`,
  `respondedAt`, `declineReason`, `responseNotes`, `reassignmentRequired`;
  enum is exactly `PENDING | TERIMA | TIDAK_BISA`.

### D6. Environment, storage, database, backup, migrator, Coolify

| Area | State | Release requirement |
| --- | --- | --- |
| Env vars | No new variable is read by any release module; `.env.example` and `docs/HANDYMAN_DEPLOYMENT_ENV_MATRIX.md` already list every key the config parser reads | Set `NODE_ENV=production`, `PORT=3000`, six `DB_*`, `CORS_ORIGINS=<exact Vercel origin>`, `EVIDENCE_STORAGE_DRIVER=local`, `SCHEDULER_ENABLED=false` during migration |
| Evidence storage | Local driver only; image pins `EVIDENCE_STORAGE_DIR=/app/.data/evidence`; boot probe proves writability and **aborts** startup otherwise | Mount a persistent volume at that exact path — the probe cannot prove attachment |
| PostgreSQL | Pool max 10, idle 30 s, connect timeout 5 s; migrations serialise on `pg_try_advisory_lock`; sizing floor 2 vCPU / 4 GiB / 60 GiB, recommended 4 vCPU / 8 GiB / ≥100 GiB | Private network only; never publish 5432 or 3000 |
| Backup | `docs/HANDYMAN_DATABASE_EVIDENCE_BACKUP_RECOVERY.md`: paired DB + evidence capture, pg_dump custom format, restore drill with `--exit-on-error --single-transaction`, monthly drill | Take a verified pair **before** the migration; daily RPO ≤ 24 h unless PITR is separately approved |
| Migrator | Explicit one-shot `node dist/database/cli.js migrate` (`db:migrate:prod`); the server never auto-migrates; readiness (`/api/v1/health/database`) refuses traffic when the applied set ≠ the artifact's set | Run twice: first applies 11, second applies 0 |
| Coolify / image | Node 22 multi-stage, `npm ci --omit=dev` runtime, non-root `node`, curl installed for healthcheck, `railway.json` healthcheck path `/api/v1/health/database`, compose mounts `handyman-evidence` | Build the image from the **merge commit** of this PR; deploy as a release, not a roll |

---

## E. Delivery

* One integration PR from `arena/44decf3c-handyman-backend` → `main`.
* **PR #55 and PR #56 are already integrated sources** of this branch — after
  this PR merges they must not be merged again (each is an ancestor of the
  branch, so a second merge is a no-op that only muddies history). The IAM
  revocation line has no PR of its own.
* No production migration, deployment, password change or merge into `main`
  was performed in PART 02.

---

## F. Risk split

### BLOCKERS — 0

No confirmed blocker. Every gate that can be executed here is green, and the
failure/recovery path is audited rather than assumed.

### NON-BLOCKERS — 5

| # | Item | Why it does not block | Owner action |
| --- | --- | --- | --- |
| N1 | 7 inherited dependency advisories (1 critical `proxy-addr`) | dependency set identical to `main`; not a regression of this release | schedule `npm audit fix` in a dedicated dependency CR (breaking upgrades need the full suite) |
| N2 | Login throttle keys on the socket IP, and `TRUST_PROXY` is deliberately not implemented | no behaviour change in this release; documented in the env matrix | rate-limit `/auth/login` at the Coolify proxy, and treat a cluster of `429`s as a single shared bucket (10 failures / 15 min across all clients) |
| N3 | `GET /tasks/{p}` duplicate registration | pre-existing on `main`, collapses to one OpenAPI operation, encoded in the parity arithmetic | none for this release |
| N4 | Evidence volume attachment cannot be proven by the boot probe | probe proves writability only; a missing mount still passes | verify the mount from inside the running container during smoke test |
| N5 | Competency gate can refuse assignments when no requirement/qualification exists | intentional authority, not a defect | Operations must configure requirements and verify certificates before expecting assignments to succeed |

### DEFERRED — 6

| # | Item | Reason |
| --- | --- | --- |
| D1 | Trusted-proxy / real-client-IP support | security-sensitive; needs its own design (spoofing risk if `trust proxy` is set loosely) |
| D2 | Dependency upgrades from the audit report | needs the full suite, out of scope for a release-integration CR |
| D3 | Object storage for evidence (S3/MinIO) | local driver is the only shipped adapter; volume is sufficient for Stage 1 |
| D4 | PITR / sub-24h RPO | requires WAL archiving plus matching evidence versioning, a separately authorised operation |
| D5 | `GET /tasks/{p}` duplicate removal | pre-existing route-normalisation artifact, would touch unrelated contracts |
| D6 | Full-suite (850 suites) regression run | instruction: run only relevant focused tests |

---

## G. Preflight checklist (before `db:migrate:prod`)

- [ ] Merge commit of this PR is the image tag; record the SHA in the release note.
- [ ] Image built from that commit; `node dist/database/cli.js status` available in the image.
- [ ] Coolify: `NODE_ENV=production`, `PORT=3000`, six `DB_*` (private host, dedicated runtime role), `DB_SSL` per transport.
- [ ] `CORS_ORIGINS` = exact Vercel production origin (no wildcard, no trailing slash).
- [ ] `EVIDENCE_STORAGE_DRIVER=local`, persistent volume mounted at `/app/.data/evidence`, owned by UID 1000.
- [ ] `SCHEDULER_ENABLED=false` until the single authoritative instance is confirmed.
- [ ] Backup pair captured and **restore-verified** off-host; table counts + migration inventory recorded.
- [ ] Traffic stopped or routed to a maintenance page; no scheduler/worker writing during the migration.
- [ ] Expected history: current tip `0460_handyman_settlement_dispute_adjudication`; expected target `0472_handyman_assignment_responses`; **11** new rows; `0469` must not appear.
- [ ] Postgres version ≥ 18 on the target (the release was verified on 18.4).
- [ ] Disk headroom for build + migrate + WAL ≥ 3× current DB size.

## H. Rollback plan

1. **Application only (preferred):** redeploy the previous image. The 11 new
   migrations are additive; the previous release ignores the new tables and
   keeps working. This is the supported rollback.
2. **Migration failure:** do **not** run `down`. Forward recovery only — fix
   the cause (the harness proves a failed run leaves no partial DDL and no
   history row) and re-run `db:migrate:prod`. If the failure is not understood,
   restore the pre-migration pair into a clean database and redeploy the
   previous image.
3. **Data corruption:** stop traffic, fence writers, restore the paired DB +
   evidence backup per `HANDYMAN_DATABASE_EVIDENCE_BACKUP_RECOVERY.md` §4,
   then re-point the runtime role. Never restore over a live schema with
   `--clean`.
4. Record which backup was used, exit codes, row counts, and elapsed time.

## I. Smoke-test checklist (after `db:migrate:prod`)

- [ ] `db:migrate:prod` second run applies **0** migrations.
- [ ] `GET /api/v1/health` → 200; `GET /api/v1/health/database` → 200 (DB connected *and* history matches).
- [ ] Login with an existing password succeeds (hashes untouched); a revoked permission is refused without re-login.
- [ ] Operations classifies a Work Order (trade category) and sees the competency decision.
- [ ] Assignment of a qualified worker → IN_APP notification arrives; worker responds **TERIMA**.
- [ ] Assignment of a second worker → respond **TIDAK_BISA** with reason → reassignment offered; the superseded assignment returns 409 and its response history is intact.
- [ ] Mobile: assignment list, accept, start, arrival QR/GPS, helper attendance `HADIR`/`TIDAK_HADIR` + correction with reason, photo evidence upload and download.
- [ ] Material receipt → reimbursement submitted → approved in Finance.
- [ ] QC approval → closure; the Work Order cannot be closed before QC.
- [ ] Client/Building isolation spot-check with a second tenant; expect 404/403, never data.
- [ ] Evidence file survives a container restart (volume attachment proof).
- [ ] Watch: assignment p95 latency, `notifications` growth, `429` rate on `/auth/login`.

---

## J. Explicit non-actions

* No PR merged, nothing deployed to Coolify/Biznet/Railway.
* No production database read, migrated or modified.
* No password or credential changed.
* PR #47 not integrated.
* Full repository suite not executed.
