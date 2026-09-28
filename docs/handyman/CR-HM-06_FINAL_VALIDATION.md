# CR-HM-06 — FINAL VALIDATION & CERTIFICATION (PART 07B)

**Status: certified against base `2b1a985`, 2026-09-28.** Certification
only: runtime=0, migration=0, route/OpenAPI=0, roadmap=0, node_modules
never staged. Gates re-verified against the committed runtime
(`e7e8af2` PART 01 → `cf62045` PART 02 → `294a7b4`
PART 03 → `18eb831` PART 04 → `df9e41d` PART 05 → `398c965` PART 06 →
`2b1a985` PART 07A), the frozen START GOVERNANCE, the Decision Freeze
F1–F12, and the frozen PART 06 downstream binding contract.

## 1. Decision Freeze F1–F12 compliance

| Token | Frozen | Evidence | Result |
|---|---|---|---|
| QUOTATION_AUTHORITY | HANDYMAN | NEW `handyman_quotation*` tables (0391/0392); no `vendor_quotations`/FM substrate import anywhere in `src/modules/handyman-quotations/` | PASS |
| VERSION_MUTATION | FORBIDDEN_AFTER_DECISION | fact columns immutable per PART 01 repository (no update of commercial facts); lifecycle projection only | PASS |
| CUSTOMER_APPROVAL | EXPLICIT_VERSION_BOUND | decision bound to exact `quotation_version_id`; one decision per version (0394 UNIQUE) | PASS |
| EXECUTION_SCOPE_CREATION | APPROVAL_ONLY | sole write path `insertScope` inside the APPROVE branch (`handyman-quotation-decision.service.ts:261`) | PASS |
| EXECUTION_SCOPE_PER_APPROVED_VERSION | ONE | 0395 `UNIQUE(approved_quotation_version_id)`; conflict → `HANDYMAN_EXECUTION_SCOPE_CONFLICT` | PASS |
| CR_HM_12_PRICING_RULE_AUTHORITY | PRESERVED | snapshots persist final quoted amounts only; governed lookup/reference price = inputs (PART 02); no pricing rules/modes invented | PASS |
| FM_WORK_ORDER_REUSE | FORBIDDEN | zero `work_orders` writes/counts change in all side-effect tests; no FM import | PASS |
| BAST_ACCEPTANCE_SEPARATE | YES | zero `bast_documents` interaction | PASS |
| PAYMENT_SEPARATE | YES | zero payment/settlement/ledger runtime | PASS |

F1 authority, F2 immutable versioning, F3 bounded lifecycle, F4
commercial snapshot separation, F5 CR-HM-12 firewall, F6 explicit
decision, F7 lock+idempotency, F8 APPROVE-only atomic scope,
F9 one-scope-per-version minimum authority, F10 downstream boundary,
F11 BAST/payment firewall, F12 FM firewall — all verified below.

## 2. Quotation / version authority (F1)

- Handyman-owned `handyman_quotations` + `handyman_quotation_versions`
  (0391), created only from a diagnosed CR-HM-02/03 request lineage;
  client/request lineage is server-derived (PART 01 suite t1/t3).
- `vendor-quotations` and BM/SaaS pricing authorities are never
  reused as substrate (code + grep-level verification; PART 02 t10
  zero side-effect on `vendor_quotations`).

## 3. Versioning (F2)

- Each revision = new immutable version row
  (`createHandymanQuotationRevision`; PART 01 t6-style + PART 07A
  HTTP t3: revision v2 DRAFT with **zero copied lines**).
- APPROVED/REJECTED/EXPIRED/SUPERSEDED versions are terminal and
  never rewritten (PART 03/04 suites; historical decided versions
  preserved across replacement issuance).

## 4. Commercial snapshot (F4/F5)

- LABOR vs MATERIAL separated line rows (0392; `line_type` check).
- Immutable per-version line facts; `lineTotal =
  ROUND(quantity * finalQuotedUnitAmount, 2)` computed server-side
  only — caller `lineTotal`/`referenceUnitAmount` smuggling is
  structurally ignored (PART 02 t-proof + PART 07A HTTP t9).
- `referenceUnitAmount` (governed snapshot, informational) !=
  `finalQuotedUnitAmount` (approval-visible commercial fact);
  single currency per version (`handyman_quotation_currency`
  mismatch → dedicated error); NO tax/discount columns anywhere —
  CR-HM-12 authority preserved (F5).

## 5. Lifecycle (F3)

- Exactly `DRAFT → ISSUED → APPROVED | REJECTED | EXPIRED |
  SUPERSEDED`; no FM/procurement vocabulary (no WITHDRAWN).
- Issue requires ≥1 line + future `validUntil`; expiry is
  server-time-authoritative (caller timestamp never authority);
  replacement issuance supersession is atomic; at most one current
  ISSUED per quotation thread enforced by 0393 partial unique index;
  presented read = current ISSUED (`null` while DRAFT / after
  expiry). Verified PART 03 suite 9/10 (see §12) + PART 07A t4/t5.

