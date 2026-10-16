# CR-HM-BAST-SIGN-00 — Backend Authorization Matrix

## Authorization Model
Every BAST-related operation must pass two gates:
1. **Permission gate**: Required RBAC permission (tenant_company.read, tenant_company.manage, handyman.bast.manage)
2. **Data gate**: `assertBuildingScopedResourceAccess(actor, { clientId, buildingId })` — derived from the execution scope associated with the BAST

## 1. Read Operations

| Operation | Required Permission | Additional Data Gate | Error if Failed |
|---|---|---|---|
| `GET /handyman/bast/:bastId` | `tenant_company.read` | `assertBuildingScopedResourceAccess(actor, {clientId from scope, buildingId from scope})` | 403 — Access denied |
| `GET /handyman/execution-scopes/:executionScopeId/bast` | `tenant_company.read` | `assertBuildingScopedResourceAccess(actor, {clientId from scope, buildingId from scope})` | 403 — Access denied |

**Note**: `canAccessClient` permission is **NOT** sufficient as the sole gate for these operations. The building guard from the exact execution scope must pass.

## 2. Customer Sign-Off Operations (ACCEPT/REJECT)

| Operation | Required Permission | Additional Data Gates | Error if Failed |
|---|---|---|---|
| `POST /handyman/bast/:bastId/accept` | `tenant_company.manage` | 1. `assertBuildingScopedResourceAccess(actor, {clientId, buildingId from scope})`<br>2. Challenge-response signature verification (signatureDigest must cover challenge payload including bastId, executionScopeId, tenantPicId, nonce)<br>3. QC gate: `assertCurrentGuardedHandymanQcPass` if BAST status = ISSUED | 400 — Signature verification failed<br>409 — BAST not in ISSUED status<br>403 — Building access denied |
| `POST /handyman/bast/:bastId/reject` | `tenant_company.manage` | 1. `assertBuildingScopedResourceAccess(actor, {clientId, buildingId from scope})`<br>2. Challenge-response signature verification<br>3. QC gate: `assertCurrentGuardedHandymanQcPass` if BAST status = ISSUED<br>4. `rejectReason` must be non-empty (trimmed, max 2000 chars) | 400 — Empty rejectReason<br>400 — Signature verification failed<br>409 — BAST not in ISSUED status<br>403 — Building access denied |

**Critical**: The `canAccessClient` permission must NOT be used as the sole data gate. The building guard from the execution scope is mandatory.

## 3. Worker BAST Operations (PREPARE/ISSUE/VOID)

| Operation | Required Permission | Additional Data Gates | Error if Failed |
|---|---|---|---|
| `POST /handyman/field/execution-scopes/:executionScopeId/bast/prepare` | `handyman.bast.manage` | 1. `loadWorkerBastLaneScope` (CURRENT Crew Lead)<br>2. Building guard: `assertBuildingScopedResourceAccess(actor, {clientId, buildingId from scope})`<br>3. QC gate: `assertCurrentGuardedHandymanQcPass` (latest guarded PASS required) | 403 — Not CURRENT Crew Lead<br>403 — Building access denied<br>409 — QC not ready |
| `POST /handyman/field/bast/:bastId/issue` | `handyman.bast.manage` | 1. `loadWorkerBastLaneBast` (bast must be in lane + CURRENT Crew Lead)<br>2. `assertWorkerBastExpectedVersion(bast, 'ISSUE', expectedVersion)`<br>3. QC gate: `assertCurrentGuardedHandymanQcPass` | 400 — Invalid expectedVersion<br>403 — Not CURRENT Crew Lead or bast not in lane<br>409 — QC not ready |
| `POST /handyman/field/bast/:bastId/void` | `handyman.bast.manage` | 1. `loadWorkerBastLaneBast`<br>2. `assertWorkerBastExpectedVersion(bast, 'VOID', expectedVersion)`<br>3. Void reason required in request body | 400 — Missing void reason<br>403 — Not CURRENT Crew Lead or bast not in lane<br>409 — Illegal version |

## 4. Permission Summary Table

| Permission | Meaning | Used in BAST Operations |
|---|---|---|
| `tenant_company.read` | Read tenant company data | Read BAST detail, execution scope bast reads |
| `tenant_company.manage` | Manage tenant company operations | Customer ACCEPT/REJECT, challenge generation |
| `handyman.bast.manage` | Manage BAST (worker/provider) | Worker PREPARE/ISSUE/VOID (separate worker API) |
| `canAccessClient` | Client-level access shortcut | **EXPLICITLY BLOCKED** for BAST critical paths — building guard required instead |



## CR-HM-BM-CARE-HANDOFF-01 Authorization Notes (Added)

The following notes reinforce the CR-HM-BM-CARE-HANDOFF-01 business correction model
within the Authorization Matrix, ensuring no confusion with the BAST customer sign-off model:

