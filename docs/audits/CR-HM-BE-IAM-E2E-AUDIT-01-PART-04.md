# CR-HM-BE-IAM-E2E-AUDIT-01 — PART 04

## Delivery and boundary

- **Date:** 2026-10-25 (Asia/Jakarta).
- **Scope:** BAST & Customer Acceptance Authority Hardening — **PART 04 ONLY**.
- **Repository / branch:** `budiirmawan/Handyman-Backend` / `arena/3a9f4872-handyman-backend`.
- **Verified starting HEAD:** `61487be5c1a60e8d3c9f9db144ac5b230ecf5f33`; local/origin matched and the working tree was clean before PART 04.
- **Inputs:** [PART 01](CR-HM-BE-IAM-E2E-AUDIT-01-PART-01.md), especially P0-03 and the customer handoff portion of P1-02; [PART 02](CR-HM-BE-IAM-E2E-AUDIT-01-PART-02.md); [PART 03](CR-HM-BE-IAM-E2E-AUDIT-01-PART-03.md), including its governed identity-link policy and current-request decision guard.
- **Outcome:** **DONE for bounded PART 04 under the explicitly approved electronic-consent contract.** Prospective application-path remediation is verified locally. Production remains **NO-GO**; historical signers, deployed identity bindings and live customer clients are not certified by these tests.
- **Delivery:** the commit containing this report is the PART 04 delivery, directly following the starting HEAD above. The final delivery message records its exact SHA, origin match and clean-tree verification. No PR, production action or PART 05 execution.

### Explicitly approved product contract

The authenticated **personal, current request PIC** explicitly choosing ACCEPT/REJECT is electronic consent. Backend reconstructs/verifies a canonical SHA-256 manifest from authoritative issued BAST/version, request/tenant/Building, approved quotation, bound QC and optional genuine evidence. A supplied digest, role, image, staff assertion or contact field does not prove identity. `/sign-off` is the existing **customer decision alias**, not provider signing.

This is **not a certified digital signature**, external identity verification, independently verified delegation, or a certification of rendered PDF bytes. No delegate facility exists in source; none is invented. Missing personal authority, trustworthy issued manifest, genuine required QC or evidence bytes fails closed. Full client codec/input/retry details are in [the consent contract](../handyman/CR-HM-BAST-CUSTOMER-CONSENT-01_CONTRACT.md).

## 1. Source gaps and bounded fixes

| Source finding at starting HEAD | PART 04 remediation |
| --- | --- |
| `handyman-bast.service.ts` customer decisions used exact-Building access but explicitly treated local Care as the recorder/customer surrogate. The route's generic `tenant_company.manage` grant did not prove the request's customer. | Customer commands now reuse PART 03's exact-request personal PIC authority inside the mutation transaction, with live permission, exact Client/Building and scope/request/PIC consistency. No staff/Owner/admin/Lead or unverified-delegate fallback. |
| A supplied 64-hex `signatureDigest` could satisfy the signature check without binding authenticated intent to an issued document. | Backend reconstructs the canonical issued-version manifest. ACCEPT must match its SHA-256; REJECT may omit the digest and Backend calculates/stores it, but a supplied digest must match. Arbitrary valid-length hex is denied. |
| Optional sign-off evidence checked only execution-scope ownership. | Same Client/scope, FINALIZE event, nonempty immutable file set, managed storage, actual byte length and SHA-256 are checked under the evidence-record SHARE lock. Attachment evidence is not identity proof. |
| Customer replay preceded current personal authority and did not bind the original actor/canonical payload. Provider ISSUE/VOID and customer decisions could acquire BAST/scope in differing order. | Scope → BAST locking for ISSUE/VOID/customer decisions aligns with PREPARE/QC/close. Current PIC/account SHARE locks survive until commit. Authority precedes replay; original actor/action/digest/evidence/reason and receipt must match. |
| Raw ACCEPTED/nonempty sign-off could qualify legacy staff/digest-only history in read flags and downstream BAST gates. | Existing immutable event metadata stores a Backend receipt; coherent head/event/sign-off/manifest/hash/actor/time/QC/version is required by qualified read flags, warranty START, variation final-charge eligibility and Manager final close. Legacy rows are preserved, not retrospectively certified. |
| Customer rework AUTHORIZE and chargeable ACCEPT/REJECT had Building-only customer authority/replay. | These existing customer decisions reuse the same personal request-PIC guard and original-actor replay protection. Existing provider, warranty and payment-trigger engines remain. |
| Permissive BAST request parsing could silently ignore caller signer/context claims; consumer docs described opaque digests/staff sign-off and omitted existing read fields. | Unknown customer decision fields are rejected. Existing schemas/paths remain, with three strict request schemas and corrected authority/digest/read documentation. No new endpoint or payload field. |

