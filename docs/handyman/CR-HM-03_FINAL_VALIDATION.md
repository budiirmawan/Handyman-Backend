# CR-HM-03 — FINAL VALIDATION & CERTIFICATION

**Scope (Handyman-Backend only):** the bounded Triage → Inspection →
Diagnosis → Specialist-Escalation/referral-out lifecycle for CR-HM-02
Handyman service requests, delivered per `CR-HM-03_START_GOVERNANCE.md`
(FROZEN decisions F1–F9 of 2026-09-27).

**Baseline:** `14d8f287a53c808550148f3394591211503dc4fc` (PART 05A).
Certification is validation-only: no feature, route, migration, business
logic, or frozen roadmap/map/matrix change.

## 1. F1–F9 compliance

| Gate | Result |
|---|---|
| F1 lifecycle | PASS — `INTAKE → TRIAGE → INSPECTION_REQUIRED | DIAGNOSIS → READY_FOR_NEXT_STEP | REFERRED`; REFERRED terminal; no execution/quotation/provider states exist |
| F2 records | PASS — triage/inspection/diagnosis/referral are immutable, append-oriented decision records; history never overwritten; request status is a projection |
| F3 evidence freeze | PASS — no inspection evidence exists; no evidence parent/stage expansion; PHOTO/VIDEO intake behavior (CR-HM-02 PART 04) untouched; full evidence authority defers to **CR-HM-10** |
| F4 classifications | PASS — exactly `GENERAL_HANDYMAN / SPECIALIST_REQUIRED / OUT_OF_HANDYMAN_SCOPE`; Electrical/AC targets-only-never-execution; FM/common-building ⇒ `OUT_OF_HANDYMAN_SCOPE` |
| F5 refer terminality | PASS — referral creates no FM request/conversion/work order/quotation/provider assignment; original request + history preserved |
| F6 journal | PASS — append-only decision/history rows on the shared `operational_events` authority (`HANDYMAN_REQUEST_TRIAGED / HANDYMAN_INSPECTION_RECORDED / HANDYMAN_DIAGNOSIS_RECORDED / HANDYMAN_REFERRAL_CREATED`); journal is audit only, never lifecycle authority |
| F7 actor model | PASS — explicit authenticated local user ONLY; never derived from `tenantPicId`, channel attribution, or BM handoff identity; existing client-scope (accessible-Client) convention enforced |
| F8 permission split | PASS — reads `tenant_company.read`, mutations `tenant_company.manage` (closest existing Handyman read/manage convention, derivation documented in the route header); service layer remains authoritative |
| F9 scope authority | PASS — `service_catalog.category` is descriptive metadata only, NEVER scope authority (negative test: FM-hint category text never affects classification); classification derived strictly from `discipline.scopeClass`; registry is Handyman-bounded — vendor/asset/incident categories never reused |

## 2. Delivered runtime summary

- **Triage (PART 01):** `INTAKE → TRIAGE` with bounded disposition
  (`INSPECTION_REQUIRED | DIAGNOSIS`), immutable decision + projection +
  journal in one transaction; actor + context never caller-derived.
- **Inspection (PART 02):** valid only from `INSPECTION_REQUIRED`;
  structured result (`INSPECTED | NOT_INSPECTABLE`) + notes + actor + server
  `inspected_at`; atomic `→ DIAGNOSIS`; zero evidence rows (F3).
- **Diagnosis (PART 03):** valid only from `DIAGNOSIS` (both direct and
  inspected paths); F9-discipline-anchored; classification +
  projection **server-derived only**
  (`GENERAL_HANDYMAN → READY_FOR_NEXT_STEP`;
  `SPECIALIST → SPECIALIST_REQUIRED → READY_FOR_NEXT_STEP`;
  `OUT_OF_HANDYMAN_SCOPE → OUT_OF_HANDYMAN_SCOPE → REFERRED`);
  optional recommendation must be ACTIVE + same-Client + associated with
  the selected F9 discipline.
- **Referral (PART 04):** eligibility/type/target derived from the
  immutable diagnosis only; `GENERAL_HANDYMAN` cannot refer;
  one referral per request/diagnosis (race-safe 409); **no request state
  change** (SPECIALIST stays `READY_FOR_NEXT_STEP`; OUT_OF_SCOPE stays
  terminal `REFERRED`).
