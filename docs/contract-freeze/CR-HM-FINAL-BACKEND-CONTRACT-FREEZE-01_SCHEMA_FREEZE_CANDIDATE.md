# Schema Freeze Candidate — Migration Registry & Pending Order

## Registry facts (verified from `src/database/migrations/index.ts`)

- **459 migrations registered**, array order is strictly ascending by number.
- Head: `0460_handyman_settlement_dispute_adjudication`.
- **`0449` is intentionally unclaimed/reserved** (see the 0450 migration header:
  reserved for the Care decision capability if ever approved). A numbering gap
  is valid; do not renumber anything.
- Runner semantics: `npm run db:migrate` applies registered migrations in
  registry order, recording each in the migration history; API startup/readiness
  require matching canonical history (README). Rollback (`db:migrate:down`)
  reverts only the latest migration — **not** part of any freeze step.

## Pending-migration determination (no production execution in this CR)

This repository cannot know any real environment's applied set. The operator
must determine the pending subset read-only per environment:

```bash
npm run db:migrate:status        # staging / production, read-only
```

The **exact dependency order for any pending subset is registry order**. The
Handyman-relevant tail (the only part that can plausibly be pending for the
four-repository integration, per prior-wave docs deferring 0447+) is:

| # | Migration | Depends on (must already be applied) | Notes |
|---|---|---|---|
| 1 | `0440_create_handyman_dispatch_releases` | 0396 assignments | dispatch release fact |
| 2 | `0441_handyman_dispatch_release_reassignment_supersede` | 0440, 0439 | supersede on reassign |
| 3 | `0442_harden_handyman_qc` | 0403 | supervisor QC authority |
| 4 | `0443_separate_handyman_variation_qc_authority` | 0442, 0435 | variation QC split |
| 5 | `0444_version_handyman_qc_checklists` | 0442 | versioned checklists |
| 6 | `0445_bind_handyman_bast_to_qc_pass` | 0444, 0404/0405 | BAST requires current QC PASS |
| 7 | `0446_handyman_bast_worker_transport` | 0445 | worker BAST lane; registers `handyman.bast.manage` |
| 8 | `0447_net_handyman_allocation_caps` | 0413 | NET (not gross) allocation caps |
| 9 | `0448_handyman_finance_authority_permissions` | — (permission catalogue) | registers commercial/finance/settlement permissions |
| — | `0449` | — | **reserved, does not exist — skip** |
| 10 | `0450_handyman_care_building_authority_permission` | — | registers `handyman.care.building` |
| 11 | `0451_handyman_care_communications` | 0425/0428 | request-scoped Care communications |
| 12 | `0452_create_iam_owner_bootstrap_state` | IAM foundation | first-owner bootstrap singleton |
| 13 | `0453_extend_iam_admin_audit_events` | 0452-era audit tables | IAM admin audit vocabulary |
| 14 | `0454_extend_client_audit_events` | client registry | Client master audit vocabulary |
| 15 | `0455_handyman_care_backend_origin_channel` | 0451 | staff-assisted intake origin channel |
| 16 | `0456_apartment_master_data` | spaces/tenant masters | Unit parties, catalogue binding (PR #44) |
| 17 | `0457_tenant_batch_import` | 0456 masters | Tenant/PIC batch import + verification (PR #45) |
| 18 | `0458_handyman_e2e_financial_reconciliation_close` | 0447, 0448, quotation/ledger tables | DP terms, reconciliation, FINAL CLOSE gates (PR #46) |
| 19 | `0459_handyman_request_cancellation` | 0378 requests | `CANCELLED` status + append-only cancellation fact (PR #48) |
| 20 | `0460_handyman_settlement_dispute_adjudication` | 0418 settlement | append-only dispute resolutions, `DISPUTE_RESOLUTION` action (PR #48) |

All are additive/forward-safe per their headers; none was executed against
production or staging by this CR (focused tests ran `migrateUp` only on
disposable embedded PostgreSQL).

## Freeze rules for consumers

- Consumers never own tables, migrations, or direct DB access.
- IDs are opaque UUIDs; consumers store/echo: `handymanRequestId`,
  `executionScopeId`, `quotationId/quotationVersionId`, `bastId`,
  `transactionId`, `chargeLineId`, `paymentId`, `allocationId`, `warrantyId`,
  `claimId`, `reworkId`, `qcRunId`, `evidenceRecordId`, `settlementId`,
  `exceptionId`, plus every issued `idempotencyKey`.
- Any post-candidate schema change requires a new migration ≥ `0461`
  (note: PR #47's bank-attestation migration was originally numbered 0459 and
  **must be renumbered to ≥0461** if revived — FG-05) and a candidate version bump.