### Traced source and preserved engines

- **HTTP/session:** existing BAST API routes/controller/validation and field BAST routes/service. Actor remains the authenticated local session user, never body signer/customer fields. Existing read permission and provider action guards remain.
- **Domain/history:** existing BAST lifecycle/repository/types and migrations provide DRAFT → ISSUED → ACCEPTED/REJECTED or VOID, immutable events/sign-offs and server timestamps. No parallel acceptance engine or new state is introduced.
- **QC/work:** existing `handyman-qc-pass-gate.ts` verifies genuine independent Supervisor PASS, guarded FINISH, checklist version/items, completed sessions, defect prerequisites and actual QC evidence bytes. PART 04 calls, rather than replaces, this gate. The Handyman Work Order remains the execution scope; no FM Work Order is created or approved by consent.
- **Downstream:** warranty START and variation final-charge eligibility now require the receipt in addition to their existing BAST prerequisites. Final close adds the receipt to the existing QC/BAST, invoice/payment/ledger/reconciliation/warranty/rework/Manager gates. Invoice issuance, payment verification, DP, final-payment proof, allocation, BM-fee calculation and Work Order closure engines are not rewritten or triggered by a customer decision.
- **Related customer paths:** free-rework AUTHORIZE and chargeable-work ACCEPT/REJECT change only personal authority and actor-safe replay. Provider proposal/start/complete/verify and existing chargeable payment triggers remain distinct.

## 2. Authority matrix and exact routes

Paths below are relative to `/api/v1`. All roots are derived from the stored target, not request-body context.

| Operation | Allowed authority | Explicitly not sufficient |
| --- | --- | --- |
| `GET /handyman/execution-scopes/{executionScopeId}/bast`, `GET /handyman/bast/{bastId}` | Existing authenticated read + `tenant_company.read` + exact Client/Building | Read access is not acceptance authority. |
| `POST /handyman/field/execution-scopes/{executionScopeId}/bast/prepare`; `POST /handyman/field/bast/{bastId}/{issue,void}` | Existing `handyman.bast.manage`, exact Building and current Crew Lead, existing lifecycle/QC prerequisites | Provider preparation, issuance, voiding and field completion are not customer consent. |
| `POST /handyman/bast/{bastId}/accept` | ACTIVE personal current request PIC/account/Company, live `tenant_company.manage`, exact Client/Building/space occupancy, consistent scope/request/PIC, issued manifest and current genuine bound Supervisor QC PASS | Operations, Care, Manager, Owner (`PLATFORM_ADMIN`), generic admin, Lead, body signer/context/delegate claims, digest alone or another request's PIC. |
| `POST /handyman/bast/{bastId}/reject` | Same personal authority and issued manifest; no new/current PASS required for rejection | Provider staff cannot reject on the customer's behalf. |
| `POST /handyman/bast/{bastId}/sign-off` | Exactly the same customer ACCEPT/REJECT authority and canonical proof | Not provider signing or a secondary weaker route. |
| `POST /handyman/service-warranty-reworks/{reworkId}/authorize` | Same personal current request-PIC authority; existing rework lifecycle | Crew/Operations/provider verification is not customer authorization. |
| `POST /handyman/chargeable-additional-works/{workId}/{accept,reject}` | Same personal current request-PIC authority; existing commercial/payment-trigger lifecycle | Staff review, generic manage or successful payment is not this customer's decision. |
| Supervisor QC | Existing independent Supervisor/reporting-line/QC authority | PIC consent is not QC; a Lead cannot self-QC through role union. |
| Finance/Manager final close | Existing independent Finance/Manager duties and all close prerequisites, now including qualified personal consent | Neither staff role nor ACCEPTED text bypasses payment, QC or close blockers. |

PART 03 identity administration is unchanged: an ACTIVE identity admin needs live `tenant_company.manage` + `user.manage` and exact affected Building/Client authority; no new self-binding, no cross-Company target, only ACTIVE existing targets and valid relationships. A current customer may unlink themselves, not bind a replacement. No past actor is rewritten by relink. PART 02 bounded delegated grant/revocation/default/last-authority protections remain unchanged, not converted to Owner-only administration.

