# CR-HM-17 TRANSPORT GAP — PART 08 FINAL CERTIFICATION

**Verdict: PASS — Customer Care transport gaps certified.**

**Date:** 2026-10-01 (Asia/Jakarta)

**Active blockers:** 0

| Gate | Result |
| --- | --- |
| Repository / branch | `Handyman-Backend` / `arena/01a0f5c4-handyman-backend` |
| Pre-work HEAD | `b87d72f` — matched the requested baseline |
| Pre-work tracked tree | CLEAN (`git status --short -uno` empty) |
| Frozen governance | `CR-HM-17_CUSTOMER_CARE_TRANSPORT_GAP_GOVERNANCE.md`, committed at `2fcfad9`; unchanged |
| Certified runtime | PART 01–07, `2fcfad9..b87d72f` |
| PART 08 scope | Certification harness, this record, and documentation-only contract corrections; no feature/runtime/dependency/migration changes |
| Final focused verification | **39/39 tests passed**, 8 suites, 0 failed/cancelled/skipped |
| Diff hygiene | `git diff --check` clean |

This verdict is bounded to the Customer Care HTTP transport implemented by
PART 01–07 and the inherited CR-HM-01..16 authorities it consumes. It is not
certification of unrelated APIs or a full-repository regression/typecheck/build.

## 1. Per-PART evidence: B3–B8 and PART03

| PART / commit | Capability | Authority and certified transport |
| --- | --- | --- |
| 01 / `06c649c` | **B3 request reads** | Request list/detail expose stored CR-HM-02/03 status, immutable CR-HM-01 attribution/Care-actor provenance, represented tenant/building/space IDs, and execution-scope pointers. No presentation-owned status writer. |
| 02 / `485dbbb` | **B4 provider availability** | CR-HM-04 ACTIVE providers and assignable ACTIVE crews, valid current login-capable Leads, CR-HM-04A active assignment and CR-HM-08 session occupancy facts. No availability state machine or assignment mutation added. |
| 03 / `03ac7cd` | **PART03 arrival/work/material reads** | CR-HM-07 terminal arrival/expected-location facts; CR-HM-08 sessions/events/helper presence/presence-versus-actual-work time; CR-HM-09 material quantities/events/final-used facts. Dedicated Customer Care GETs do not grant field command authority or publish money/challenge secrets. |
| 04 / `cc18f90` | **B5 evidence/QC/defect/BAST** | Six CR-HM-10 list/detail GETs hide storage keys and preserve Lead-only POST services. CR-HM-11 BAST reads and ACCEPT/REJECT/sign-off wrap the existing acceptance/signature/idempotency/audit authority; prepare/issue/void are not added to Customer Care transport. |
| 05 / `75d0943` | **B6 customer ledger/payment** | Published CR-HM-13 transaction/client-basis readers preserve gross/net LABOR/MATERIAL separation, allocations and machine-visible corrections. Bounded payment record/confirm/reject/list wrappers reuse the existing payment services. No provider/BM entitlement or settlement transport. |
| 06 / `65838a1` | **B7 warranty/claim/rework** | Five CR-HM-15 published contract GETs and eight customer claim/decision commands preserve original BAST/scope anchors, WORKMANSHIP/MATERIAL coverages, free-rework versus chargeable-work separation, and existing owner ladders. Warranty start/expiry and field rework execution are not exposed. |
| 07 / `b87d72f` | **B8 SLA/status visibility** | Five frozen Handyman SLA subject types wrap `appliedSlaService.getBySubject`; nine milestone coordinates reuse `HANDYMAN_SLA_SUBJECT_MILESTONES`. Performance delegates to `deriveHandymanProviderPerformance`. Request/scope status visibility composes authoritative stage facts without a new lifecycle/SLA/KPI writer or FM SLA fallback. |

### End-to-end harness

`tests/handyman-customer-care-transport-certification.test.ts` drives the real
Express API (supertest) against a fresh, fully migrated embedded PostgreSQL.
Domain fixtures and upstream/provider steps use the existing authoritative
services, not alternate command implementations.

The linked journey is:

1. Signed BM Customer Care assertion → backend-resolved represented context →
   one-time exchange → immutable attribution → authenticated request intake.
2. B3 list/detail retain Care provenance and represented tenant IDs after
   triage/diagnosis/quotation approval through the existing authorities.
3. B4 availability changes only its derived occupancy facts after assignment.
4. Lead-authorized arrival verification, work check-in/start and material
   estimate become visible through the dedicated PART03 GETs.
5. Evidence with a managed private storage key, QC/defect facts and issued BAST
   become visible to Care; customer BAST acceptance goes through HTTP.
