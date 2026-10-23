# CR-HM-ASSIGNMENT-RESPONSE-01 — PART 02C: Cross-App Projection & Mobile/Operations Handoff

## 1. Executive Summary

PART 02C completes **CR-HM-ASSIGNMENT-RESPONSE-01** by projecting the authoritative assignment response state (`PENDING` | `TERIMA` | `TIDAK_BISA`) across all Mobile and Operations read surfaces, integrating `IN_APP` notification `navigation-target` resolution for both Mobile and Operations recipients, and hardening edge-case authority (including dynamic Crew Lead rotation after a finalized response).

Across all three assignment lanes:
1. **Standard Work Order (`WORK_ORDER_ASSIGNMENT`)**
2. **Execution Scope Crew Lead (`EXECUTION_SCOPE_ASSIGNMENT`)**
3. **Inspection Visit (`INSPECTOR_VISIT_ASSIGNMENT`)**

---

## 2. Mobile Projection Handoff (Section A)

### 2.1 `GET /api/v1/mobile/assignments` (Standard Work Order lane)
- **Identity separation invariant**:
  - `item.id` is ALWAYS the assignment record ID (`work_order_assignments.id`).
  - `item.reference.workOrderId` is ALWAYS the work order ID (`work_orders.id`).
  - Top-level keys of `MobileAssignment` remain frozen: `['assignee', 'availableActions', 'context', 'id', 'reference', 'schedule', 'shift', 'status', 'type']`.
- **`item.assignee` response fields** (`WORK_ORDER` items):
  - `assignmentId`: `string` (`work_order_assignments.id`)
  - `responseStatus`: `'PENDING' | 'TERIMA' | 'TIDAK_BISA' | null`
  - `respondedByUserId`: `string | null`
  - `respondedByWorkerId`: `string | null` (`workforce_profiles.id`)
  - `respondedAt`: `string | null` (ISO-8601)
  - `declineReason`: `string | null`
  - `reassignmentRequired`: `boolean`
  - `availableResponseActions`: `('TERIMA' | 'TIDAK_BISA')[]` (`['TERIMA', 'TIDAK_BISA']` when `responseStatus === 'PENDING'`, `[]` otherwise)
- **Response-gated `item.availableActions`**:
  - When `responseStatus === 'PENDING'`: `['TERIMA', 'TIDAK_BISA']` (plus `ACKNOWLEDGE` / `ADD_NOTE` / `CANCEL` if caller also holds `work_order.manage`; `START` is suppressed until `TERIMA`).
  - When `responseStatus === 'TERIMA'`: `START` (and subsequent execution actions per `workOrder.status` and `work_order.manage`) is enabled; `TERIMA`/`TIDAK_BISA` are removed.
  - When `responseStatus === 'TIDAK_BISA'`: `[]` (no `TERIMA`, `TIDAK_BISA`, `ACKNOWLEDGE`, or `START`).

### 2.2 `GET /api/v1/handyman/field/my-jobs` (Crew Lead & Inspector feed)
Returns `{ jobs, inspections, feedSource: 'AUTHORITATIVE_BACKEND' }`:
- **`jobs[]` (Execution Scope Crew Lead — PIC Pekerjaan)**:
  - `assignmentId`: `string` (`handyman_execution_scope_assignments.id`)
  - `executionScopeId`: `string` (`handyman_execution_scopes.id`)
  - `requestId`: `string` (`handyman_service_requests.id`)
  - `responseStatus`: `'PENDING' | 'TERIMA' | 'TIDAK_BISA'`
  - `respondedByUserId`: `string | null`
  - `respondedByWorkerId`: `string | null` (`handyman_worker_contexts.id`)
  - `respondedAt`: `string | null`
  - `declineReason`: `string | null`
  - `reassignmentRequired`: `boolean`
  - `availableActions`:
    - `responseStatus === 'PENDING'` -> `['TERIMA', 'TIDAK_BISA']`
    - `responseStatus === 'TIDAK_BISA'` -> `[]`
    - `responseStatus === 'TERIMA'`:
      - No active session & `scopeStatus === 'AUTHORIZED'` -> `['CREATE_ARRIVAL_CHALLENGE', 'CHECK_IN']`
      - Session `CHECKED_IN` -> `['START_WORK', 'CHECK_OUT']`
      - Session `IN_PROGRESS` -> `['PAUSE', 'MATERIAL_RUN', 'COMPLETE', 'CHECK_OUT']`
      - Session `PAUSED` / `MATERIAL_RUN` -> `['RESUME', 'CHECK_OUT']`
      - Session `WORK_COMPLETED` -> `['CHECK_OUT']`
