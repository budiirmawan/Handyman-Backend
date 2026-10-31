# CR-HM-CARE-E2E-RELEASE-01 — PART 10 Delivery

Staging readiness and browser E2E verification for Handyman Customer Care
Frontend + Backend.

- **Change request:** `CR-HM-CARE-E2E-RELEASE-01`
- **Part:** PART 10 (one part; verification and documentation only)
- **Branch:** `arena/9ab3fff8-handyman-backend`
- **Backend required HEAD:** `608991e` — **VERIFIED EXACT**
- **Frontend required HEAD:** `a366346` — **UNVERIFIABLE FROM THIS SANDBOX**
- **Source changes made:** **NONE** (documentation only)
- **Production / staging mutations:** **NONE**

> No implementation from PART 04–09 was repeated, re-scoped or changed. This
> part executed verification and produced this report. It changed no source,
> no migration, no OpenAPI, no infrastructure and no data.

---

## 1. Verified source SHAs

### 1.1 Backend — `budiirmawan/Handyman-Backend`

| Check | Command | Result |
| --- | --- | --- |
| Exact HEAD | `git rev-parse HEAD` | `608991ebf722d4b48ae44b45eae33193ec893a3c` |
| Required HEAD match | compare with `608991e` | **PASS** |
| Branch | `git rev-parse --abbrev-ref HEAD` | `arena/9ab3fff8-handyman-backend` |
| Ancestry of PART 09 correction | `git merge-base --is-ancestor 608991e HEAD` | TRUE |
| Working tree | `git status --porcelain` | empty (clean, before and after verification) |
| Recent chain | `git log --oneline -3` | `608991e` → `3d56dbf` → `c5d1931` |
| Migration registry | `migrations` export | **533** entries, all unique, head `0535_handyman_field_evidence_work_session` |

The PART 09 correction is present in the working copy: `originChannel` is
`[BM_SUPER_APP, CUSTOMER_CARE_BACKEND]` at `docs/api/openapi.yaml:99109` and
`:99158`, and `HandymanCustomerCareServiceRequest.required` carries the 21
runtime fields with no scheduling window.

### 1.2 Frontend — `budiirmawan/Handyman-Frontend` @ `arena/32916987-handyman-frontend`

**State: UNKNOWN — read access is not granted to this sandbox.** Both evidence
paths were attempted and both were refused:

```
git ls-remote https://github.com/budiirmawan/Handyman-Frontend.git \
  refs/heads/arena/32916987-handyman-frontend
→ remote: Write access to repository not granted.
→ fatal: unable to access ...: The requested URL returned error: 403

gh api repos/budiirmawan/Handyman-Frontend
→ gh: Resource not accessible by integration (HTTP 403)

gh api repos/budiirmawan/Handyman-Frontend/commits/a366346
→ gh: Resource not accessible by integration (HTTP 403)
```

The control case proves the credential itself is healthy: `gh api
repos/budiirmawan/Handyman-Backend` returns `{"full_name":"budiirmawan/Handyman-Backend",
"private":false,"default_branch":"main"}`. The GitHub token is scoped to the
Backend repository only.

There is also **no Frontend checkout** anywhere in this workspace
(`ls /home/user` → only `Handyman-Backend`).

Consequence: `a366346` is **accepted as reported by the Frontend PART 08/09
handoffs and is not independently verified here**. Nothing in this report may
be read as a Frontend source-identity PASS.

---

## 2. Environment discovery

### 2.1 Observed runtime evidence

| Probe | Result |
| --- | --- |
| Staging URL, hostname or tenant recorded anywhere in the repo | **None found** (`grep -ri staging` across `*.md/*.json/*.yml/*.yaml/*.ts` returns only gate text, no endpoint) |
| Deployment workflow that would publish this SHA | **None** — there is no `.github/` directory at all |
| Platform control-plane access (Railway/Coolify/Biznet/Vercel) | **None** — the `gh` token is repo-scoped; `https://api.railway.app` is **unreachable** from this sandbox (`curl` → `http_code=000`) |
| Live image digest / running backend commit | **NOT OBSERVABLE** |
| Running PostgreSQL version at any target | **NOT OBSERVABLE** |
| Migration ledger at any target | **NOT OBSERVABLE** |
| Authorized synthetic Care identities on a target | **None exist** (no environment to hold them) |