## 3. Canonical provenance, atomicity and history

- **Protocol/method:** `HM-BAST-CUSTOMER-CONSENT-SHA256-V1` / `AUTHENTICATED_REQUEST_PIC`.
- **Frozen serialization:** SHA-256 of UTF-8 `JSON.stringify` of the ordered array documented in the consent contract and exported codec. It binds BAST ID, execution scope, approved quotation version, Client, request, Company, PIC, Building, Backend-issued artifact reference/version, immutable ISSUE event/time, bound QC run, session actor, decision, normalized rejection reason and optional finalized evidence/file snapshot. Files sort by lowercase UUID ascending ASCII.
- **Issued document:** existing Backend artifact mapper yields `BAST/{id}/v2`, version 2. The terminal v3 artifact is not the document the customer accepted. Missing/inconsistent ISSUE provenance, unissued/void/stale BAST or stale QC fails closed. The manifest is a reference to immutable domain facts, not a signed-PDF-byte hash.
- **Receipt:** existing immutable decision event records authenticated actor, database transaction time and private `metadata.customerConsent = { method, manifest, sha256Digest }`; existing immutable sign-off references that event and matching digest/evidence/reason. Head, event and sign-off persist atomically. Database `NOW()` is transaction-start time, not a claimed post-lock human-action timestamp.
- **Replay:** live personal authority is checked before replay. Only the still-authorized original actor with the same action, key and normalized payload can replay the existing receipt. A later authorized replacement PIC cannot adopt the old receipt; the former PIC loses current mutation/replay authority. Replay is historical acknowledgment, not a fresh QC/storage-availability attestation.
- **Races:** scope/BAST row locks serialize competing ACCEPT/REJECT/VOID; PART 03 PIC/account locks serialize governed relink. Tests observe both relink lock orders: a decision already holding authority commits as the original actor before relink, or relink wins and the old actor is denied. Denials and persistence failures leave no partial domain writes.
- **Legacy facts:** raw status, timestamps and immutable old history remain readable. Legacy staff/digest-only ACCEPTED does **not** set `customerAccepted`, `warrantyStartEligible`, `approvedSignOff` or `signOffComplete`, and cannot satisfy the added warranty/variation/final-close receipt gates. Existing historical warranty/payment facts are not erased. No automatic terminal-row repair, re-signing, actor substitution or backfill is performed.

## 4. Exact changed-file inventory — 32 files

### Backend — 16 files

| Path | Change |
| --- | --- |
| `src/modules/handyman-tenant-decision-authority/handyman-customer-scope-authority.ts` | **New:** transaction-bound Work Order → immutable request/tenant/PIC roots, live permission/exact Building, reused PART 03 personal authority. |
| `src/modules/handyman-bast/handyman-bast-customer-consent.ts` | **New:** canonical codec/hash, actual-byte optional evidence, immutable receipt qualification and downstream gate. |
| `src/modules/handyman-bast/handyman-bast.service.ts` | Scope-first locks, personal authority before replay, issued manifest/QC/digest validation, atomic receipt. |
| `src/modules/handyman-bast/handyman-bast.read-contract.ts` | Qualified existing read flags; historical raw status/time preserved. |
| `src/modules/handyman-bast/handyman-bast.errors.ts` | Bounded canonical-digest error detail. |
| `src/modules/handyman-bast/index.ts` | Exports canonical helpers/types and verified downstream gate. |
| `src/modules/handyman-bast-api/handyman-bast-api.controller.ts` | Pass ACCEPT reason to domain validation instead of silently discarding it. |
| `src/modules/handyman-bast-api/handyman-bast-api.validation.ts` | Strict existing customer fields; reject caller signer/context claims. |
| `src/modules/handyman-bast-api/handyman-bast-api.routes.ts` | Authority comment correction only; routes/middleware unchanged. |
| `src/modules/context-access/context-access.service.ts` | Optional executor propagation so exact-Building checks use the caller's transaction, including with one free pool slot. |
| `src/modules/handyman-tenant-decision-authority/handyman-tenant-decision-authority.ts` | Comment-only reuse clarification; PART 03 authority SQL unchanged. |
| `src/modules/handyman-service-warranty-reworks/handyman-service-warranty-rework.service.ts` | Personal customer AUTHORIZE, actor-safe replay and transactional Building check; provider actions retained. |
| `src/modules/handyman-chargeable-additional-works/handyman-chargeable-additional-work.service.ts` | Personal ACCEPT/REJECT and actor-safe replay; payment trigger retained. |
| `src/modules/handyman-service-warranties/handyman-service-warranty.service.ts` | Verified consent supplements existing warranty START prerequisites. |
| `src/modules/handyman-finance-close-api/handyman-final-close.service.ts` | Verified consent supplements existing Manager final-close BAST gate. |
| `src/modules/handyman-scope-variations/handyman-scope-variation.service.ts` | Verified consent supplements existing variation BAST final-charge gate. |