- **`inspections[]` (Inspector Visit)**:
  - `assignmentId`: `string` (`handyman_inspector_assignments.id`)
  - `appointmentId` & `visitAppointmentId`: `string` (`handyman_visit_appointments.id`)
  - `requestId`: `string` (`handyman_service_requests.id`)
  - `responseStatus`: `'PENDING' | 'TERIMA' | 'TIDAK_BISA'`
  - `respondedByUserId`: `string | null`
  - `respondedByWorkerId`: `string | null`
  - `respondedAt`: `string | null`
  - `declineReason`: `string | null`
  - `reassignmentRequired`: `boolean`
  - `availableActions`:
    - `responseStatus === 'PENDING'` -> `['TERIMA', 'TIDAK_BISA']`
    - `responseStatus === 'TERIMA'` -> `['RECORD_OUTCOME']`
    - `responseStatus === 'TIDAK_BISA'` -> `[]` (declined inspections are excluded from active `MY_INSPECTIONS_SQL` list)

### 2.3 Detail Endpoints (`GET /api/v1/handyman/field/work-orders/:executionScopeId` & `GET /api/v1/handyman/field/requests/:handymanRequestId`)
- `assignmentContext` (on both endpoints) includes `assignmentId`, `responseStatus`, `respondedByUserId`, `respondedByWorkerId`, `respondedAt`, `declineReason`, `reassignmentRequired`, and `availableActions`.
- `inspectorAssignmentContext` (on `GET /api/v1/handyman/field/requests/:handymanRequestId`) includes `assignmentId`, `visitAppointmentId`, `inspectorUserId`, `status`, `assignedAt`, `responseStatus`, `respondedByUserId`, `respondedByWorkerId`, `respondedAt`, `declineReason`, `reassignmentRequired`, and `availableActions`.
- **Login-less Helpers**: Helpers without user accounts (`workforce_profiles.user_id IS NULL`) have no personal response obligation; Crew Lead responds on behalf of the crew and records Helper attendance during execution via `POST /api/v1/handyman/field/execution-scopes/:executionScopeId/helper-attendance/confirm`.

---

## 3. Operations Projection Handoff (Section B)

### 3.1 `GET /api/v1/handyman/requests/:id/status-visibility` & `GET /api/v1/handyman/execution-scopes/:id/status-visibility`
- `stages.assignment` exposes:
  - `assignmentId`, `status`, `providerContextId`, `crewId`
  - `responseStatus`: `'PENDING' | 'TERIMA' | 'TIDAK_BISA' | null`
  - `respondedByUserId`: `string | null`
  - `respondedByWorkerId`: `string | null`
  - `respondedAt`: `string | null`
  - `declineReason`: `string | null`
  - `responseNotes`: `string | null`
  - `reassignmentRequired`: `boolean`
- `stages.inspectorAssignment` exposes:
  - `assignmentId`, `visitAppointmentId`, `visitState`, `inspectorUserId`, `status`
  - `responseStatus`: `'PENDING' | 'TERIMA' | 'TIDAK_BISA' | null`
  - `respondedByUserId`: `string | null`
  - `respondedByWorkerId`: `string | null`
  - `respondedAt`: `string | null`
  - `declineReason`: `string | null`
  - `responseNotes`: `string | null`
  - `reassignmentRequired`: `boolean`