The repository's own release evidence agrees and is unambiguous:
`BIZNET_COOLIFY_RELEASE_GATE.md:5` records “**Environment accessed:** none; no
staging/Biznet/Coolify deployment, migration, seed, backup, restore, or
production-provider activation was performed”, and blocker **BA-08** is defined
as “No consumer verification, staging migration status/E2E, live IAM matrix,
persistence/load proof, or deployment evidence.” `E2E_CAPABILITY_MATRIX.md:14`
adds that every implemented consumer journey “remains subject to integrated
staging gate BA-08”.

### 2.2 Configuration intent (declared, not observed)

| Intent | Evidence |
| --- | --- |
| Backend deploy platform = Railway, Dockerfile builder, start `node dist/server.js`, healthcheck `/api/v1/health/database`, 1 replica, 300 s health timeout | `railway.json` |
| Image = Node 22 slim, dist-only runtime, non-root `node`, **migrations are explicit** (server never auto-migrates or seeds) | `Dockerfile` |
| Production-like stack = `postgres:16` + backend, DB password required from the environment, evidence volume mounted | `docker-compose.yml` |
| Certified local runtime = **PostgreSQL 18** | `docs/HANDYMAN_CI_SOURCE_CERTIFICATION.md:30` |
| Alpha/staging frontend origin = `https://handyman-frontend-alpha.vercel.app`; production `CORS_ORIGINS` is **empty** (no browser origins) | `docs/HANDYMAN_DEPLOYMENT_ENV_MATRIX.md:24,78,83` |
| Authentication = opaque revocable bearer session, SHA-256 hash stored, no refresh token | `docs/HANDYMAN_DEPLOYMENT_ENV_MATRIX.md` §TLS/CORS; `LoginResponse` schema |
| API prefix `/api/v1`; CORS allowlist is exact origins, no wildcard; allowed headers include `Authorization`, `X-Request-ID`, `Idempotency-Key` | `src/config/env.ts:218,429`; env matrix §CORS |

**Environment variable names required** (names only; values are never recorded
here — they come from the platform secret manager):

`NODE_ENV`, `PORT`, `API_PREFIX`, `LOG_LEVEL`, `DB_HOST`, `DB_PORT`, `DB_NAME`,
`DB_USER`, `DB_PASSWORD`, `DB_SSL`, `CORS_ORIGINS`, `EVIDENCE_STORAGE_DRIVER`,
`EVIDENCE_STORAGE_DIR`, `SCHEDULER_ENABLED`, `SCHEDULER_INTERVAL_MS`,
`JSON_BODY_LIMIT`, `SESSION_TTL_MINUTES`, `SESSION_TOKEN_BYTES`,
`SESSION_LAST_USED_THROTTLE_MS`, `AUTH_LOGIN_RATE_LIMIT_WINDOW_MINUTES`,
`AUTH_LOGIN_RATE_LIMIT_MAX_ATTEMPTS`, `INVITATION_TTL_HOURS`, `EMAIL_PROVIDER`,
`WHATSAPP_PROVIDER`, `PUSH_PROVIDER` (optional:
`HANDYMAN_INSPECTION_REUSE_MAX_AGE_SECONDS`).

### 2.3 Verdict for this section

A **separate staging Backend** and a **separate staging Frontend** cannot be
shown to exist for this release candidate. Configuration *intent* for an alpha
frontend origin and a Railway-hosted backend is documented; **runtime identity
for either is UNKNOWN**. Nothing here asserts that Railway, Biznet or Vercel is
serving `608991e` or `a366346` — and nothing may.

---

## 3. Database migration safety

### 3.1 Target evidence — **UNKNOWN**

No staging or production database is reachable, so the following are explicitly
**UNKNOWN**: the actual applied ledger, whether any pending ID would apply, the
target PostgreSQL major version, and existing-data preservation status. No
migration was run against any target.

### 3.2 Source-side evidence (disposable, isolated — real execution)

Executed on a throwaway embedded PostgreSQL cluster, created and destroyed by
the run; the temporary harness file was deleted afterwards and nothing was
committed.