## 6. Customer decision (F6/F7)

- Exact-version, one-per-version decision with
  `lockVersionById` inside `withTransaction`; APPROVE|REJECT only;
  immutable record with server-derived `tenantCompanyId`/`tenantPicId`
  snapshot (NULL PIC preserved never fabricated); authenticated actor
  = session user; idempotent replay via SHA-256
  `request_fingerprint` (key reuse => identical replay, mismatch =>
  conflict). Verified PART 04 suite 10/10 + PART 07A t6–t8.

## 7. Approval atomicity (F8)

One `withTransaction` in `decideHandymanQuotation` commits:
decision record + `APPROVED`/`REJECTED` projection + Execution Scope +
`HANDYMAN_EXECUTION_SCOPE_CREATED` + decision journal — or nothing.
Proven empirically by PART 05 t5 full-rollback test (scope insert
failure via inconsistent location chain → 400
`HANDYMAN_EXECUTION_SCOPE_LOCATION_INCONSISTENT`, zero partial rows:
no decision, no projection change, no scope, no events) and t7
concurrent double-approve (exactly one scope, one decision, replay
shape). REJECT never creates a scope (PART 05 t-zero-scope +
PART 07A t7: scope read 404 `HANDYMAN_EXECUTION_SCOPE_NOT_FOUND`).

## 8. Execution scope (F8/F9)

- Exactly one AUTHORIZED scope per approved version; lineage covers
  request, channel attribution, approved quotation id **and**
  version id, decision id, tenant company/PIC, and authoritative
  location snapshot (building/floor/area/room/space), all
  server-derived (PART 05 t2/t3); `createdByUserId` = actor.
- Immutable authority snapshot (0395 trigger; no update/delete
  pathway); no placeholder, no alternate creation path (single
  `insertScope` call site).
- Bounded read `getHandymanExecutionScopeByQuotationVersion` only
  (no list/search/dashboard).

## 9. Downstream activation boundary (F10 / PART 06)

- `EXECUTION_SCOPE_AUTHORITY=CR-HM-06`;
  `EXECUTION_TARGET_TYPE=HANDYMAN_EXECUTION_SCOPE`;
  CR-HM-04/05 = ACTIVATABLE against `executionScopeId`;
  CR-HM-07/08 = DEFINED_NOT_IMPLEMENTED.
- Zero crew/schedule/arrival/work-session runtime added here:
  keyword scan over both quotation modules shows downstream terms
  only inside firewall documentation comments; PART 06 contract
  remains doc-only (runtime=0).

## 10. CR-HM-12 / BAST / payment / FM firewalls (F5/F11/F12)

- No pricing rules, commercial agreements, BM fee, FX, or SaaS
  price semantics (F5).
- APPROVED != BAST accepted; APPROVED != paid — no BAST/payment/
  settlement runtime (F11; side-effect suites count
  `bast_documents`/payment invariants at zero delta).
- Execution Scope != FM work order — no FM WO creation/conversion/
  mutation and no FM quotation lifecycle adoption (F12; PART 05 t10
  counts `work_orders`/`vendor_quotations` at zero delta).

## 11. Migrations 0391–0395

Ordered, additive, in-sequence and present in
`src/database/migrations/index.ts`:

| ID | Content |
|---|---|
| 0391 | `handyman_quotations` + `handyman_quotation_versions` (fact-immutability trigger) |
| 0392 | `handyman_quotation_lines` (line immutability, currency check, FK) |
| 0393 | one-ISSUED partial unique index per quotation thread (backstop only) |
| 0394 | `handyman_quotation_decisions` (UNIQUE version decision, fingerprint) |
| 0395 | `handyman_execution_scopes` (UNIQUE approved version, authority immutability trigger) |

No unrelated schema mutation introduced by CR-HM-06.

## 12. HTTP / OpenAPI (PART 07A)

- Frozen surface: **13 operations / 10 paths** (4 quotation, 3 line,
  3 lifecycle, 2 decision, 1 execution-scope read) at
  `src/modules/handyman-quotations-api/`; actor = session; reads
  `tenant_company.read`, mutations `tenant_company.manage`;
  decision POST consumes the `Idempotency-Key` header (existing
  convention).
- Runtime/OpenAPI parity proven by PART 07A t10 (path/method/
  operationId map == 13 ops; quotation schemas preserve
  reference≠final, DRAFT≠ISSUED, APPROVED≠BAST/paid, Scope≠WO,
  AUTHORIZED single-state enum).
- YAML parse: PASS; zero dangling refs; zero
  crew/schedule/arrival/QR/geofence/work-session/payment/settlement/
  BAST/FM quotation APIs; no execution-scope collection/list route.

## 13. Focused validation result