### Care Decision Route Authorization

- **Required Permission**: `tenant_company.manage` is required for the care decision
  POST endpoint, but this alone is NOT sufficient. The `assertBuildingScopedResourceAccess`
  guard must also pass, deriving clientId and buildingId from the execution scope.

- **Building Guard Mandatory**: `canAccessClient` permission must NOT be used as the
  sole data gate for care decision routes. The exact building from the execution scope
  must be verified via `assertBuildingScopedResourceAccess(actor, { clientId, buildingId })`.

- **Care Decision ≠ BAST Sign-Off**: The `tenant_company.manage` permission for care
  decisions is strictly for recording CONFIRM/REJECT care decisions in
  `handyman_care_decisions`. It does NOT grant authority for BAST ACCEPT, quotation
  APPROVE, or variation APPROVE. These are separate authorization paths with separate
  gates (building guard + challenge signature + QC gate for BAST; separate commercial
  authorization for quotations/variations).

- **Exchange Token Not Proof of Approval**: The exchange token hash stored in care
  decisions is a provenance identifier only. It does NOT prove Tenant approval and
  must NOT be treated as such in any downstream commercial mutation path.

- **recordedByUserId Source**: The `recordedByUserId` field in care decision records
  is derived from the authenticated Backend session. Request-body values are NOT trusted
  and must be overridden by the service with the session-derived user ID.

- **PENDING_VERIFICATION State**: When authority for commercial mutations is not
  explicitly granted, care decisions remain in a safe state without automatic
  propagation. The system is fail-closed: no quotation APPROVE, variation APPROVE, or
  BAST ACCEPT is triggered solely by care decision creation.

### Building Customer Care as Primary Bridge

- The Building Customer Care actor is the official communication bridge between
  Tenant/PIC and Handyman. All care-mediated interactions MUST pass through this layer.
- No direct Tenant→Handyman path is required or permitted for care decision recording.
- The authenticated recording actor (Building Customer Care) and the actual decision
  maker (Tenant/PIC) are separate identities, enforced at every layer.
## 5. Data Gate: assertBuildingScopedResourceAccess

**Function**: `assertBuildingScopedResourceAccess(actor, { clientId, buildingId })`

**Behavior**:
- Resolves the execution scope from the BAST's `execution_scope_id`
- Verifies `actor` has authorization for the exact `clientId` and `buildingId` from the scope
- **Must NOT** use `canAccessClient` as a shortcut — the exact building from the scope must be verified
- If the actor is from a different building under the same client, the access is denied
- If the actor is from a different client, the access is denied

**Triggered in every BAST operation**:
- PREPARE (worker)
- ISSUE (worker)
- VOID (worker)
- ACCEPT (customer)
- REJECT (customer)
- GET bast detail
- GET execution scope bast

## 6. Cross-Client Binding Forbidden

All triggers and application logic enforce:
- `handyman_bast_documents.client_id` must match the `execution_scope_id`'s scope client
- `handyman_bast_events.client_id` must match the parent BAST's client_id
- `handyman_bast_sign_offs.client_id` must match the parent event's client_id
- `handyman_bast_sign_offs.evidence_record_id` must reference a record with matching `execution_scope_id` and `client_id`

**Violation result**: 409 error or database constraint violation (the trigger raises an exception).

## 7. Idempotency and Concurrency Gates

| Mechanism | Enforced By | Effect |
|---|---|---|
| `findEventByIdempotency` | Repository layer | Duplicate events (same bast_id + event_type + idempotencyKey) → replay winner |
| `handyman_bast_sign_offs_event_idx UNIQUE(event_id)` | Database | One sign-off per ACCEPT/REJECT event |
| BAST UPDATE `WHERE status = expectedFromStatus` | SQL UPDATE | Concurrency race: second writer gets 409 ILLEGAL_TRANSITION |
| Challenge nonce single-use | Server-side | Nonce consumed after use; replay with same nonce rejected |

## 8. Summary: Allowed vs. Forbidden

| Action | Allowed Permission Path | Forbidden Pattern |
|---|---|---|
| Read BAST detail | `tenant_company.read` + building guard | `canAccessClient` alone |
| Customer ACCEPT | `tenant_company.manage` + challenge sig + building guard + QC gate | `canAccessClient` alone; arbitrary signatureDigest |
| Customer REJECT | `tenant_company.manage` + challenge sig + building guard + QC gate + rejectReason | `canAccessClient` alone; empty rejectReason |
| Worker PREPARE | `handyman.bast.manage` + lane scope + building guard + QC gate | `tenant_company.manage` alone |
| Worker ISSUE | `handyman.bast.manage` + expectedVersion + building guard + QC gate | `tenant_company.manage` alone |
| Worker VOID | `handyman.bast.manage` + expectedVersion + voidReason | `tenant_company.manage` alone |