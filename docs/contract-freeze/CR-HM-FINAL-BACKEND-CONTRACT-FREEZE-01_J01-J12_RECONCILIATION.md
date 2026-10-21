# J01–J12 Reconciliation against Source, OpenAPI, RBAC and Schema

Baseline `8b80f92` (PR #48 + PR #50 merged). Method: runtime route census
(`tests/helpers/openapi-census.ts`, Express stack walk) vs `docs/api/openapi.yaml`,
route-file `requirePermission(...)` scan, migration registry inspection, and the
focused suites listed in the freeze candidate. `EXISTING` = HTTP seam + service
authority + persistence + focused evidence in this repository.

**Freeze-02 amendment (CR-HM-BACKEND-CONTRACT-FREEZE-02, PR #51, 2026-10-21):**
every "route-only (FG-01)" note below is historical — all 67 operations are now
documented in `docs/api/openapi.yaml` (269/269 parity) with the operationIds
cited in the three consumer handoffs. Journey verdicts are unchanged; no
production behavior changed.

| Journey | Verdict | Source (modules) | OpenAPI | RBAC (route files) | Schema | Evidence |
|---|---|---|---|---|---|---|
| J01 Master data (Client/Property/Building/Unit/Tenant/PIC/Provider) | EXISTING | `clients`, `properties`, `buildings`, `spaces`, `tenant-companies`, `tenant-pics`, `tenant-import`, `apartment-master`, `vendors` | units/parties/tenant-import/verification merged into main spec **by this CR** (was supplemental-only) | `tenant_company.read|manage`, `space.read|manage`, `unit_party.read|manage` | 0012–0019, 0456, 0457 | `cr-hm-be-client-master-01` 10/10, `cr-hm-master-ind-01` 9/9, `cr-hm-master-tenant-batch-01` 9/9 |
| J01 Intake / triage / **cancellation** | EXISTING | `handyman-requests` (+ cancellation service), `handyman-care-workspace`, `handyman-care-authority`, `tenant-intake` | cancel + cancellation + Care cancel documented (PR #48) | `tenant_company.manage` (staff cancel), `handyman.care.building` (Care cancel) | 0378–0380, **0459** | `handyman-e2e-capability-closure` 4/4 (incl. persisted CANCELLED) |
| J01 Tenant/PIC identity binding | EXISTING | `handyman-tenant-decision-authority`, `tenant-pics`, `handyman-request-parties` | care request parties added by this CR | session-derived actor; no direct Tenant login (`directTenantLogin:false`) | 0425–0430, 0450, 0456/0457 party roles | care-actor suites (prior waves, not re-run) |
| J02 Inspection (visits, inspector, slot consent, diagnosis) | EXISTING, **partially route-only in OpenAPI (FG-01)** | `handyman-appointment-contract`, `handyman-inspector-assignments-api`, `handyman-field-feed` | visits/inspector/slot-confirm **route-only** (7 ops) | `tenant_company.read|manage` | 0381, 0431, 0434, 0438 | `handyman-e2e-finance-close-api` chain; inspector suites prior wave |
| J03 Quotation / approval / DP | EXISTING | `handyman-quotations-api`, `handyman-quotations` | documented (13 ops) | `tenant_company.read|manage`; decision bound to Tenant/PIC authority | 0391–0394, 0458 (DP terms) | finance-close E2E 6/6 |
| J04 Dispatch / permits / arrival | EXISTING, dispatch **route-only (FG-01)** | `handyman-scope-assignments-api`, `handyman-dispatch-api`, `handyman-arrival-verification-api`, readiness modules, permit platform modules | assignment/arrival documented; dispatch readiness/release/cancel **route-only** (4 ops) | `tenant_company.read|manage` | 0395–0400, 0439, 0440, 0441 | scope-assignment + dispatch suites prior wave |
| J05 Field execution (work sessions, crew) | EXISTING | `handyman-work-sessions-api`, `handyman-field-feed`, `handyman-worker-profile` | work-session commands documented; field feed/profile **route-only** | auth-only (Crew Lead/assigned worker enforced in service); reads `tenant_company.read` | 0385–0387, 0401 | work-session suites prior wave |
| J06 Materials / variations | EXISTING, purchasing+variations **route-only (FG-01)** | `handyman-material-execution-api`, `handyman-material-purchasing`, `handyman-scope-variations` | material-lines documented; material-purchases & variations **route-only** (19 ops) | ops lane `tenant_company.*`; field lane auth-only | 0402, 0435, 0436 | material/variation suites prior wave |
| J07 (persona matrix: material purchasing) | EXISTING — merged into J06 row above in lifecycle terms | as J06 | as J06 | as J06 | 0436 | as J06 |
| J08 QC / defects / rework | EXISTING | `handyman-evidence-qc-api`, `handyman-evidence-qc` | documented (evidence, qc-runs, defects) | `handyman.qc.manage` (+ACTIVE supervisor reporting line, non-crew), `handyman.qc.configure` for checklists | 0403, 0442–0444 | QC suites prior wave; guarded-BAST harness |
| J09 BAST | EXISTING | `handyman-bast-api`, `handyman-bast-worker-api`, `bast-documents` | documented incl. worker lane | customer lane `tenant_company.*`; worker lane auth-only; `handyman.bast.manage` (0446) | 0404, 0405, 0445 (QC-pass binding), 0446 | BAST suites prior wave. External e-signature (PSrE) is **not** implemented — SD-01…SD-15 remain Proposed (FG-06) |
| J10 Finance (ledger, payments, proof, allocations, corrections) | EXISTING; final-close/invoice-reconciliation **route-only (FG-01)** | `handyman-customer-ledger-api`, `handyman-finance-close-api`, `handyman-payment-proof` | ledger documented; `final-close`, `final-close/readiness`, `invoice-reconciliation` **route-only** (3 ops) | `handyman.finance.read|manage`, `finding.close` (FINAL CLOSE), Care proof separate from Finance confirm | 0410–0414, 0432, 0433, 0447, 0448, 0458 | finance-close E2E 6/6; reconciliation-close 2/2. Bank-receipt attestation **not** in candidate (PR #47 open, FG-05) |
| J11 Warranty / FINAL CLOSE | EXISTING | `handyman-service-warranty-api`, claims/reworks, `handyman-finance-close-api` | documented | `tenant_company.manage` (claims), auth-only Crew Lead (rework start/complete), `finding.close` (close) | 0419–0422, 0458 | warranty suites prior wave; FINAL CLOSE in reconciliation-close 2/2 |
| J12 BM fee / settlement / disputes | EXISTING | `handyman-commercial-agreements`, `handyman-bm-fee-rules`, `handyman-financial-entitlements`, `handyman-settlement`, `handyman-sla-status-api` | documented incl. dispute resolution (PR #48) | `handyman.commercial.manage`, `handyman.settlement.manage` (never implied by finance/tenant permissions) | 0406–0409, 0415–0418, **0460** | capability-closure 4/4 (RELEASED/UPHELD persisted, money facts untouched) |
| Cross: RBAC / isolation / audit / idempotency | EXISTING | `auth`, `roles`, `permissions`, `context-access`, `audit`, `request-idempotency` | foundation documented; **only 11/202 Handyman ops carry `x-required-permission` (FG-02)** | default-deny; exact-Building; Client-scoped 404s | 0001–0019, 0448, 0450, 0452–0454 | `openapi-contract` 7/7 (this CR) |

**Net reconciliation delta vs the pre-PR#48 matrix:** J01 cancellation and J12
dispute adjudication move MISSING → EXISTING (PR #48, migrations 0459/0460,
re-verified here). Master-data OpenAPI moves supplemental → main spec (this CR).
The remaining contract debt is documentation completeness (FG-01/FG-02), not
missing engines: no journey requires a new backend engine.