### Tests/helpers — 10 files

| Path | Change |
| --- | --- |
| `tests/handyman-bast-customer-authority-part04.test.ts` | **New:** 50 full-migration, real-session/HTTP, authority/provenance/race/atomicity cases. |
| `tests/helpers/handyman-customer-consent.ts` | **New:** actual current PIC/root lookup, explicit personal test grants and canonical digest. |
| `tests/helpers/handyman-guarded-bast.ts` | Genuine QC fixture now uses personal canonical customer acceptance. |
| `tests/handyman-bast-worker-api.test.ts` | Provider lifecycle retained; personal customer positive decisions. |
| `tests/handyman-bast-signoff-scope-guard.test.ts` | Personal-PIC fixture; disposable embedded PostgreSQL instead of optional skip. |
| `tests/handyman-bast-read-contract.test.ts` | Unverified legacy history is not qualified consent. |
| `tests/handyman-bast-artifact-evidence.test.ts` | Canonical synthetic receipt converter cases and malformed/legacy negatives. |
| `tests/handyman-e2e-finance-close-api.test.ts` | Personal BAST/rework consent in existing Finance/Manager flow. |
| `tests/handyman-e2e-financial-reconciliation-close.test.ts` | Personal canonical ACCEPT and documented `rejectReason` in reconciliation flow. |
| `tests/handyman-scope-variations.test.ts` | Narrow custom BAST schema and explicit canonical consumer prestate; not proof of customer-authentication creation. |

### Documentation — 6 files

| Path | Change |
| --- | --- |
| `docs/handyman/CR-HM-BAST-CUSTOMER-CONSENT-01_CONTRACT.md` | **New:** exact codec, existing read inputs/routes/bodies/errors/retry/legacy and rollout dependencies. |
| `docs/api/openapi.yaml` | Existing six customer operations, strict existing BAST request fields and qualified read descriptions; documents three already-returned read fields. |
| `docs/CR-HM-TENANT-ACTOR-01_AUTHORITY_AND_FRONTEND_HANDOFF.md` | Personal consent and original-actor replay supersede the previously pending BAST boundary. |
| `docs/handyman/CR-HM-BAST-HTTP-01_OPERATIONS_HANDOFF.md` | Provider/read/customer separation and no staff consent UI. |
| `docs/handoffs/HANDYMAN-BAST-DP-INVOICE-PAYMENT-CLOSE-CONTRACT.md` | Verified receipt prerequisite, User-ID PIC authority, actual `/field/` paths and canonical digest. |
| `docs/audits/CR-HM-BE-IAM-E2E-AUDIT-01-PART-04.md` | **New:** this bounded report/evidence/handoff. |

No package, runtime migration, table, canonical role/permission seed, new route, request property or runtime response property is added. OpenAPI retains **2,065 operations and 2,334 existing schema names**. Structural comparison to starting HEAD passes after accounting for changed prose/error catalogs, `additionalProperties: false` on the three BAST customer request schemas, and property/required declarations of `artifactRef`, `approvedSignOff`, `signOffComplete` that were **already returned by runtime**. Existing request property sets and operation IDs remain unchanged.

## 5. Focused verification

### Final consolidated run — PASS

One final sequential invocation on the final code/test tree: **240 tests, 39 suites; 240 PASS / 0 FAIL / 0 SKIP / 0 CANCELLED / 0 TODO**, 410,681.9 ms. This is a focused selection, **not the full suite**. Databases/storage were local disposable test fixtures, not production.

