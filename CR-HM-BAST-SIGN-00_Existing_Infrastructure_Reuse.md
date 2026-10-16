# CR-HM-BAST-SIGN-00 — Existing Infrastructure Reuse

## 4. Existing Infrastructure Reuse

### 4.1 Existing Backend Tables (REUSE, no duplication)
The following tables already exist and can be reused for the BAST authority model:

| Table | Current Purpose | Reuse Strategy |
|---|---|---|
| `handyman_bast_documents` | BAST document aggregate (DRAFT/ISSUED/ACCEPTED/REJECTED/VOID) | Core BAST table - reuse with existing triggers for immutability |
| `handyman_bast_events` | Append-only event chain (PREPARE/ISSUE/VOID/ACCEPT/REJECT) | Reuse - add ACCEPT/REJECT event types already supported |
| `handyman_bast_sign_offs` | Sign-off rows with decision, signature_digest, evidence_record_id, reject_reason | Reuse - already has decision, signatureDigest, evidenceRecordId, rejectReason |
| `handyman_evidence_records` | Evidence records bound to execution_scope + client | Reuse - evidenceRecordId FK in sign-offs already references this |
| `handyman_evidence_record_files` | Evidence files with sha256_digest, storage_key, byte_size | Reuse - for linking verified evidence to BAST sign-offs |
| `handyman_qc_runs` | QC runs with status OPEN/PASSED/FAILED | Reuse - guarded QC pass required for BAST ISSUE/ACCEPT |
| `handyman_execution_scopes` | Execution scope with client_id, building_id, tenant_pic_id, handyman_request_id | Reuse - BAST is bound to execution_scope; client/scope consistency already enforced |
| `handyman_qc_checklist_specs`, `handyman_qc_scope_checklist_bindings`, `handyman_qc_checklist_versions` | QC checklists | Reuse - required for `assertCurrentGuardedHandymanQcPass` |
| `handyman_work_sessions` | Work session tracking | Reuse - QC gate requires completed sessions |
| `handyman_defect_records` | Defect tracking | Reuse - QC gate requires all defects VERIFIED |

### 4.2 Existing Permissions (REUSE)
| Permission | Current Use | Reuse Strategy |
|---|---|---|
| `tenant_company.read` | Read tenant company data | Use for BAST read operations (Customer Care GET) |
| `tenant_company.manage` | Manage tenant company operations | Use for BAST ACCEPT/REJECT operations |
| `handyman.bast.manage` | Manage BAST (worker/provider) | Use for worker PREPARE/ISSUE/VOID (separate worker API) |
| `canAccessClient` | Client-level access shortcut | EXCLUDE from BAST critical paths (security guard explicitly blocks this) |

### 4.3 Existing Sessions (REUSE with Guarding)
- **Existing**: Sessions authenticate `req.auth.userId`.
- **Guarding**: Every BAST operation runs `assertBuildingScopedResourceAccess(actor, { clientId, buildingId })` derived from the execution scope. The `canAccessClient` shortcut is NOT sufficient - the exact building from the scope must be verified.

### 4.4 Existing BAST Routes (REUSE/ADAPT)
| Route | Current Purpose | Reuse Strategy |
|---|---|---|
| `GET /handyman/bast/:bastId` | Get BAST detail by ID | Reuse - `getBastByIdHandler` |
| `GET /handyman/execution-scopes/:executionScopeId/bast` | Get BAST by execution scope | Reuse - `getExecutionScopeBastHandler` |
| `POST /handyman/bast/:bastId/accept` | Customer ACCEPT | Reuse - `postBastAcceptHandler` |
| `POST /handyman/bast/:bastId/reject` | Customer REJECT | Reuse - `postBastRejectHandler` |
| `POST /handyman/bast/:bastId/sign-off` | Sign-off (ACCEPT/REJECT) | Reuse - `postBastSignOffHandler` |
| `POST /handyman/field/execution-scopes/:executionScopeId/bast/prepare` | Worker PREPARE | Reuse - `postWorkerBastPrepareHandler` (separate worker API) |
| `POST /handyman/field/bast/:bastId/issue` | Worker ISSUE | Reuse - `postWorkerBastIssueHandler` (separate worker API) |
| `POST /handyman/field/bast/:bastId/void` | Worker VOID | Reuse - `postWorkerBastVoidHandler` (separate worker API) |

### 4.5 Existing Evidence Storage Adapters (REUSE)
- `handyman_evidence_records` + `handyman_evidence_record_files` are the established evidence store.
- **Do NOT create a duplicate evidence store.**
- The `evidenceRecordId` in `handyman_bast_sign_offs` already FK references `handyman_evidence_records.id`.
- QC evidence verification via `assertCurrentGuardedHandymanQcPass` and `assertVerifiedManagedEvidenceReference` can be reused for BAST sign-off evidence validation.

### 4.6 Existing BAST Routes - What CANNOT be Reused
- **Arbitrary hash acceptance**: The current `signatureDigest` validation in `assertHandymanBastSignature` only checks length and emptiness. This MUST be replaced with challenge-response verification.
- **No user-Tenant PIC binding**: The current model accepts any `signatureDigest` from the browser. The new model must bind signatures to the authenticated tenant PIC.
- **No request-specific nonce**: No mechanism exists to prevent replay. A one-time challenge must be introduced.
- **Customer Care actor != actual customer**: The actor is from `req.auth.userId` (Customer Care staff), not the customer. The new model must introduce step-up verification for customer-facing ACCEPT/REJECT.

### 4.7 Summary: What Can Be Reused vs. What Must Be Changed
| Component | Reuse | Change Needed |
|---|---|---|
| BAST document table (`handyman_bast_documents`) | ✅ | Add hash/state snapshot column (optional, via trigger) |
| BAST events table (`handyman_bast_events`) | ✅ | Already has ACCEPT/REJECT types |
| BAST sign-offs (`handyman_bast_sign_offs`) | ✅ | Enhanced signature validation + challenge binding |
| QC gate (`assertCurrentGuardedHandymanQcPass`) | ✅ | Reuse as-is for ISSUE/ACCEPT gating |
| Evidence records | ✅ | Reuse FK constraints; add provenance verification |
| Permissions | ✅ (partial) | `canAccessClient` must NOT be the sole gate; building guard required |
| Routes | ✅ | Adapt handlers for challenge-response flow |
| Idempotency keys | ✅ | Reuse existing mechanism |
| Triggers for immutability | ✅ | Reuse existing deletion/update guards |