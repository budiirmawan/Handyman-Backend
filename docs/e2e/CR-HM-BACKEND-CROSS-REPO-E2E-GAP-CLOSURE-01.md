# CR-HM-BACKEND-CROSS-REPO-E2E-GAP-CLOSURE-01

Date: 2026-10-21. Repository: **Handyman-Backend only**.
Baseline: fetched `origin/main@5994446ceabeba4f3bea423ffa5db9b9ce4c6feb` (merged #52); session branch starts at exactly this commit.
Contract: Freeze Candidate v1.2, **not FINAL FREEZE**. This is a descriptive contract erratum and test repair, not a new business-authority version.

## 1. Audit result and scope decision

No runtime defect was confirmed by this audit. In particular, **do not add a field defect endpoint or grant `tenant_company.read` to field PICs**: both list and detail already admit the current assigned Crew Lead. The confirmed discrepancy is the OpenAPI list description, which incorrectly described a Care-only permission gate. Correct that description and prove the real HTTP path with a genuine session over disposable PostgreSQL.

Changes:
- OpenAPI: corrected list authority description and list/detail summaries only. Paths, methods, operationIds, DTOs, status enums, guards and error arrays unchanged.
- Added HTTP positive/negative defect-discovery regression to the existing embedded QC suite.
- Repaired that suite's duplicate workforce/building fixture binding; hoisted its existing failed-defect helper for reuse. No production authority weakened.
- Added three contract regression tests for field read authority, reinspection schema/parser, staff Care origin and optional Tenant PIC user binding.
- Updated the canonical pending-gap register and supplied consumer deltas below.

Authoritative spec SHA-256 after erratum:
`b5edd56f696b3f75ff5f2b5f17ac02366fbab36322908c580faf2f2fc9d10948`.
The v1.2 historical pin `f2ffec3f...` in earlier reports remains historical; it is not the hash of this erratum. Census remains **269 Handyman operations**, zero missing/phantom operations, zero duplicate operationIds and zero broken local refs (freeze-03 regression suite).

## 2. Dependency / gap matrix

Classifications are based on Backend source, not inferred consumer implementation. Consumer PR text could not be retrieved: `gh pr view 35 --repo budiirmawan/Handyman-Frontend`, corresponding Operations #24 and Mobile #15 queries each returned **Resource not accessible by integration (repository)**. No consumer checkout or changes were made. Exact meanings of the numbered consumer findings must be supplied by their owners; we do not invent a mapping from number to feature.

| Dependency | Classification | Exact Backend evidence | Disposition |
|---|---|---|---|
| Frontend B1 | ENVIRONMENT BLOCKED | Consumer PR #35 inaccessible; detailed finding absent from this repository | Obtain finding text, path and `error.code`; no runtime fix asserted |
| Frontend B2 | ENVIRONMENT BLOCKED | Same | Same |
| Frontend B3 | ENVIRONMENT BLOCKED | Same | Same |
| Frontend B4 | ENVIRONMENT BLOCKED | Same | Same |
| Mobile BD-7 | ENVIRONMENT BLOCKED | Consumer PR #15 inaccessible; numbering not reconstructable from Backend | Obtain exact finding text |
| Mobile BD-8 | ENVIRONMENT BLOCKED | Same | Same |
| Mobile BD-9 | ENVIRONMENT BLOCKED | Same | Same |
| Mobile BD-10 | ENVIRONMENT BLOCKED | Same | Same |
| Mobile BD-11 | ENVIRONMENT BLOCKED | Same | Same |
| Mobile BD-12 | ENVIRONMENT BLOCKED | Same | Same |
| Field PIC defect discovery (independent of unavailable Mobile numbering) | EXISTING runtime; CONTRACT-ONLY GAP | `handyman-evidence-qc-api.routes.ts` GET scope defects/detail have auth only; controller `getDefectsByScopeHandler`/`getDefectHandler` call canonical reads; service `qcDefectReadAuthorityPreamble` enforces exact Building and current assignment or appointed Supervisor or staff read permission | Erratum addressed here; no new endpoint/permission |
| Care `createBuildingCareRequest` origin | EXISTING | `handyman-care-tenant-request-gateway.service.ts` work callback creates attribution with `originChannel: 'CUSTOMER_CARE_BACKEND'`; OpenAPI operation description agrees; gateway HTTP suite passes | No discrepancy reproduced. Do not confuse BM exchange creation (`BM_SUPER_APP`) with staff Bearer creation |
| Care cancellation eligibility projection | POLICY DECISION REQUIRED (optional read enhancement), not confirmed broken command | `handyman-request-cancellation.service.ts` `cancelHandymanRequest`: row lock, replay, cancellable-state check, execution-scope gate, append-only cancellation + operational event. `getHandymanRequestCancellation` reads an existing fact, **not** eligibility; Care gateway routes expose authorized cancel | Current command is authoritative. No consumer evidence establishes a mandatory preflight DTO. If requested, agree which Care credential lane and existing projection to extend; derive reasons from shared canonical guards, never infer authorization from status alone. No new endpoint or speculative eligibility boolean added |
| Operations bank-account / receipt-attestation mismatch | POLICY DECISION REQUIRED | FG-05; `gh pr view 47` confirms OPEN. Current `ConfirmHandymanCustomerPaymentInput` and `confirmHandymanCustomerPayment` have no bank-account/attestation input. Frozen confirm uses canonical `decide`; PR #47 is not merged | Do not send draft PR #47 fields. Product/Finance must decide whether to adopt attestation, with rebased migration numbering and separate verification |
| Operations payment proof vs confirm | EXISTING | `handyman-payment-proof`, `handyman-customer-ledger-api.routes.ts` Finance-only confirm/reject, `handyman-finance-close-api.routes.ts` Manager `finding.close` | Proof != verified funds != FINAL CLOSE; 6 finance-close + 2 reconciliation scenarios green |
| Operations reinspection schema | EXISTING | OpenAPI `requestHandymanDefectReinspection` references `HandymanDefectRequestReinspectionRequest`, requiring reason plus inherited version/key; `parseDefectTransitionBody` matches; QC service binds a new FAILED run | No schema edit needed; regression test added. This is Supervisor rejection/re-repair, not a PIC request-to-pass action |
| Operations permission metadata | EXISTING | Freeze-03 suite verifies 179 permission-annotated operations, composite-authority exceptions, seeded membership, security/error metadata and parity | Do not treat absent `x-required-permission` as public/unrestricted or require all composite read lanes to own staff permission |
| Operations Tenant/PIC binding | EXISTING | `tenant-pic.validation.ts` `parseCreateTenantPicBody`: `picName` required, `userId` optional; OpenAPI `CreateTenantPicRequest` agrees. `UpdateTenantPicRequest.userId` nullable. `handyman-tenant-decision-authority.ts` owns personal decisions | A contact alone is not a linked decision actor. No Care/Operations impersonation; master-data tests and Tenant PIC CRUD pass |
| FG-03 consumer integration | ENVIRONMENT BLOCKED | No accessible consumer reports or integrated staging run | Remains open; see exact next action §7 |
| FG-04 staging E2E / migration status | ENVIRONMENT BLOCKED | No staging credentials/environment supplied or exercised | No Railway/live PASS; no production migration |
| FG-05 bank attestation | POLICY DECISION REQUIRED | PR #47 still OPEN; migration 0459 already belongs to cancellation on main | Remains open, not revived |
| FG-06 external BAST e-signature | POLICY DECISION REQUIRED | BAST-SIGN-00 unresolved decisions; authenticated acceptance remains existing implementation | No proposed Legal/Security policy enters runtime |
| FG-10 historical seven-suite debt | CONFIRMED DEFECT (test fixtures, historical evidence) | Freeze-03 register documents pristine A/B evidence | Not reopened as a runtime defect or claimed repaired; those seven suites not re-run here |
| New QC verification debt | CONFIRMED DEFECT (test-only) | Pristine #52 suite: 0 pass / 23 fail, every case `WORKFORCE_BUILDING_ALREADY_ASSIGNED`; `crewFixture` already calls `assignBuildingToWorkforce`, suite duplicated it | Duplicate removed; 24/24 pass including new HTTP scenario. Addressed pending merge |

The cross-repo labels remain explicitly blocked, not silently treated as closed merely because a related Backend capability exists.

## 3. Changed-operation security/contract review

Only two GET operation descriptions/summaries changed:

| Path (under `/api/v1`) | Method / operationId | DTO / authority |
|---|---|---|
| `/handyman/execution-scopes/{executionScopeId}/defects` | GET `listHandymanDefectsByScope` | Success envelope `data: HandymanDefectScopeView` (`defects`, including ids and versions); Bearer session; current assigned PIC, appointed Supervisor, or `tenant_company.read` staff, all exact-Building scoped |
| `/handyman/defects/{defectId}` | GET `getHandymanDefectDetail` | Success envelope `data: HandymanDefectDetailView` (defect + append-only events); scope resolved from stored defect, same service preamble |

- Client/building isolation: `assertBuildingScopedResourceAccess` receives the stored execution scope's client/building. No request actor/tenant/building override trusted. Existing suite tests sibling-Building as well as foreign-Client denial; new HTTP test covers foreign Building.
- Assignment: `resolveHandymanAssignmentLead` resolves active assignment/current lead; superseding the assignment makes both GETs return 403 `HANDYMAN_DEFECT_NOT_AUTHORIZED`, even with the same valid token. This is the PIC_PEKERJAAN/Crew Lead, not every crew member and not the customer Tenant PIC.
- Supervisor authority unchanged: PIC cannot `pass-reinspection`, open QC or set QC results. Current supervisor reporting line + explicit `handyman.qc.manage` remain required for decisions.
- Error behavior unchanged: malformed IDs 400, missing authentication 401, unauthorized field actor 403, missing scope/defect 404; `BUILDING_ACCESS_DENIED` comes from the shared isolation guard. Local `x-error-codes` remain as frozen; shared middleware errors are not expanded in this descriptive patch.
- Idempotency/concurrency: GETs do not write and do not accept mutation idempotency input. They are snapshots, not promises of later mutation eligibility. Existing mutations still lock, enforce expectedVersion, idempotency fingerprint/replay and current authority. No concurrent read authorization guarantee beyond existing service behavior is introduced.
- Audit: no mutation/audit rows are created by these GETs. Existing defect event chain and authenticated mutation provenance preserved. No migration or audit vocabulary change.

Other audited operations have **no behavior or schema change**. Staff Care creation retains authenticated creator separate from represented Tenant/PIC and immutable origin attribution; quotation and variation customer decisions still require the linked customer's own user session. Finance confirmation remains the received-funds decision and is not external bank verification/attestation.

## 4. J01–J12 completeness check (user lifecycle sequence)

The existing authoritative reconciliation in `docs/contract-freeze/*_J01-J12_RECONCILIATION.md` remains the detailed source map. This audit checks the following chain without adding an engine or asserting a fresh full-product certification:

| Stage | Canonical source and blocking guard | Fresh evidence / limitation |
|---|---|---|
| 1 SaaS/BM onboarding and master data | platform provisioning/entitlements, clients/buildings, apartment-master; authenticated scoped master writes | Tenant batch 9/9; full SaaS onboarding NOT TESTED in this CR |
| 2 Tenant/PIC binding and Care intake | tenant-pics, request-parties, Care authority/gateway; exact Building and represented identity vs creator separation | Tenant PIC 9/9; staff gateway 9/9; Care exchange creation 10/10 |
| 3 Triage/inspection | requests triage/diagnosis, inspector/appointment contract; valid transition and assigned inspector | finance-close chain; independent scheduling variants NOT TESTED |
| 4 Diagnosis/quotation | quotations/version lines, server pricing/composition | finance-close/reconciliation chain |
| 5 Customer authorization | tenant-decision-authority, quotation decisions, variations; linked PIC-personal user only | existing finance scenarios; no authority changed |
| 6 Scheduling/permit/dispatch | scheduling, dispatch/readiness, arrival; required authoritative release/permit prerequisites | source audit; full independent permit/arrival matrix NOT TESTED |
| 7 Field execution/materials | work-sessions, assignments, material-execution/purchasing; current Crew Lead and stock/usage facts | finance-close/reconciliation chain; not every procurement variant |
| 8 Variations/approvals | scope-variations; operational decision separate from PIC-personal tenant decision | reconciliation + QC variation scenarios |
| 9 Supervisor QC/rework | evidence-qc; current Supervisor, completed repair session, verified bytes, latest QC run and optimistic version | 24/24 QC authority suite, HTTP discovery and negative tests |
| 10 BAST acceptance/rejection | bast/worker API; latest guarded QC PASS then separate customer sign-off | QC/BAST scenarios + finance-close chain; external e-signature remains FG-06 |
| 11 Invoice/payment/FINAL CLOSE | financial reconciliation, customer payments, finance-close; Finance decision, allocation/readiness then Manager close | 6/6 finance-close and 2/2 reconciliation (including deny paths) |
| 12 Warranty/cancel/dispute/settlement/audit | service-warranties/reworks, request-cancellation, settlement; pre-commitment cancel, held disputes block release, immutable money and audit | 4/4 capability closure; warranty in finance-close chain; live notifications/provider integrations NOT TESTED |

No runtime, migrations, lifecycle enums, or authority changed. This limits regression risk; it is **not** proof that every production journey/environment passed.

## 5. Verification evidence

All commands executed on 2026-10-21. Database tests below use disposable local embedded PostgreSQL 18, actual migrations and actual HTTP/service calls; never Railway or production.

| Check | Result | Evidence |
|---|---|---|
| `npm run typecheck` | PASS | Final `tsc --noEmit`, exit 0 |
| Focused run A: `NODE_ENV=test LOG_LEVEL=error npx tsx --test --test-concurrency=1 tests/handyman-qc-supervisor-authority.test.ts tests/handyman-contract-freeze-03-openapi.test.ts tests/openapi-contract.test.ts tests/mobile-openapi-completeness.test.ts tests/handyman-e2e-finance-close-api.test.ts` | PASS | **55 tests, 55 pass, 0 fail, 0 skipped** |
| Focused run B (same tsx flags): cross-repo-gap-contract, e2e-financial-reconciliation-close, care-request-create, e2e-capability-closure, care-tenant-request-gateway-http, tenant-pics, cr-hm-master-tenant-batch-01 | PASS | **46 tests, 46 pass, 0 fail, 0 skipped**; external disposable PG wrapper provided isolated `asentra_test` for suites using `ensureTestDatabase`; embedded suites also start/stop their own clusters |
| Runtime/OpenAPI parity + contract integrity | PASS | Included in A: all Handyman routes documented, no phantom ops, duplicate ids or broken local refs; metadata/permission regression guards |
| Initial modified QC run | FAIL (resolved) | Duplicate fixture caused 24 failures (23 old + new case). After fixture repair the first new test run also exposed helper lexical scope; hoisted existing helper; final A green |
| Pristine #52 comparison | FAIL (pre-existing test setup) | `git archive origin/main` extracted to `/tmp/hm-pristine`, same dependencies, original QC suite: **23 tests, 0 pass, 23 fail, 0 skipped**, `WORKFORCE_BUILDING_ALREADY_ASSIGNED`; source tree unmodified |
| Initial mixed run without wrapper | SKIPPED (superseded) | 9 cases skipped due unavailable isolated DB. Run B supplies disposable PG and re-runs these suites with **0 skips**. Initial skips are not success evidence |
| Historical FG-10 seven suites | NOT TESTED | Previous pristine A/B evidence remains in freeze-03 report; no closure claimed |
| Full repository suite / full J01–J12 exhaustive matrix | NOT TESTED | Focused scope only |
| Consumer apps / Railway staging / production migration status / live end-to-end | NOT TESTED / ENVIRONMENT BLOCKED | No remote environment run; no live PASS or FINAL FREEZE |
| `git diff --check` | PASS | No whitespace errors |

Run B reproduction: start a disposable embedded-postgres cluster with trust authentication on an unused local port; export `DB_HOST=127.0.0.1 DB_PORT=<port> DB_NAME=asentra_test DB_USER=postgres DB_PASSWORD='' DB_SSL=false NODE_ENV=test LOG_LEVEL=error`; invoke the seven listed `tests/<name>.test.ts` files serially; stop/delete that cluster. Never point this destructive fixture set at staging/production. Existing `tests/helpers/embedded-test-db.ts` supplies the bootstrap pattern.

## 6. Migration and deployment impact

**None.** No production source or migration modified; 459 registered migrations, head 0460 unchanged, 0449 reserved. No new permissions, seeds, configuration, endpoints or deployment prerequisites. No production migrations or deployment executed. Documentation consumers should refresh the spec artifact/hash; no backend binary rollout required for these already-existing read routes. Test changes affect CI/disposable test setup only. PR #47's colliding 0459 is deliberately not imported; if adopted later, choose a number after the then-current registry head, not a blindly hardcoded historical number.

## 7. Consumer handoff and exact next action

### Mobile
1. Using the current assigned **field Crew Lead's own Bearer session**, GET `/api/v1/handyman/execution-scopes/{executionScopeId}/defects` and take `data.defects[].id` / version. Detail: GET `/api/v1/handyman/defects/{defectId}`.
2. Do not require/request `tenant_company.read` for these reads; do not use a Care-only client wrapper or a fabricated identifier. Superseded assignment/foreign Building must fail.
3. Keep start/record rectification as the PIC lane; request-reinspection/pass and QC decisions remain Supervisor-only. Personal customer authorization is a different identity from the field PIC.

### Operations
1. Generate DTOs from this authoritative spec, not draft PR #47: no required bank-account/receipt-attestation input for payment confirm. Preserve proof submission → Finance verification → Manager FINAL CLOSE separation.
2. For Supervisor request-reinspection send `expectedVersion`, `idempotencyKey`, **reason** using `HandymanDefectRequestReinspectionRequest`, not the base transition DTO. The new failed QC run is server-validated, not client-selected.
3. Permission annotations are not a complete Boolean authorization model. Composite field/Supervisor read rules and exact Building/current assignment checks still apply.
4. Tenant PIC create requires `picName`; `userId` is an optional existing-User binding, not a customer credential generator. Customer decisions require the PIC-linked user's own authenticated session; Operations cannot record them as the customer.

### Frontend / Customer Care
1. Staff `createBuildingCareRequest` uses `CUSTOMER_CARE_BACKEND`; BM handoff/exchange uses `BM_SUPER_APP`. Preserve actual staff creator separately from represented customer.
2. Cancellation POST is pre-commitment only. Handle `HANDYMAN_SERVICE_REQUEST_ALREADY_CANCELLED`, `HANDYMAN_SERVICE_REQUEST_CANCEL_NOT_ALLOWED`, `HANDYMAN_SERVICE_REQUEST_CANCEL_COMMITTED` and key-conflict errors; do not call the existing cancellation-fact GET an eligibility endpoint. Re-evaluate outcome server-side, never infer authorization from a locally displayed button.
3. No Care/Operations proxy of personal quotation or variation decisions. If an eligibility projection is required, submit the exact existing screen, credential lane and missing response field for review; absence alone is not justification for a new API.

**Next exact cross-repo action:** Frontend #35 owner supplies B1–B4 text plus called path/method, credential persona and observed `error.code`, then integrates the staff Care origin/cancellation behavior above against #52 + this spec erratum. Operations #24 follows with confirm/reinspection/PIC DTO checks; Mobile #15 then verifies field defect discovery with a permission-free current Lead token and revoked-assignment negative case. Record consumer SHAs and actual staging results in FG-03/FG-04. If repository access is intended, reconnect/authorize GitHub for those repositories; do not share credentials in chat. Do not declare FINAL FREEZE, merge or deploy from this report.