```bash
NODE_ENV=test LOG_LEVEL=error ./node_modules/.bin/tsx --test --test-concurrency=1 \
  tests/handyman-bast-customer-authority-part04.test.ts \
  tests/handyman-bast-signoff-scope-guard.test.ts \
  tests/handyman-bast-worker-api.test.ts \
  tests/handyman-bast-acceptance.test.ts \
  tests/handyman-bast-lifecycle.test.ts \
  tests/handyman-bast-read-contract.test.ts \
  tests/handyman-bast-artifact-evidence.test.ts \
  tests/handyman-bast-worker-read-openapi.test.ts \
  tests/handyman-e2e-finance-close-api.test.ts \
  tests/handyman-e2e-financial-reconciliation-close.test.ts \
  tests/tenant-pic-identity-authority.test.ts \
  tests/tenant-pics.test.ts \
  tests/handyman-quotation-decision.test.ts \
  tests/handyman-scope-variations.test.ts \
  tests/handyman-tenant-decision-authority.test.ts \
  tests/permission-grant-authority.test.ts \
  tests/permission-revocation.test.ts \
  tests/permissions.test.ts \
  tests/openapi-contract.test.ts \
  tests/error-contract.test.ts \
  tests/mobile-openapi-completeness.test.ts
npm run typecheck
```

| Focused evidence | Final result |
| --- | --- |
| New personal-customer HTTP/full-migration suite | **50 PASS:** authorized ACCEPT, REJECT and alias; Ops/Care/Manager/Owner/admin/Lead and foreign customer/Building denials; inactive or inconsistent authority roots; forged signer/context/digest; unissued/stale/missing ISSUE; QC failure; optional finalized/foreign/missing/tampered bytes; replay/conflicts; concurrent ACCEPT/REJECT and ACCEPT/VOID; both observed-lock PIC relink orders; immutable history/rollback; legacy flags; one-free-pool-slot path; personal related decisions. |
| Existing provider BAST HTTP suite | **13 PASS:** genuine current Lead/provider lifecycle remains separate from personal consent. |
| Existing pure acceptance/lifecycle/read/artifact/OpenAPI BAST suites (five files) | **37 PASS:** no second lifecycle; canonical receipt/legacy qualification and existing read/artifact contract. Synthetic converter data is not session/authority proof. |
| Existing exact-Building sign-off scope guard | **2 PASS**, zero optional skips. |
| Existing Finance-close and reconciliation end-to-end files | **8 PASS:** 6 + 2; legitimate personal consent → existing warranty/rework/Finance/Manager close preserved; monetary/reconciliation prerequisites retained. |
| PART 02/03 regression selection (last eleven files) | **130 PASS**, including governed PIC links, request quotation/variation decisions, live grants/revocations/last authority and API contracts. Narrow variation fixture uses mocked auth and explicit consumer prestate, not fabricated evidence of personal-consent creation. |
| TypeScript | `npm run typecheck` **PASS**, rerun after final test changes. |
| OpenAPI and patch hygiene | YAML parse, strictness/property/operation/schema preservation checks and `git diff --check` **PASS**. |

**Zero-side-effect evidence:** denial/rollback helpers compare complete JSON rows, not merely counts, for all existing `handyman_*` domain tables, actual `tenant_invoice*` families, `evidence_submissions`, `work_orders` and `operational_events`. This observes BAST/history, Handyman Work Order/QC, invoice/payment/ledger, warranty/rework and close facts. Relink-race comparisons allow the separately authorized PIC-admin operational audit, not a BAST/money mutation. Immutable event/sign-off update/delete attempts are rejected; induced sign-off insertion failure rolls back head and decision event.

**Canonical defaults preserved byte-for-byte:**

```text
23eb4355bf0a836a70d59e6744aaf2fe824d253f47e45d76026ce7e497256422  src/modules/iam-bootstrap/iam-canonical-roles.ts
d2c6ded53bc890d30b8e7ebd6eea94a4cb144d92c942db9780155219f37074d1  src/database/seeds/foundation-access.seed.ts
```

### Failures encountered and disposition

Intermediate failures are not hidden or aggregated into the final count:

- Initial fixture work exposed missing explicit test staff bootstrap, a session timestamp typo (`startedAt` versus `startsAt`), no-ID snapshot assumptions and QC PASS/defect fixture ordering. These were corrected; no production guard was relaxed.
- An early reconciliation rejection sent undocumented `reason`. It now sends existing `rejectReason`; strict parsing remains.
- First ten-file consolidated attempt: **60 PASS / 0 FAIL / 50 CANCELLED** because customer-suite setup guessed `OWNER`. Actual source defines `OWNER_ROLE_CODE = PLATFORM_ADMIN`; the fixture now imports the constant. Canonical defaults were not changed.
- First PART 02/03 regression attempt: **129 PASS / 1 FAIL**, because the narrow custom variation BAST schema lacked `qc_run_id`/receipt provenance. The test schema/prestate was brought into line with the existing real BAST schema and the new consumer gate; it was not bypassed.
- Corrected customer + variation rerun: **53 PASS / 0 FAIL / 0 SKIP / 0 CANCELLED**. Subsequent full focused runs both passed all 240; the final one additionally observes actual invoice families and FM Work Order rows in denial snapshots. Counts above refer only to the last 240-test run, not sums of repeated executions.
- The final structural-diff verification harness initially omitted normalization of the three already-returned read fields' new `required` declarations. Its explicit property/required allowance was corrected and the comparison passed; no runtime/spec change or broader allowance was needed.
- Existing PostgreSQL driver concurrent-query warning observed in intermediate Finance output is not a failed test; no unrelated Finance refactor was undertaken.