| Check | Result |
| --- | --- |
| Registry entries | **533**, all unique (`REGISTRY_UNIQUE 533`) |
| Registry head | `0535_handyman_field_evidence_work_session` |
| Engine | PostgreSQL **18.4** |
| Fresh apply | ledger **533**, byte-for-byte equal to the sorted registry |
| Pending after apply | **0** |
| `0481_handyman_commercial_consent_bridge` | applied |
| `0484_handyman_care_structured_request_items` | applied |
| `0488_handyman_unlisted_intake_formal_request_conversion` | applied |
| `0535_handyman_field_evidence_work_session` | applied |
| `verifyMigrationReadiness` (the gate `/api/v1/health/database` uses) | **PASS** |
| Second apply | ledger still **533** (idempotent no-op) |
| Unknown-history injection → readiness gate | **REFUSED** (`DatabaseError`) — fail-closed |
| 0484 objects present | `uom_id` + `item_description` = 2 columns; `created_by_user_id` nullable = `YES` |
| 0481 objects present | `handyman_commercial_consent_receipts` exists |

> Count correction: earlier delivery notes referred to “535 migrations”. That
> figure is the **file count** in `src/database/migrations` including
> `index.ts` and `types.ts`. The executable registry is **533**; every count in
> this report uses the registry.

### 3.3 Historical `0481` and `0484` conflict analysis

Both were read in full and both are **additive and forward-only**:

- **`0481`** adds a nullable checked column; relaxes
  `handyman_care_communications.recorded_by_user_id` to nullable; adds
  `recorded_by_care_actor_id` plus the mutually-exclusive constraint
  `num_nonnulls(...) = 1`; a partial unique index; a new table; and immutability
  triggers. Existing rows all have `recorded_by_user_id` set, so the new
  constraint evaluates to exactly 1 non-null and **passes on existing data**.
  The migration enrols no issuer and is default-BLOCKED.
- **`0484`** widens `handyman_service_request_items.created_by_user_id` to
  nullable, adds nullable `uom_id` (FK) and nullable `item_description` with a
  length check that admits `NULL`. DDL is widening only; existing item writers
  keep setting the column.

Conflict surfaces that a staged run must still confirm (they cannot be closed
from here):

1. **Divergent history.** The runner stores **ids only** — there is no checksum
   column. Its guard is `verifyMigrationReadiness`: *every* registry id must be
   applied **and** *no* applied id may be outside this artifact, otherwise the
   API refuses traffic. So a target that ran an edited or extra `0481`/`0484`
   cannot be detected by hash — only by an unknown/pending **id**. A target
   built from a different branch that reused these numbers would pass the id
   check while carrying different DDL. **Recommendation:** capture the target's
   `schema_migrations` list and `pg_dump --schema-only` before applying, and
   diff the `0481`/`0484` object shapes.
2. **Pre-existing objects.** Both migrations use bare `ADD COLUMN` /
   `CREATE TABLE` / `CREATE INDEX` without `IF NOT EXISTS`; if a target already
   has a column or table from a hand-applied fix, the migration fails and rolls
   back its own transaction (per-ID atomicity + advisory lock
   `724196031`). Failing closed is correct, but it must be rehearsed.
3. **0478 downgard.** The runner refuses a populated `0478` SERVICE-price down
   before DDL (`assertMigrationDownSafe`). Irrelevant to a forward apply, but it
   constrains any rollback plan — **forward fix, never a historical down**.

Existing-data preservation requirements: a pre-apply `pg_dump` (schema +
data) of the target, evidence-volume snapshot, and single-writer freeze for the
duration of the one-shot migration job.

---

## 4. Browser E2E

**State: SKIPPED.** It is not runnable in this sandbox, for three independent
reasons, each verified:

1. **No Frontend source** — the repository is not readable (403) and no checkout
   exists locally.
2. **No browser runtime** — `~/.cache/ms-playwright` does not exist
   (`NO_BROWSERS_INSTALLED`). The Playwright *package* resolves (`1.64.1` via
   `npx`), but browser binaries download from hosts outside this sandbox's
   allowlist, so installation cannot complete.
3. **No reachable application** — no staging URL exists in the repo and
   non-GitHub/npm hosts are unreachable (`api.railway.app` → `http_code=000`).

Prerequisites to execute the twelve scenarios on an isolated stack:

