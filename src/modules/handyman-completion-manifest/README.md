# Verified completion manifest

All paths are under `/api/v1/handyman/execution-scopes/:executionScopeId` and
require authentication plus exact Building access. No caller-supplied actor,
price, helper count, or tenant acceptance is trusted.

1. The current assigned Crew Lead records actual execution in an **in-progress**
   work session: `POST /work-sessions/:sessionId/completion-declarations` with
   `quotationLineId`, optional `variationId`, decimal `actualQty`, a managed
   `BEFORE_AFTER_WORK` `evidenceReference`, and `idempotencyKey`. Quantity zero
   means NOT_PERFORMED, not completion. The evidence must be uploaded by the
   Lead for this exact scope after that session starts. `GET
   /completion-declarations` lists declarations and any revocations. The
   original declaring Lead can append a revocation with a reason and key at
   `POST /completion-declarations/:declarationId/revoke`; facts are not edited.
2. ADD labor already captured by the approved ADD labor execution service is
   automatically reused; do not create a second positive declaration for it.
   Material use alone is not proof of completed installation. All remaining
   approved quotation/variation items need an explicit execution fact, including
   NOT_PERFORMED items. Authorized REDUCE quantities are deducted exactly.
3. After all sessions are completed, the current Lead submits a snapshot with
   `POST /completion-manifests` and `idempotencyKey`. Read a version using
   `GET /completion-manifests/:manifestId` or `GET /completion-manifests/latest`.
   The snapshot contains approved and actual decimal quantities, status,
   item identity, Lead, session and byte-verified evidence references.
4. The assigned QC Supervisor reads the snapshot and posts to
   `/completion-manifests/:manifestId/verify` with `manifestVersion`,
   `manifestSha256`, current passed `qcRunId`, `qcRunVersion`, `reviewed: true`,
   and `idempotencyKey`. Review checks the exact snapshot, actual quantities,
   evidence bytes, current scope, completed sessions and guarded QC FINISH. A
   new version or later work needs a fresh QC PASS and review.
5. New BAST **ISSUE** binds the verified version and QC PASS; it never creates a
   tenant signature or marks the BAST ACCEPTED. Historical QC and BAST records
   are not backfilled, and customer acceptance remains its existing separate
   operation. If an approved historical variation cannot be tied to an exact
   consented item, issuance fails closed instead of inventing a relationship.
