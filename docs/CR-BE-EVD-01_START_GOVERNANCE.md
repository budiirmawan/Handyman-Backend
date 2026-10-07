# CR-BE-EVD-01 START GOVERNANCE

## Operational Evidence Ownership & Lifecycle Foundation

**Status:** governance/start only. No PART implementation is included in this change.
**Scope:** Finding, Finding source, Rework, Verification, and their Evidence. Security Patrol Evidence, Work Order Evidence, and Utility/Meter Evidence are explicitly out of scope.

## 1. Repository review and current-state authority

The current backend already has one shared Evidence foundation:

- `evidence_requirements` (BE-07): client-owned requirements, keyed by `target_type` and `target_id`.
- `evidence_submissions` (BE-07): client-owned submission metadata, with `execution_type` + `execution_id` as the parent reference, file metadata, submitter, capture time, and `ACTIVE`/`REMOVED` status.
- Shared file API: `POST /evidence/:id/file`, `GET /evidence/:id/file`, `GET /evidence/:id/file/content`, and removal/list operations in the Evidence module. Storage defaults to `EVIDENCE_STORAGE_DIR` (`.data/evidence`), with the persisted file reference convention `evidence/{submissionId}`.
- Existing file API tests establish authorization by the accessible Building set, Client isolation, MIME/size validation, metadata retrieval, binary retrieval, and removal behavior.

The authoritative Finding is BE-09's `findings` table and Findings module. Domain modules (including Engineering and Housekeeping) link to it; they do not own a second Finding workflow. Finding source is the BE-09 source binding (`finding_sources`/Finding source service), currently supporting the published source kinds (including `FORM_INSTANCE`, `CHECKLIST_EXECUTION`, and `WORK_ORDER`, subject to the existing source contract).

Rework is the BE-09 `finding_rework_cycles` flow. Verification is the existing Finding review/verification flow (`reviews` plus the mobile verification facade), not a new verification table for this CR. The published routes are:

- Finding: `POST/GET /buildings/:buildingId/findings`, `GET/PATCH /findings/:id`, state, source, available-actions, and cancel routes.
- Rework: `POST /findings/:id/reject`, `POST/GET/PATCH /findings/:id/rework`, and `POST /findings/:id/resubmit`.
- Verification: `GET/POST /mobile/verification/:targetType/:targetId` (the service delegates to BE-09 action authority).

OpenAPI already describes Findings as the owner of Finding, Rework, Supervisor Verification, lifecycle, Building isolation, and audit/history. It describes Evidence as the shared submission/file foundation. This CR must extend those contracts rather than create duplicate evidence architecture.

## 2. Minimum authoritative contract

### Ownership and identity

1. **Evidence owner/parent:** each submission remains one row in `evidence_submissions`; its parent is represented by `execution_type` + `execution_id`. For this CR, add Finding-domain parent kinds without changing the shared file/storage model:
   - `FINDING` → `execution_id = findings.id` (initial/before evidence).
   - `FINDING_REWORK` → `execution_id = finding_rework_cycles.id` (rework submission evidence).
   - `FINDING_VERIFICATION` → `execution_id = the authoritative verification/review id` (verification evidence).
2. Every response must expose a stable `id`, `clientId`, parent kind, parent target ID, evidence type, file metadata, submitter, capture/created/updated timestamps, and lifecycle status. The target ID is never a mobile-local ID.
3. Do not make a Finding source row the Evidence owner. Source is provenance/context; the Finding remains authoritative.

### Building/Client scope

4. Evidence `client_id` must be derived from the parent chain, never trusted from a mobile request. Finding scope is `findings.building_id`; Client is derived through Building → Property → Client. Rework and Verification inherit the Finding's Building/Client. Reject mismatched parent/client/building combinations.
5. All list/get/upload/remove operations must assert the parent Finding's Building access and the caller's effective Client reachability. Cross-Building and cross-Client access returns the repository's existing authorization errors (not an empty success response).

### Semantics and operations

6. **Before evidence:** attached to the Finding, immutable in meaning after Finding creation; it documents the observed condition/source state.
7. **Rework evidence:** attached to a specific rework cycle, submitted by the assignee/authorized operator on resubmission; it documents corrective work for that cycle. It must not be silently reclassified as Finding evidence.
8. **Verification evidence:** attached to the specific verification/review decision; it documents the supervisor/reviewer decision context. It must not be used to bypass verification or closure rules.
9. Minimum operations are parent-nested list and create metadata, plus shared file upload, metadata get, binary get, and remove. Recommended canonical routes are `GET/POST /findings/:findingId/evidence`, `GET/POST /findings/:findingId/rework/:reworkId/evidence`, and `GET/POST /findings/:findingId/verification/:verificationId/evidence`; file operations remain shared by evidence ID. Exact route spelling is an OpenAPI implementation decision, but parent type and target ID must be explicit and non-ambiguous.
10. Remove is a soft lifecycle transition to `REMOVED`; it does not delete audit history. Removed rows are excluded from normal lists and cannot be uploaded to or downloaded from. Binary storage cleanup, if performed, must be owned by the Evidence storage service and must not erase the audit record.
11. List results must be deterministic and include lifecycle filtering. Get must return the metadata contract; binary download must enforce the same authorization as metadata.

### Permission and lifecycle authority