6. Customer payment record/confirm and CR-HM-13 ledger facts become visible.
7. Warranty claim submit/approve and free rework authorization go through HTTP;
   a separate original scope/warranty exercises rejected-claim → separated
   chargeable proposal → customer acceptance/payment-trigger fact.
8. Shared SLA authority binds all five subject types; B8 exposes their frozen
   milestone coordinates, derived performance, and both status-view anchors.

## 2. ACCESS certification

| Requirement | Verdict / evidence |
| --- | --- |
| Authenticated Customer Care access | **PASS.** The complete journey uses a non-admin local Care session with explicit client access. Every one of the 26 scoped GET operations is exercised with an authorized read-only Care session; unauthenticated access returns 401. |
| `tenant_company.read` / `tenant_company.manage` boundary | **PASS.** GET matrix rejects both no-permission and manage-only sessions with 403 `PERMISSION_DENIED`. All 14 bounded customer command operations reject read-only sessions; a manage-only session successfully records/rejects payment without acquiring GET authority. Focused suites cover the other governed customer command branches and idempotent replay. |
| Cross-client isolation | **PASS.** Two real client realms have separately assigned users with read/manage permissions. Foreign-client sessions get 403 across all 26 GET and 14 command operations despite holding the required RBAC permission. Existing services resolve entity context and enforce `canAccessClient`; RBAC is not a substitute for context access. |
| Backend-resolved represented context | **PASS.** Real signed assertion resolution and exchange binding preserve tenant company/PIC/building/space ownership. Extra context/identity/status/origin fields supplied to binding/intake cannot replace resolved provenance. Modifying the signed Care actor block returns 401; exchange-as-Bearer and exchange reuse return 401, assertion replay returns 409. |
| Customer Care != represented tenant | **PASS.** Attested Care registry ID, local Care session user, represented Tenant PIC and represented linked user remain separate identities. Attribution/request acting-user fields stay null for attested Care provenance. Handoff/binding/replay attempts create no local user/session/role assignments. |

The read matrix makes 30 concrete GET cases: all 26 GET operations, with the
subject-SLA operation exercised separately for each of its five allowed types.
No scope authorization is derived from a caller-supplied tenant or actor ID.

## 3. FIREWALL and authority certification

| Boundary | Verdict / evidence |
| --- | --- |
| Crew Lead command firewall | **PASS.** PART03/PART04 focused suites deny Care/admin non-Leads on the existing arrival/work/material/evidence/QC/defect command families. Harness checks return the owning `HANDYMAN_*_NOT_AUTHORIZED` errors. Care read/manage permissions never create a Lead designation. |
| Storage/challenge secret firewall | **PASS.** Real evidence storage keys, arrival challenge token, opaque QR value, handoff exchange and integration secret are absent from the 30 Customer Care read responses. Recursive key scans forbid storage paths/keys and challenge/token hashes; private storage/challenge authority is not transferred. |
| CR-HM-14 entitlement/settlement firewall | **PASS.** CR-HM-14 imports/readers/writers and response facts are excluded. Financial-table row fingerprints remain identical throughout the journey and manage-only payment commands; settlement/entitlement HTTP aliases are absent. CR-HM-13's published `authoritativeForEntitlement` boolean is an eligibility marker, not an earned entitlement, payable, reconciliation or settlement record; it is preserved rather than incorrectly stripped. |
| FM / SaaS firewall | **PASS.** Non-Handyman SLA types (`WORK_ORDER`, `FM_WORK_ORDER`, `SAAS_TICKET`, `ASSET_WARRANTY`) fail validation. No FM work-order, asset-warranty, SaaS billing/subscription or settlement import/query fallback exists in the inspected transport projections/wrappers. Focused suites exercise the associated response and route firewalls. |
| No duplicate lifecycle authority | **PASS.** Governance, all migrations, frozen Handyman lifecycle guards, shared SLA/definition/performance owners, CR-HM-14, and inspected FM/SaaS/scheduler/idempotency owners remain unchanged across PART 01–07. No `src/` or dependency changes occur in PART 08. Entire-row fingerprints of Handyman and shared SLA tables stay identical before/after the read/denial matrices, detecting updates as well as inserts/deletes. |
| No prohibited feature surface | **PASS.** Availability/performance mutation, BAST provider lifecycle, ledger-open, warranty-start, field-rework and financial/FM aliases are absent from the bounded Care surface. Existing provider/field operations remain owned by their pre-existing authorities. |

## 4. CONTRACT certification and documentation-only findings