| # | Scenario | Prerequisite |
| --- | --- | --- |
| A | Authorized Care staff login | Seeded Care staff user with a role holding `handyman.care.building` + initial credential; Session TTL configured |
| B | Building selection and authorization | ACTIVE Building + ACTIVE Property + active Client + ACTIVE `user_building_assignments`; a sibling Building for the negative case |
| C | Service catalog search / category | Client catalogue seeded (starter import: 8 categories / 24 services) |
| D | Variants + dynamic technical attributes | `GET …/catalogue/services/:id` reachable (PART 06) with ACTIVE variants and attributes |
| E | Quantity and UOM | ACTIVE Client-owned `units_of_measure` rows |
| F | Multiple structured items | PART 04 structured `items[]` accepted |
| G | Complaint vs per-item description | Request-level `description` + per-item `itemDescription` both writable |
| H | Submission with idempotency | `Idempotency-Key` header accepted; replay returns the same row |
| I | Persisted detail readback | Frontend read path over the PART 09-corrected contract |
| J | INTERNAL_ONLY Care Note submit/readback | Notes routes (`/handyman/care/buildings/:b/requests/:r/internal-notes`) — Backend verified at HTTP level, **no UI proof** |
| K | Note-save failure + safe retry, no duplicate request | Fault injection at the note endpoint; proves retry does not re-create the request |
| L | Building/Client scope rejection | Cross-Building and cross-Client identities |
| M | Scheduling preference is a proposal, not an appointment | Create with a preferred window; assert no appointment row and `INTAKE` status |
| N | No Care access to quotation pricing or BM permit approval | Care identity lacking Operations/Finance/BM permissions |

Scenarios M and N already hold at the Backend contract level (M is asserted in
the PART 09 runtime test; N by the absence of any pricing/permit surface in the
Care catalogue metadata and by permission separation). **A Backend assertion is
not a browser E2E PASS** and is not counted as one here.

No browser evidence was captured because no browser ran.

---

## 5. Regression and contract gates

Freshly re-executed in this part on a disposable PostgreSQL:

| Gate | Command | Result |
| --- | --- | --- |
| PART 04 — Building Care structured POST/GET | `handyman-care-building-structured-items-part04` | **12 / 12 PASS** |
| PART 06 — Catalog metadata | `handyman-care-catalog-metadata-part06` | **9 / 9 PASS** |
| PART 09 — corrected OpenAPI contract | `handyman-care-openapi-contract-part09` | **9 / 9 PASS** |
| Internal-note authority (privacy) | `handyman-internal-notes` | **14 / 14 PASS** |
| Typecheck | `npx tsc --noEmit` | **exit 0** |
| OpenAPI parse + internal `$ref` resolution | YAML walk | 21,351 refs, **0 unresolved** |
| Whitespace / conflict markers | `git diff --check` | **CLEAN** |

**Total: 44 / 44 executed results, 0 failures, 0 skips** (30 of them the
PART 04/06/09 contract lanes).

PART 07 (Frontend metadata controls) and PART 08 (HTTP integration) are
**Frontend** parts. What is verified here is only the Backend contract they
consume — the same contract asserted by the PART 06/09 lanes. Their own results
(`33/33` isolated HTTP E2E per PART 08) are **consumer-reported and were not
re-executed** in this environment.

### 5.1 Disclosed, unchanged defects

| Item | Status in PART 10 |
| --- | --- |
| `originChannel` still documented `enum: [BM_SUPER_APP]` in `HandymanServiceRequest` (`docs/api/openapi.yaml:99075`) | **Still present** — out of scope, needs its own focused change |
| `originChannel` still documented `enum: [BM_SUPER_APP]` in `HandymanChannelAttribution` (`docs/api/openapi.yaml:94731`) | **Still present** — same |
| `CareCreateExchangeIssued` (`:91280`) BM-only enum | **Correct as-is** — a BM-issued handoff really is `BM_SUPER_APP` only |
| Pre-existing BM immutability-trigger test failures — `handyman-customer-care-request-reads` fails 0/8 because its own teardown `TRUNCATE` is rejected by `hm_bm_issued_document_immutable` | **Unchanged, not caused by this work**; reproduced identically with all changes stashed in PART 09. Not modified. |
| PART 04 residual record (`handyman-care-workspace-request-detail` `finalReceipt` drift; `cr-hm-service-catalog-01-part01/part03` price-basis/tax fixtures; `openapi-operational-structural-closure` stale route census) | **Unchanged, pre-existing**, outside this release path |