- **HTTP/OpenAPI (PART 05A):** exactly the 8 operations below; thin
  handlers (parse + auth actor only); zero business rule at HTTP.

## 3. Migrations 0380–0383 (minimum, additive, reverting `down`)

| # | Content |
|---|---|
| 0380 | `handyman_request_triage_decisions` (+ immutability triggers; F1 status CHECK re-add: INTAKE/TRIAGE/INSPECTION_REQUIRED/DIAGNOSIS) |
| 0381 | `handyman_request_inspections` (+ triggers) |
| 0382 | `handyman_disciplines` (F9 registry seeded exactly: SIMPLE_PLUMBING, FURNITURE, MINOR_CIVIL, GENERAL_HANDYMAN, ELECTRICAL, AC, FM_COMMON_BUILDING) + `handyman_discipline_service_associations` + `handyman_request_diagnoses` (+ triggers) + status CHECK re-add adding READY_FOR_NEXT_STEP/REFERRED only |
| 0383 | `handyman_request_referrals` (+ triggers) |

## 4. API operations (exactly 8)

`POST|GET /api/v1/handyman/requests/:handymanRequestId/{triage|inspection|diagnosis|referral}`
— GET ⇒ `tenant_company.read`; POST ⇒ `tenant_company.manage`; actor from
authenticated session context. Caller has **no authority** over actor,
classification, referral type/target, or client/building/channel context
(structural parser whitelisting — smuggle keys never reach services).
OpenAPI documents exactly these 8 operations with derived-field semantics;
runtime/OpenAPI parity asserted by the PART 05A suite.

## 5. Firewalls (proven by focused tests, row-count deltas = 0)

- **FM firewall:** no FM request / FM conversion / FM work order / FM
  execution / FM provider assignment ever created; `FM_COMMON_BUILDING`
  is a referral classification boundary only; original Handyman request +
  full history preserved.
- **Provider-assignment firewall:** ELECTRICAL/AC are specialist targets
  only — no vendor/provider selection, no worker/crew assignment, no
  work order, no quotation, no matching anywhere in CR-HM-03.
- **Evidence firewall:** inspection carries zero evidence rows;
  PHOTO/VIDEO semantics untouched; full evidence authority = CR-HM-10.
- `tenant_service_requests`, `work_requests`, `work_orders`,
  `vendor_quotations`, `evidence_submissions`,
  `workforce_skill_assignments` — deltas 0 across all lifecycle actions.

## 6. Focused validation results

Focused CR-HM-03 suites only (node:test, `--test-concurrency=1`, single
embedded-PG cluster) — **50/50 PASS (0 fail)**:

| Suite | Result |
|---|---|
| tests/handyman-request-triage.test.ts | 10/10 PASS |
| tests/handyman-request-inspection.test.ts | 10/10 PASS |
| tests/handyman-request-diagnosis.test.ts | 10/10 PASS |
| tests/handyman-request-referral.test.ts | 10/10 PASS |
| tests/handyman-lifecycle-api.test.ts | 10/10 PASS |

No full repo suite / project-wide typecheck/build executed (bounded by
mandate). No 05B HTTP→repo-wide admission regressions: PART 05A only
*adds* a self-contained router + GET-scope params.

## 7. Known non-gates

- During certification, PART 03 test 8's fixture (a hardcoded
  `RETIRED_DISCIPLINE` seed row) collided on a persisted shared cluster
  **`handyman_disciplines_code_unique` — a test-fixture determinism
  defect, NOT an implementation defect**. The fixture was made deterministic
  (unique code per run); implementation untouched. After correction: 50/50.
- No pre-existing defects encountered anywhere else.

## 8. Final status

**CR-HM-03 = COMPLETE.** All F1–F9 gates PASS; focused validation 50/50;
declared boundaries (F1 terminality, F3 evidence deferral, F5
terminality, F9 category non-authority, F6/F7/F8 authority rules) hold
with zero FM/provider/quotation/work-order side effects.

*Certified 2026-09-27 — baseline `14d8f28`.*