**PASS.** The harness enumerates **40 Customer Care operations (26 GET + 14
POST)** and four inherited intake/field-command registrations relevant to the
journey/firewall: **44 documented mounted operations**, exactly one registered
route per method/path. It validates **44 actual full HTTP success samples**
(including repeated subject/command cases) against endpoint-bound OpenAPI
schemas, local references, required fields, enums, scalar types, formats,
patterns and declared bounds. It does not validate only `body.data` while
ignoring the surrounding success envelope. Focused suites cover each PART's
remaining success/error/decision/replay branches.

The new harness exposed documentation defects that the older presence-only
contract assertions did not detect. They are closed in this certification
**without changing any runtime response or lifecycle behavior**:

| Finding | Documentation-only resolution |
| --- | --- |
| Nine PART03/B5 GET schemas described the DTO at the response root although runtime returns a success envelope | Wrap the existing arrival/work/material and six evidence/QC/defect GET DTOs under `SuccessEnvelope.data`; do not change the payload fields or add endpoints. Update the PART03 test to assert both envelope and the same payload schema references. |
| Shared `SuccessEnvelope.data` was incorrectly object-only, contradicting existing request/availability array payloads | Leave generic `data` unconstrained and let each existing endpoint's concrete schema specify its type. Success/meta requirements remain unchanged; no runtime serializer changes. |
| B7 warranty-head enum borrowed claim/rework statuses | Align documentation to the frozen owner `HANDYMAN_SERVICE_WARRANTY_STATUSES`: `CLAIM_OPEN` and `REWORK_COMPLETE`, not claim `CLAIM_SUBMITTED` or rework `REWORK_VERIFIED`. No domain status vocabulary is changed. |
| B7 published `contractVersion` was documented as integer `1` | Document the existing string literal `'1'` from `HANDYMAN_SERVICE_WARRANTY_CONTRACT_VERSION`. |
| B4 Lead BIGSERIAL sequence was documented as a JSON integer | Document existing decimal-string wire serialization of `leadSeq`; no runtime cast or precision-losing conversion is introduced. |
| Six B5 GET summaries/descriptions still claimed Lead-gated reads | Describe the implemented `tenant_company.read` + `canAccessClient` Customer Care GET boundary and explicitly retain the field POST Lead firewall. |

The harness also compares the path/method inventory with `b87d72f`: no new API
path or method is introduced by these corrections. Its validator has negative
sanity probes so missing required fields/invalid frozen enums cannot pass
vacuously. No schema/status/lifecycle authority is invented in production.

## 5. Focused verification only

| Suite | Final result |
| --- | --- |
| `tests/handyman-customer-care-request-reads.test.ts` (PART 01) | 4/4 |
| `tests/handyman-provider-availability.test.ts` (PART 02) | 4/4 |
| `tests/handyman-customer-care-field-reads.test.ts` (PART 03) | 6/6 |
| `tests/handyman-customer-care-qc-bast.test.ts` (PART 04) | 5/5 |
| `tests/handyman-customer-care-ledger.test.ts` (PART 05) | 5/5 |
| `tests/handyman-customer-care-warranty.test.ts` (PART 06) | 5/5 |
| `tests/handyman-customer-care-sla-status.test.ts` (PART 07) | 5/5 |
| `tests/handyman-customer-care-transport-certification.test.ts` (PART 08 harness) | 5/5 |
| **TOTAL** | **39/39; 8 suites; 0 failures/cancellations/skips** |

Reproduction:

```sh
ASENTRA_USE_EMBEDDED_POSTGRES=true NODE_ENV=test LOG_LEVEL=error \
  npx tsx --test --test-concurrency=1 \
  tests/handyman-customer-care-request-reads.test.ts \
  tests/handyman-provider-availability.test.ts \
  tests/handyman-customer-care-field-reads.test.ts \
  tests/handyman-customer-care-qc-bast.test.ts \
  tests/handyman-customer-care-ledger.test.ts \
  tests/handyman-customer-care-warranty.test.ts \
  tests/handyman-customer-care-sla-status.test.ts \
  tests/handyman-customer-care-transport-certification.test.ts

git diff --check
```

Only these focused suites/the certification harness and diff checks were run.
**No full repository test suite, typecheck, build, dependency change or CI run.**
Transient embedded databases/logs are not committed.

## 6. BLOCKERS / exit decision

- Frozen governance BLK-01..BLK-06: **NONE active**. Dedicated reads close the
  Lead-versus-Care transport gap, B7 transport guards the published readers,
  and CR-HM-14/FM/SaaS boundaries remain intact.
- Certification contract findings: **CLOSED**, documentation/test-only.
- New feature/runtime/lifecycle/migration/dependency work: **NONE**.
- **PART 08 complete. STOP.**