**Newly discovered regressions: NONE.**

---

## 6. Release readiness matrix

| Area | State | Evidence |
| --- | --- | --- |
| **Source contract — Backend** | **PASS** | HEAD `608991e` exact, ancestry verified, clean tree, 533-entry registry, PART 09 correction present, OpenAPI 21,351 refs / 0 unresolved |
| **Source contract — Frontend** | **UNKNOWN** | Repo read refused (403) on both `git ls-remote` and `gh api`; no local checkout. `a366346` accepted as reported, not verified |
| **Isolated HTTP E2E — Backend contract lanes** | **PASS** | 30/30 fresh (PART 04 12, PART 06 9, PART 09 9) on disposable PostgreSQL with real sessions |
| **Isolated HTTP E2E — Frontend PART 08** | **PASS (reported)** | `33/33` per the Frontend PART 08 handoff; **not re-executed here** |
| **Browser E2E (A–N)** | **SKIPPED** | No Frontend source, no browser binaries, no reachable runtime; 14 prerequisites enumerated in §4 |
| **Staging runtime identity (backend commit / image digest)** | **UNKNOWN** | No staging endpoint recorded; platform control planes unreachable; repo gate records “Environment accessed: none” |
| **Staging Frontend runtime identity** | **UNKNOWN** | Alpha origin `handyman-frontend-alpha.vercel.app` is intent only (`docs/HANDYMAN_DEPLOYMENT_ENV_MATRIX.md:83`); unreachable from here |
| **Database migration compatibility — source/artifact** | **PASS** | 533/533 applied on PostgreSQL 18.4 disposable, ledger = registry, 0 pending, second apply no-op, unknown-history refused, 0481/0484/0488/0535 objects present |
| **Database migration compatibility — staging target** | **UNKNOWN** | No target reachable; ledger/order/pending/PG version/data-preservation unobservable |
| **Care authentication / authorization** | **PASS (isolated) / UNKNOWN (live)** | Isolated: Care permission 403, anonymous 401, cross-Building 403, cross-Client 404, PLATFORM_ADMIN vs PIC read wall — all asserted. Live IAM census absent (BA-08) |
| **Internal-note privacy** | **PASS (contract) / SKIPPED (end-to-end)** | Notes live on their own governed routes; the customer-facing read exposes no note-shaped key at any depth (14/14 + PART 09 test 9). No UI proof for scenarios J/K |
| **Known regressions** | **DISCLOSED, none new** | §5.1 |
| **Production deployment readiness** | **FAIL / NO-GO** | Repo gate `BIZNET_COOLIFY_RELEASE_GATE.md` is NO-GO; BA-08/09/10/11 open; no staging, consumer, IAM, persistence, backup/restore or cutover evidence |

### 6.1 Blocker detail

1. **No staging environment exists for this candidate (BA-08).** Prerequisites,
   verbatim in intent from `BACKEND_REMAINING_WORK_ROADMAP.md` §6.1: build and
   record the exact release SHA/image digest; on isolated staging run read-only
   migration status first, then apply pending IDs through one reviewed migration
   job (never auto-migrate/seed from the API container); verify least-privilege
   runtime/migration roles, extensions, canonical history, HTTPS/CORS, trusted
   proxy, persistent evidence mount, log collection, resource limits,
   health/readiness, one writer/scheduler; then consumer compatibility in order
   Customer Care Frontend → Operations/Manager → field PWA → native Android.
2. **Frontend source identity unverified** — `a366346` cannot be confirmed from
   this sandbox.
3. **Browser automation unavailable** — no binaries, no app, no network.
4. **PostgreSQL major must be confirmed at the target.** The artifact is
   certified on **18** (`docs/HANDYMAN_CI_SOURCE_CERTIFICATION.md:30`) and
   applied cleanly on **18.4** here, while `docker-compose.yml` pins
   **postgres:16**. Confirm the staging cluster's major and repeat the apply
   evidence there; do not assume the 16 pin and the 18 certification are
   interchangeable.
5. **Migration ledger has no checksum.** Only id-set equality is enforced;
   pre-apply `schema_migrations` capture and a schema diff are required to rule
   out divergent `0481`/`0484` DDL (§3.3).
6. **Production remains fenced** — no backup/restore (BA-11), notification
   activation (BA-09), real per-Client data (BA-10), consumers (BA-08), and no
   named final approval.

