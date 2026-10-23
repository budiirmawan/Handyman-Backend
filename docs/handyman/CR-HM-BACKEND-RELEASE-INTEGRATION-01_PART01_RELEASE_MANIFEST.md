# CR-HM-BACKEND-RELEASE-INTEGRATION-01 — PART 01
# Release Manifest (Release Candidate)

| Field | Value |
| --- | --- |
| Artifact | Handyman Backend — integration release candidate |
| Branch | `arena/44decf3c-handyman-backend` |
| Base | `main` @ `e8b94af426d5d730900d98716135a7114e62e097` |
| HEAD at manifest time | the commit that introduces this manifest (tip of the integration branch) |
| Commits ahead of `main` | 29 (22 feature/source + 7 integration/test/documentation) |
| Diff vs `main` | 178 files, +50,814 / −706 |
| Node engine | `>=20` |
| Runtime deps changed | none (no new dependency was introduced by the integration) |
| Deployment target | Biznet Coolify (single backend container) |
| Railway config | `railway.json` unchanged and still valid |

---

## 1. Integrated sources

| Source | Ref | Tip | Commits | Merge commit |
| --- | --- | --- | --- | --- |
| PR #55 — Worker competency, multi-trade WO, direct workforce | `arena/3df97f5e-handyman-backend` | `30be708e` | 14 | `37cc6e0` |
| IAM permission revocation (D-01/G-03) | `arena/37aa07d3-handyman-backend` | `63f3a851` | 1 | `515919f` |
| PR #56 — Expense, helper attendance, assignment response | `arena/daf49406-handyman-backend` | `8f549dc9` | 7 | `f75f84c` |

Excluded by instruction: **PR #47** finance bank receipt attestation
(`arena/6105302d-handyman-backend`) — verified absent from the diff.

---

## 2. Content of the release

### 2.1 Migrations (11 new)

```
0461_create_workforce_certifications
0462_workforce_certification_permissions
0463_service_catalog_competency_requirements
0464_workforce_competency_decision_history
0465_work_order_multitrade_classification
0466_direct_handyman_workforce
0467_work_order_reclassification_decision
0468_extend_permission_grant_audit_events
0470_handyman_field_expense_reimbursement
0471_handyman_helper_attendance_confirmation
0472_handyman_assignment_responses
```
No `0469`. Total registered migration count: **470**.

### 2.2 New modules (6)

| Module | Authority |
| --- | --- |
| `workforce-certifications` | Individual worker certificates (create, verify/reject, deactivate, expiry watch) |
| `service-competency-requirements` | Requirements per Service Catalog job type |
| `worker-competency-eligibility` | The single evaluator + decision ledger used by every gate |
| `work-order-trade-categories` | Multi-trade registry + Operations classification |
| `assignment-responses` | TERIMA / TIDAK_BISA lifecycle, supersede, IN_APP fan-out |
| `handyman-helper-attendance` | Helper attendance confirmation + personnel changes |

No duplicate arrival/QR/GPS/evidence module was created.

### 2.3 Modified authorities

* `work-order-assignments` — competency gate + response lifecycle in one transaction.
* `handyman-scope-assignments` — PART 03A gate + supersede notification.
* `work-order-history`, `mobile-assignments`, `notifications`, `permissions`,
  `audit`, `handyman-providers`, `handyman-worker-profile`.
* `src/routes/index.ts` — five routers mounted once.
* `src/shared/errors.ts` — union of every new error code.
* `src/database/migrate.ts` — the `0472` idempotent repair guard.

### 2.4 Contract

| Metric | Before (`main`) | This release |
| --- | --- | --- |
| Handyman OpenAPI operations | 269 (freeze-03 pin) | **287** |
| Handyman operations with `x-required-permission` | 179 | **190** |
| OpenAPI paths / schemas | — | 1,532 / 2,312 |
| Duplicate paths / operationIds | 0 / 0 | **0 / 0** |
| Runtime routes (composed app) | 1,985 | **2,032** (2,034 with WhatsApp webhook router) |
| Runtime `METHOD path` duplicates | 1 (`GET /tasks/{p}`) | **1 — the same pre-existing one** |

