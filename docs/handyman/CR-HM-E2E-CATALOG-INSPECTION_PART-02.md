# E2E Catalog & Inspection — PART02

2026-10-25 · baseline `3f89d840f93732f14be1eb92807b07286ca188e9` · branch `arena/3a9f4872-handyman-backend`.
Backend patch complete; live BM commercial consent remains an external blocker. No deployment or live E2E certification.

## Actual findings / minimal fixes

1. **Reproduced bypass:** PR60's resolver refused `INSPECTION_FIRST`, but the existing manual quotation commands could create/issue/approve it without inspection. One shared request-scoped gate now covers primary service and ACTIVE mixed items at creation, issuance and new approval. It requires the immutable `INSPECTED` result for the exact request/Client/Building; booking, a foreign Building row or `NOT_INSPECTABLE` is insufficient. FIXED/ESTIMATED direct diagnosis/quotation remains valid. Customer rejection and exact historical decision replay are unchanged.
2. **Post-inspection dead end:** a completed inspection-first request still returned `INSPECTION_REQUIRED`. The request adapter now returns `MANUAL_REVIEW` with no invented amount and points to the existing manual quotation/revision. The catalog post-inspection revision lane requires `INSPECTED`, not merely any inspection row. The price resolver/rules themselves are unchanged.
3. **Missing bounded Inspector action:** the field feed advertised `RECORD_OUTCOME`, but only the Operations-manage HTTP route existed. Added `POST /api/v1/handyman/field/requests/{requestId}/inspection`, reusing the original inspection command and `{result,notes}` schema. Existing `tenant_company.read` is necessary but not sufficient: current exact assignment + TERIMA + eligible registered Inspector + exact Building access are checked; assignment/response/live-visit rows are held until commit. Pending, declined, superseded and other actors are denied. No persona or broad manage grant was added; the old administrative route remains unchanged.
4. The existing ADD/REDUCE engines, signed revised-total reconciliation, pricing, payment/correction engines and 24-service/8-category starter already implement the remaining domain functions. They were reused, not duplicated. One old partial variation fixture needed the nullable Commercial Bridge columns to match current source; production schema/constraints were not weakened.

## Existing workflow / frontend handoff

- **FIXED:** select catalog/variant/quantity → triage `DIAGNOSIS` → existing diagnosis → quotation preparation/lines → issue → existing exact-version customer decision. No mandatory inspection.
- **ESTIMATED:** same direct estimate when facts suffice. For an actual site-information gap, triage `INSPECTION_REQUIRED`; unknown attributes or missing governed price facts remain fail closed. An estimate is not customer approval.
- **INSPECTION_FIRST:** triage `INSPECTION_REQUIRED` → existing visit/Inspector assignment as needed → actual `INSPECTED` result → diagnosis → existing manual labor/material scope and price → issue → customer decision. Do not change the service to FIXED to get past the gate. `MANUAL_REVIEW` after inspection is not permission to guess a catalog price.
- **Unavailable/rescheduled:** TIDAK_BISA/reassignment/TERIMA retain assignment history. Before selection/confirmation, cancel the current PROPOSED visit using `/handyman/requests/{requestId}/visits/{appointmentId}/cancel-proposal` with its version; propose a new visit/slot instead of rewriting the old one. Booking confirmation still requires the existing independently verified tenant slot choice and capacity gates. No-show/access-blocked/rebook attempts are not completed inspections; do not consume the singleton final inspection record merely because the Inspector is unavailable.
- **Booking vs observation:** the new Inspector endpoint records the existing structured administrative observation. It does not confirm/complete a booking or certify arrival, permit/access, capacity or execution readiness. An Inspector reassignment does not rewrite the immutable appointment resource/slot: use the existing cancel/re-propose/verified-confirm flow to change a booking. No unilateral confirmed-slot reschedule was added.
- **Evidence:** reuse the existing request-scoped managed field-evidence upload/confirm/content engine. Genuine bytes, checksum, scope and registered field/Operations actor rules remain mandatory there. The minimum immutable inspection result and managed evidence are separate request-bound records; neither an attachment nor an observation is customer commercial consent. No fake evidence row or new evidence store was introduced.
- **After inspection:** correct request facts; use `/handyman/requests/{requestId}/quotation/revision` for resolved catalog lines, or `/handyman/quotations/{quotationId}/versions` plus the existing LABOR/MATERIAL line commands for manual scope/pricing. Issue the new version, retain the old version/lines, and obtain the existing customer decision. No automatic approval or in-place rewriting.
- **After approval — TAMBAH/KURANG:** use existing field finding/proposal → Operations review → distinct issued revised quotation with signed ADD/REDUCE delta → authorized tenant decision → Operations scope authorization. Continue existing execution/QC/qualified BAST/final-charge gates. Stale versions, unauthorized actors, wrong quotation threads and over-reduction remain denied. Field findings alone do not change payable scope.
- **Final transaction:** reuse existing charge admission for original/eligible ADD lines, and explicit Manager/Finance forward-only `ledger-adjustments` for agreed reductions against the correct charge line. Do not charge both the entire revised quotation and its original/additive lines. Existing signed revised-total reconciliation, net-ledger reads and invoice snapshots recalculate amounts; prior quotation versions, charges, payments and allocations are not deleted or rewritten. Approved quantity reduction is not an automatic refund, Finance verification, allocation reversal or invoice finalization.