12. Permission authority is RBAC and existing BE-09 action authority: `finding.read` for reads, `finding.manage` for Finding/rework evidence submission and removal, and `finding.review` (plus the existing verification/review authority) for verification evidence. No hard-coded mobile role checks.
13. Lifecycle permission is additionally checked against `GET /findings/:id/available-actions`. Evidence cannot be added to cancelled/closed/finalized parents; rework evidence only while that cycle accepts resubmission; verification evidence only while the verification/review is open. A Finding status string alone is not sufficient authority.
14. Supervisor/reviewer authority remains the existing `finding.review`/verification decision authority. The API must not infer supervisor status from a user label or mobile role.

### Timestamps, storage, audit

15. Preserve `createdAt`, `updatedAt`, `capturedAt` (client capture time, nullable), and `submittedByUserId`; add lifecycle/removal actor/time if absent from the shared contract. Server timestamps are UTC and generated by the backend/database.
16. Storage ownership remains the shared Evidence storage adapter and `EVIDENCE_STORAGE_DIR` configuration. Domain modules store only the submission reference and must not write files directly.
17. Create/upload/remove and rejected lifecycle/permission attempts must produce the existing audit/history events with actor, action, parent type, parent ID, evidence ID where available, Building/Client context, and timestamp. Evidence removal is auditable and reversible only through an explicitly governed future operation.

## 3. OpenAPI requirements

OpenAPI must publish the new parent kinds and schemas without weakening existing Evidence endpoints:

- enum additions for Finding, Finding Rework, and Finding Verification parent/target types;
- explicit parent-nested list/create operations and `EvidenceSubmission` response fields;
- request schemas that accept only evidence type, file metadata/capture data, and the parent path (never caller-supplied Client/Building ownership);
- 201/200/204 success contracts and 400 validation, 401 authentication, 403 scope/permission/lifecycle, 404 parent/evidence, and 409 state-conflict responses;
- descriptions for before/rework/verification semantics, soft removal, UTC timestamps, and shared file endpoints;
- `x-building-scoped: true`, required permission annotations, and audit/lifecycle notes consistent with the existing OpenAPI governance.

## 4. Small PART breakdown (implementation deferred)

- **PART 01 — Evidence parent model:** extend shared Evidence target/execution constraints and repository mapping for Finding, Rework cycle, and Verification; derive Client/Building from Finding.
- **PART 02 — Finding Evidence API:** parent-nested list/create plus shared file upload/get/remove integration for before evidence, with RBAC, Building isolation, and lifecycle guards.
- **PART 03 — Rework Evidence API:** cycle-specific evidence list/create/file/remove integration, resubmission lifecycle guards, and assignee/rework authority.
- **PART 04 — Verification Evidence API:** verification/review-specific evidence list/create/file/remove integration, reviewer authority, and open-verification guards.
- **PART 05 — Audit and OpenAPI contract:** audit events, schemas/routes/errors/examples, and focused contract tests for scope, lifecycle, storage, timestamps, and soft removal.

PART 01 implementation note: migration `0277_add_finding_evidence_parents` adds the three parent kinds and a parent index. The shared metadata service now validates Finding, Rework-cycle, and Finding-review parents, derives Client/Building from the authoritative Finding chain, and applies both Client and Building access checks. Existing Form/Checklist Evidence behavior and the mobile execution-only contract remain unchanged. Parent-nested APIs remain deferred to PARTs 02–04.

## 5. Validation and stop state

Repository review completed against the current routes, migrations, Evidence file tests, Finding/Rework/Verification modules, storage configuration, permissions, and OpenAPI. Working tree validation at start showed the fixed branch `arena/01a023fa-asentra-backend`; no implementation files were changed for this request except this governance artifact. Implementation is intentionally stopped here.

### PART 02 implementation note

Finding Evidence is exposed through the shared Evidence router at `POST/GET /findings/:findingId/evidence` and `GET/PATCH /findings/:findingId/evidence/:evidenceId`. The parent is always `FINDING` with `executionId = findingId`; file upload/download continues through the shared `/evidence/:evidenceId/file` endpoints, now resolving Finding parents through the same Building/Client authority. Rework and Verification routes remain unimplemented.

### PART 03 implementation note

Rework Evidence is exposed through the shared Evidence router at `POST/GET /findings/:findingId/rework/:reworkId/evidence` and `GET/PATCH /findings/:findingId/rework/:reworkId/evidence/:evidenceId`. The parent is `FINDING_REWORK` with `executionId = finding_rework_cycles.id`; the route verifies that the cycle belongs to the requested authoritative Finding. Creation is allowed only while the cycle is `REQUESTED`. Shared file upload/download remains used by Evidence ID and resolves the Rework → Finding → Building/Client chain. Verification Evidence remains deferred.

### PART 04 implementation note

Verification Evidence is exposed through the shared Evidence router at `POST/GET /findings/:findingId/verification/:verificationId/evidence` and `GET/PATCH /findings/:findingId/verification/:verificationId/evidence/:evidenceId`. The parent is `FINDING_VERIFICATION` with `executionId = reviews.id`; the route verifies the review is a Finding review belonging to the requested Finding. Creation is allowed only for a `PENDING` review and write operations use the existing `finding.review` authority. Shared file handling resolves the same Verification → Finding → Building/Client chain. No new verification lifecycle was added.

### PART 05 implementation note

The OpenAPI contract now publishes Finding, Rework, and Verification Evidence metadata paths, parent parameters, request/response schemas, shared parent enum values, permissions, scope, and lifecycle/error descriptions. Operational Evidence create, file-upload, and remove actions are recorded through the existing Finding `operational_events`/history authority with actor, Evidence ID, parent type/ID, and derived Building/Client context; no parallel audit system was added. Backend timestamps and storage metadata remain owned by the shared Evidence persistence/storage services.