Handoff docs updated: `MOBILE_API_HANDOFF.md` (§7 competency certifications,
§8 helper attendance), `docs/api/openapi.yaml`, plus the per-CR delivery reports
under `docs/handyman/`.

---

## 3. Verification evidence

### 3.1 Build gates

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | **exit 0** |
| Build | `npm run build` | **exit 0** |
| Migration verification | `npx tsx tests/manual/release-integration-migration-check.ts` | **14/14 PASS** |

### 3.2 Focused regression matrix (29 suites, 309 assertions, 0 failures)

| Suite | Result |
| --- | --- |
| `release-integration-merged-e2e` (new) | 9/9 |
| `handyman-contract-freeze-03-openapi` | 13/13 |
| `openapi-operational-final-parity` | 7/7 |
| `openapi-operational-structural-closure` | 8/8 |
| `openapi-saas-route-parity` | 15/15 |
| `config-perm-01-permission-registry` | 13/13 |
| `permission-revocation` | 8/8 |
| `worker-competency-03b1` | 14/14 |
| `handyman-competency-assignment` | 11/11 |
| `work-order-classification-03b2e` | 19/19 |
| `work-order-multitrade-03b2a` | 17/17 |
| `work-order-multiskill-03b2b` | 11/11 |
| `work-order-pg18-03b2c` | 6/6 |
| `handyman-direct-workforce-03b2d` | 20/20 |
| `workforce-certifications` | 6/6 |
| `workforce-certifications-http` | 18/18 |
| `handyman-assignment-response-part02a` | 8/8 |
| `handyman-assignment-response-part02b` | 5/5 |
| `handyman-assignment-response-part02c` | 6/6 |
| `handyman-field-expense-reimbursement` | 3/3 |
| `handyman-helper-attendance-confirmation` | 3/3 |
| `mobile-assignment-contract` (`ASENTRA_USE_EMBEDDED_POSTGRES=true`) | 18/18 |
| `e2e-operational-lifecycle-04a` | 17/17 |
| `handyman-execution-scope-assignment-service` | 10/10 |
| `handyman-execution-scope-assignments` | 10/10 |
| `handyman-execution-scope-assignment-scope-guard` | 4/4 |
| `handyman-scope-assignments-api` | 10/10 |
| `handyman-arrival-verification-api` | 10/10 |
| `handyman-arrival-challenges` | 10/10 |

Full suite was **not** run, as instructed.

### 3.3 Lifecycle covered end to end

Tenant → Customer Care → Service Request → Work Order → Operations
classification → worker assignment (competency-gated) → IN_APP notification →
TERIMA / TIDAK_BISA → reassignment → arrival QR/GPS verification → work session →
helper attendance → photo evidence → material purchase/receipt →
reimbursement → QC → closure.

`e2e-operational-lifecycle-04a` exercises steps 1–17 of that chain on a real
embedded PostgreSQL 18; `release-integration-merged-e2e` proves the seams
between the three release lines inside it.

---

## 4. Deployment order (for FINAL REVIEW, not executed here)

1. Merge the integration branch into `main` (only after FINAL REVIEW approval).
2. Build the image; deploy to Biznet Coolify as a release, not a roll.
3. Stop traffic → run `db:migrate:prod` once → verify 11 new history rows and
   the absence of `0469`.
4. Run `db:migrate:prod` again → expect 0.
5. Start traffic; the readiness gate refuses to serve on any history mismatch.
6. Smoke: login (existing password), permission revocation, one Work Order
   classification + assignment, one TERIMA, one TIDAK_BISA + reassignment.

---

## 5. Explicit non-actions

* No pull request was opened.
* Nothing was merged into `main`.
* Nothing was deployed to Biznet, Railway or Coolify.
* No production database was read, migrated or modified.