## Focused validation

**114 distinct cases PASS across focused runs; zero remaining failures/skips.**
- Final explicit 10-file run: **113/113 PASS**, 0 failures/skips, 149,879 ms. The initial stale partial-fixture failure (missing Commercial Bridge column) was corrected before this complete focused rerun.
- Corrected partial fixture: variation suite rerun **3/3 PASS**, including full ADD gates, approved REDUCE signed-total/quantity reconciliation, over-reduction, stale versions and unauthorized actions.
- Exact Inspector E2E only: **1/1 PASS**, TIDAK_BISA → reassignment → TERIMA → actual result; pending/superseded/other actors denied. No unrelated assignment/IAM audit run.
- Catalog regressions retain PR60's **24 services / 8 categories**; 10 added catalog cases cover both direct modes, inspection-first bypasses, unavailable result, post-inspection handoff and labor/material revision. Proposed reschedule preserves the old slot and audit history.
- Existing managed-binary evidence, booking core/proposal, quotation decision, Commercial Bridge (18 cases) and financial reconciliation/payment-history regressions passed. Live commercial verification is not inferred from test issuers.
- `npm run typecheck` PASS. OpenAPI YAML/local references/unique operation IDs PASS (2,070 operations, 2,338 schemas, 20,991 local references). `git diff --check` PASS.

Main test selection (not the full suite):

```sh
NODE_ENV=test LOG_LEVEL=error ASENTRA_USE_EMBEDDED_POSTGRES=true \
node --import tsx --test --test-concurrency=1 \
  tests/cr-hm-service-catalog-01-part01.test.ts \
  tests/cr-hm-service-catalog-01-part02.test.ts \
  tests/cr-hm-service-catalog-01-part03.test.ts \
  tests/handyman-quotation-decision.test.ts \
  tests/handyman-scope-variations.test.ts \
  tests/handyman-visit-booking-authority.test.ts \
  tests/handyman-appointment-core.test.ts \
  tests/handyman-field-evidence.test.ts \
  tests/handyman-e2e-financial-reconciliation-close.test.ts \
  tests/handyman-commercial-decision-bridge-part01.test.ts

NODE_ENV=test LOG_LEVEL=error ASENTRA_USE_EMBEDDED_POSTGRES=true \
node --import tsx --test --test-name-pattern='3. E2E Inspector Visit' \
  tests/handyman-assignment-response-part02c.test.ts
```

Only disposable local PostgreSQL/storage were used. No migration changes, catalog seed change, production DB access, deployment or PR.

## External blocker / exact PART03 handoff — STOP

The independent live BM commercial-consent producer/reviewed enrollment is still unavailable; keep PART01 fail closed. Do not promote Care statements, attachments, scheduling consent or the new Inspector action into customer approval. Existing variation tenant-decision authority is unchanged; no new accountless variation-consent purpose was invented.

PART03 receives the approved quotation/version + execution-scope IDs, immutable revision history, authorized signed ADD/REDUCE deltas, managed evidence references and retained payment/allocation history. Consume these through the existing Manager/Finance charge, forward-only adjustment, payment/allocation and invoice-reconciliation gates; never double-count a revised quote or silently refund/rewrite payments. Any live accountless decision demonstration remains gated on the independent BM producer and scoped integration validation. No PART03 implementation is included here.