---

## 7. Evidence references

| Artifact | Location |
| --- | --- |
| Backend HEAD / ancestry / tree | `git rev-parse`, `git merge-base --is-ancestor`, `git status` (transcript in §1.1) |
| Frontend access refusal | `git ls-remote` + `gh api` 403 responses (transcript in §1.2) |
| Registry + ledger + readiness + unknown-history refusal | disposable embedded PostgreSQL 18.4 run (transcript in §3.2) |
| Migration analyses | `src/database/migrate.ts` (`verifyMigrationReadiness`, `assertMigrationDownSafe`, lock `724196031`), `0481_*.ts`, `0484_*.ts` |
| Deployment intent | `railway.json`, `Dockerfile`, `docker-compose.yml`, `.env.example`, `docs/HANDYMAN_DEPLOYMENT_ENV_MATRIX.md`, `docs/HANDYMAN_CI_SOURCE_CERTIFICATION.md` |
| Environment/gate truth | `BIZNET_COOLIFY_RELEASE_GATE.md`, `BACKEND_REMAINING_WORK_ROADMAP.md` §6.1, `E2E_CAPABILITY_MATRIX.md` |
| Contract lanes (fresh TAP) | `tests/handyman-care-building-structured-items-part04.test.ts` 12/12, `tests/handyman-care-catalog-metadata-part06.test.ts` 9/9, `tests/handyman-care-openapi-contract-part09.test.ts` 9/9, `tests/handyman-internal-notes.test.ts` 14/14 |
| Prior part reports | `docs/handyman/CR-HM-BE-CARE-CATALOG-STRUCTURED-01_PART04_DELIVERY.md`, `docs/handyman/CR-HM-BE-CARE-CATALOG-METADATA-01_PART06_DELIVERY.md`, `docs/handyman/CR-HM-BE-CARE-OPENAPI-CONTRACT-01_PART09_DELIVERY.md` |

TAP logs from this part were written to `/tmp` and are not committed (scratch,
not deliverables); the counts above are the recorded results.

---

## 8. Recommended next minimal part

**PART 11 — Staging provisioning + read-only migration status (BA-08 step 1–2).**
Smallest useful increment, and it unblocks everything else:

1. Create an isolated staging Backend + PostgreSQL from image of `608991e`,
   recording the image digest and the cluster's PostgreSQL major.
2. Run **read-only** `node dist/database/cli.js status` and capture the target
   `schema_migrations` list; diff it against the 533-entry registry before any
   apply.
3. Capture `pg_dump --schema-only` and diff the `0481`/`0484` object shapes.
4. Only then apply pending IDs through one reviewed job with the writer frozen.
5. Confirm `/api/v1/health/database` returns **200** (that endpoint already
   fails closed when canonical history does not match).

Explicitly **not** in the next part: browser E2E (needs a deployed Frontend of
`a366346`), production migration, notification activation, backup/restore, or
any implementation change. Browser E2E becomes the natural PART 12 once a
staging Frontend exists.

---

## 9. Final decision

| Dimension | Verdict |
| --- | --- |
| **SOURCE CONTRACT** | **PASS (Backend `608991e`, verified exact and clean)** — **Frontend `a366346` UNKNOWN** (no read access) |
| **ISOLATED HTTP E2E** | **PASS** — 44/44 executed, 0 failures, 0 skips; 30/30 of them the PART 04/06/09 contract lanes. The Frontend PART 08 `33/33` is **reported**, not re-executed |
| **BROWSER E2E** | **SKIPPED** — not runnable: no Frontend source, no browser binaries, no reachable runtime. **Not** a PASS |
| **STAGING READINESS** | **NOT READY / UNKNOWN** — no staging environment discoverable for this candidate; runtime identity, target ledger and target PostgreSQL version all unobservable |
| **PRODUCTION RELEASE READINESS** | **NO-GO** — BA-08/09/10/11 open, no backup/restore, no consumer proof, no named final approval |

Nothing above converts a SKIPPED or UNKNOWN into a PASS. The Customer Care
feature is **source-complete and contract-verified in isolation**; it is **not
staging-verified** and **not release-ready**.

---

## 10. Commit

- **This report:** `__COMMIT_SHA__` (documentation only; no source change)