### 3.2 `GET /api/v1/handyman/operations/queue`
- Each `HandymanOperationsQueueItem` exposes both `assignment` (`stages.assignment`) and `inspectorAssignment` (`stages.inspectorAssignment`).
- When a worker/lead/inspector responds `TIDAK_BISA`, `reassignmentRequired` is `true` and `declineReason` is populated.
- Upon reassignment, the new active assignment immediately projects `responseStatus: 'PENDING'` and `reassignmentRequired: false`, while historical assignments and their immutable response event timelines remain inspectable via:
  - `GET /api/v1/work-orders/:workOrderId/assignments/:assignmentId/response-history`
  - `GET /api/v1/handyman/execution-scopes/:executionScopeId/assignments/:assignmentId/response-history`
  - `GET /api/v1/handyman/visit-appointments/:visitAppointmentId/inspector-assignments/:assignmentId/response-history`

---

## 4. Notification & Navigation-Target Handoff (Section C)

### 4.1 `GET /api/v1/notifications/:notificationId/navigation-target`
- Persisted `navigation_target_type` values in migration `0472`:
  - `WORK_ORDER_FIELD_WORK` (`navigation_target_id = work_orders.id`)
  - `EXECUTION_SCOPE_FIELD_WORK` (`navigation_target_id = handyman_execution_scopes.id`)
  - `INSPECTOR_VISIT_FIELD_WORK` (`navigation_target_id = handyman_visit_appointments.id`)
  - All `*_SUPERSEDED` notifications store `navigationTarget = null`.
- Resolution behavior by recipient & event:
  - **Mobile Worker / Crew Lead / Inspector (`*_PENDING`)**:
    - Resolves to `{ destination: 'FIELD_WORK', ... }` ONLY while the assignment is still `ACTIVE`, belongs to the recipient, is within the recipient's active Building scope, and is not `TIDAK_BISA`.
    - Once the assignment is `TIDAK_BISA`, superseded, or reassigned to another worker/crew/inspector, `GET /notifications/:id/navigation-target` returns `{ target: null }`.
  - **Operations (`*_ACCEPTED`, `*_DECLINED`, `*_REASSIGNED`)**:
    - Resolves to `{ destination: 'OPERATIONS_WORK_ORDER' | 'OPERATIONS_EXECUTION_SCOPE' | 'OPERATIONS_INSPECTOR_VISIT', ... }` with `assignmentId`, work reference ID, `responseStatus`, and `reassignmentRequired` when the recipient holds `work_order.read` / `tenant_company.read` and active Building access.

---

## 5. Edge-Case Authority Rules (Section D)

1. **Crew Lead Change After Finalized Response (`TERIMA` / `TIDAK_BISA`)**:
   - In `designateHandymanCrewLead` (`POST /api/v1/handyman/work-crews/:crewId/lead`), if the crew holds an `ACTIVE` Execution Scope assignment whose response is already finalized (`TERIMA` or `TIDAK_BISA`) and no active work session exists:
     - Any `RELEASED` dispatch release on the old assignment is superseded via `handymanDispatchRepository.supersedeForAssignment`.
     - The old assignment row is marked `SUPERSEDED` and an `ASSIGNMENT_SUPERSEDED` event is appended to its response ledger (never overwriting the old Lead's `TERIMA` or `TIDAK_BISA` decision).
     - A new `ACTIVE` `handyman_execution_scope_assignments` row (`supersedes_assignment_id = oldAssignmentId`) is inserted with a fresh `PENDING` `handyman_assignment_responses` row for the new Lead.
   - If the active assignment's response is still `PENDING`, the assignment ID is preserved (`assignmentId` unchanged) and the new Lead becomes the authoritative responder.
2. **Same-Crew Reassignment After Decline**:
   - `POST /api/v1/handyman/execution-scopes/:executionScopeId/assignment/reassign` allows reassigning the same `crewId` when the current assignment's `responseStatus !== 'PENDING'` (e.g., after `TIDAK_BISA` or after a Crew Lead change).
3. **Immutable Superseded & Terminal States**:
   - Superseded assignments reject any subsequent `/respond` call with `409 WORK_ORDER_ASSIGNMENT_SUPERSEDED` / `409 HANDYMAN_ASSIGNMENT_RESPONSE_SUPERSEDED`.
   - PostgreSQL trigger `trg_handyman_assignment_responses_immutable` and CHECK constraint `hm_assign_resp_evt_type_check` enforce ledger immutability and event vocabulary at the database layer.