Local execution logs are under `/home/user/.cache/hm-iam-e2e-audit/part04/` (`final-focused.log`, `typecheck.log` and intermediate logs). Cache logs are not committed/persisted as deliverables; the exact command, outcomes, cases and limitations are recorded here. `tests/handyman-service-warranty-rework-part03.test.ts` was not in the selected run; no result is claimed for that separate legacy fixture.

## 6. Blockers, dependencies and rollout limits

1. **No outstanding focused code/test failure. Production still NO-GO.** Full-suite, production data, staging/live-provider checks, load/stress, deployment and Web/PWA/Android runtime acceptance were intentionally not performed.
2. **Legacy terminal data needs an explicit product/operational remediation decision.** Old staff/digest-only ACCEPTED rows remain immutable/raw history but now fail qualified receipt gates. Do not backfill an invented personal signer or recertify a digest. This patch does not create a terminal-row remediation/reconsent endpoint or migration.
3. **Personal client rollout is required.** Provision independently governed current PIC accounts and exact live grants/Building access, enable their existing context/BAST/evidence reads, compute the exact canonical manifest and send the customer's own session. Staff forms must not proxy consent. Missing client inputs/session must disable submission, not trigger a Care fallback. Default grants are not widened here.
4. **Storage/QC availability matters.** New decisions fail closed on missing/tampered required QC bytes or supplied consent attachments. Historical replay/receipt qualification does not re-attest today's physical byte availability. Persistent production storage, authentic independent Supervisor provisioning and retention remain live readiness gates.
5. **No certified-signature/delegate claim.** A certified signature, signed-PDF requirement, external identity verification or independently verified delegation would need a separately approved supported contract. None is silently introduced.
6. **Prior live gates remain.** PART 01 BA-08–11/live operational gates, existing production identity reconciliation and prior finance/dispatch/mobile risks are not closed by local consent tests. Source/UI Owner-count drift remains unverified. The frozen tenant → Handyman direct-payment / Handyman → BM-fee model and provider/BM separation are untouched.

## 7. Precise PART 05 handoff — recommendation only

> **HANDYMAN-BACKEND — PART 05 ONLY**, after separate explicit authorization:
> Handyman operational actors and bounded staff handoffs — PART 01 P0-06
> and Inspector-write portion of P1-02. PART 05 has not started.

1. Start from the delivered PART 04 commit on this same branch; read PART 01–04 and preserve PART 02 grants, PART 03 identity governance and the personal-consent contract above.
2. Obtain the agreed provider-domain/coordination capability model and explicit Building reach before changing staff authority. Reuse existing assignment, pricing, readiness, inspection, purchasing and neutral Care services; do not add duplicate lifecycle endpoints or blanket `tenant_company.manage` grants to Care/Mobile.
3. Keep Care's existing PENDING/proof gateway and inspect only its safe provider handoff. Do not activate blocked Care Authority B, let staff consent for a PIC, turn provider preparation/QC into approval, or bypass approved-quote-before-crew, payment or close gates.
4. Preserve personal customer `/accept`, `/reject`, `/sign-off`, rework AUTHORIZE and chargeable decisions and their original-actor replay/receipt checks. Reuse the supplied canonical frontend contract; no body signer/delegate/Company override, retrospective certification or legacy-row mutation.
5. Use focused disposable-DB authority/negative/atomicity tests and the 240-test selection above as appropriate regression evidence. Report strictly necessary endpoint/schema dependencies before proceeding; no incidental Finance, dispatch/arrival or Mobile lifecycle rewrite.
6. Deliver a bounded PART 05 report with exact source/files/routes, capability/Building matrix, test failures and limits; commit/push only the same branch, no PR until FINAL REVIEW, then stop again.

**STOP after PART 04. PART 05 has not started. No PR, deployment or production mutation performed.**