Command (real migrated PostgreSQL 18.4 embedded, single worker,
`DB_PASSWORD=postgres`):

```
npx tsx --test --test-concurrency=1 \
  tests/handyman-quotation.test.ts \
  tests/handyman-quotation-line.test.ts \
  tests/handyman-quotation-lifecycle.test.ts \
  tests/handyman-quotation-decision.test.ts \
  tests/handyman-execution-scope.test.ts \
  tests/handyman-quotations-api.test.ts
```

| Suite | Result |
|---|---|
| PART 01 `handyman-quotation` | **10/10** |
| PART 02 `handyman-quotation-line` | **9/10** (t10 stale — §14.D1) |
| PART 03 `handyman-quotation-lifecycle` | **9/10** (t10 stale — §14.D2) |
| PART 04 `handyman-quotation-decision` | **10/10** |
| PART 05 `handyman-execution-scope` | **10/10** |
| PART 07A `handyman-quotations-api` | **10/10** |

**Total: 58/60 PASS.** OpenAPI YAML parse: PASS. Runtime/OpenAPI
parity (API suite t10): PASS. `git diff --check`: clean. Project-wide
tsc/build deliberately not used as a certification gate (mandate).

## 14. Defects

Implementation (runtime) defects: **NONE found.** No fix performed
inside certification; STOP-and-report applies to the two test-harness
defects below.

- **D1 — stale zero-schema assertion (PART 02 t10,
  `tests/handyman-quotation-line.test.ts:628`).** The assertion
  `assert.equal(tables.rows.length, 0)` over
  `information_schema … %execution_scope%|%quotation_approval%` was
  written in PART 02 (`cf62045`) pre-PART-05. PART 05 (`df9e41d`)
  legitimately and mandatorily added `handyman_execution_scopes`
  (0395), so fresh migrated test DBs now return 1 row. Deterministic
  failure `1 !== 0` on every run since PART 05; not a flake.
- **D2 — identical stale assertion (PART 03 t10,
  `tests/handyman-quotation-lifecycle.test.ts:681`).** Same root
  cause, same failure shape.

Both failing assertions demand that a FROZEN F8/F9 deliverable (the
execution-scope table) NOT exist; every behavioural assertion in the
same tests still passes, including `handyman_execution_scopes` row
counts (`scopeCount(versionId)` == expected) in PART 05 and the full
PART 07A HTTP surface. The runtime satisfies the freeze; the two
expectations predate it. Required remediation (future test-only
hardening PART, out of certification scope): update both
`information_schema` expectations to the PART 05 shape (exactly
`handyman_execution_scopes` present, zero `%quotation_approval%`)
and re-certify to 60/60.

## 15. Known non-blocking debt

- **Pre-existing unrelated typecheck debt (project-wide `tsc
  --noEmit`): 32 errors** across legacy modules
  (`basic-financial-reporting`, `fx-rates`, `handyman-api`,
  `handyman-handoff`, `handyman-providers`,
  `management-financial-summary`, `work-order-sla-register` …).
  Verified by compiling a pristine HEAD worktree — identical errors
  exist at base `2b1a985` with zero contribution from any CR-HM-06
  file (CR-HM-06 delta type-clean). Not a certification gate
  (mandate); not fixed (mandate).
- **Journal-ordering hardening (carried from CR-HM-05):**
  `operational_events` rows in one transaction share a timestamp;
  UUID id tie-break is nondeterministic. Audit-only, semantically
  inert; CR-HM-06 surfaces resolve rows by `event_type`/`entity_id`
  from inception. Not fixed (out of scope).
- Environment regression class (6th occurrence this project): sandbox
  resets recovery from verified remote tip only; deps installed with
  an exact lockfile (`npm ci`); no code reconstructed.

## 16. Final status

| Gate | Result |
|---|---|
| F1–F12 freeze compliance (§1–§10) | PASS |
| Migrations 0391–0395 (§11) | PASS |
| HTTP/OpenAPI 13 ops / 10 paths + parity + YAML parse (§12) | PASS |
| Focused validation (§13) | **FAIL — 58/60 (2 stale pre-0395 assertions, §14 D1/D2)** |
| Implementation defects | NONE |
| Known non-blocking debt | Recorded (§15) |

**CR_HM_06_STATUS=NOT_COMPLETE** — every runtime certification gate
F1–F12 passes and no implementation defect exists, but the mandate
requires all gates PASS for `COMPLETE`, and the focused validation
gate cannot reach 60/60 without the two-line test-harness remediation
recorded in §14, which certification explicitly forbids performing
here. Next lawful step (outside this certification): a bounded
test-only hardening PART applying §14 remediation, then a re-run of
PART 07B (expects 60/60 and `CR_HM_06_STATUS=COMPLETE`).

---
*This document is certification evidence only. Any
runtime/migration/route/OpenAPI change requires an explicit new PART.*
