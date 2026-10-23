# CR-HM-FIELD-EXPENSE-HELPER-01 — PART 02: Konfirmasi Kehadiran Helper (Mobile UI & Operations Handoff)

## 1. Domain Rules & UI Guidance

1. **Preserve Login-less Helpers (`helperUserId: null`, `hasMobileAccount: false`)**:
   - Helpers in Handyman crews (permanent, contract, or freelance/vendor workforce) do **not** require smartphones or Mobile login accounts (`users`).
   - Mobile UI must key all checklist state by `helperWorkerId` (`handyman_worker_contexts.id`) and display `fullName`, `employeeCode`, `workforceType`, and `rosterSource`.
2. **Roster / `helperPresence` Snapshot != Verified Attendance Proof**:
   - At Lead `POST /api/v1/handyman/execution-scopes/:executionScopeId/work-sessions/check-in`, `handyman_work_session_helper_presence` records an **unverified** crew snapshot (`unverifiedPresenceSnapshotRecorded: true`).
   - Until the Crew Lead (`PIC_PEKERJAAN`) explicitly submits per-Helper confirmation, every Helper remains `attendanceStatus: "UNCONFIRMED"`, `attendanceVerified: false`, and `summary.presenceSnapshotIsVerifiedProof` is permanently `false`.
   - Recommended Mobile UX: Immediately after Lead `check-in` (and accessible from the active Work Session screen before `complete` / `check-out`), present the **"Konfirmasi Kehadiran Helper"** card listing `roster[]` with `HADIR` / `TIDAK_HADIR` toggles and a badge showing `summary.unconfirmedCount` remaining unconfirmed Helpers.
3. **Corrections & Append-Only Audit History**:
   - Initial confirmation (`UNCONFIRMED → HADIR | TIDAK_HADIR`) records `INITIAL_CONFIRMATION` with server timestamp (`occurredAt`), `actorUserId`, `actorWorkerId`, `workSessionId`, `executionScopeId`, and `workOrderId`.
   - Any subsequent change on an already-confirmed Helper requires a non-empty `correctionReason` (`422 HANDYMAN_HELPER_ATTENDANCE_CORRECTION_REASON_REQUIRED` if missing) and appends an immutable `STATUS_CORRECTION` event in `history[]`.
4. **Personnel Exceptions Governed by Operations (`ADD_HELPER`, `SUBSTITUTE_HELPER`, `REMOVE_HELPER`)**:
   - If an unlisted Helper arrives or a Helper must be replaced, Mobile UI should instruct the Lead to contact Operations rather than allowing ad-hoc worker selection (`422 HANDYMAN_HELPER_ATTENDANCE_NOT_IN_ROSTER`).
   - Once Operations authorizes `ADD_HELPER` or `SUBSTITUTE_HELPER` via `POST /api/v1/handyman/execution-scopes/:executionScopeId/helper-attendance/personnel-changes`, refreshing `GET .../helper-attendance` shows the newly authorized Helper in `roster[]` (`rosterSource: "OPERATIONS_ADDITION"` or `"OPERATIONS_SUBSTITUTION"`) in state `UNCONFIRMED` for the Lead to confirm on site.
   - If a substituted/removed Helper had previously been marked `HADIR` in the active session, Operations' change automatically moves them to `removedHelpers[]` and supersedes their status to `TIDAK_HADIR` with an immutable `ROSTER_REMOVED_SUPERSEDED` audit event.
5. **No Automatic Fee Approval**:
   - Confirming Helper attendance is strictly operational attendance proof (`summary.feeApprovalAutomatic: false`) and never auto-approves commercial charges, vendor/worker fees, or financial entitlements.

---

## 2. Endpoints Summary

| Method & Path | Persona & Permission | Description |
|---|---|---|
| `GET /api/v1/handyman/field/execution-scopes/:executionScopeId/helper-attendance` | Assigned Crew Lead (Bearer auth + exact-Building scope) | Mobile Lead reads effective `roster[]`, `removedHelpers[]`, `personnelChanges[]`, `history[]`, and `summary` |
| `POST /api/v1/handyman/field/execution-scopes/:executionScopeId/helper-attendance/confirm` | Assigned Crew Lead (Bearer auth + exact-Building scope + active Work Session) | Mobile Lead confirms `HADIR` / `TIDAK_HADIR` (or submits correction with `correctionReason`) |
| `GET /api/v1/handyman/execution-scopes/:executionScopeId/helper-attendance` | Operations (`tenant_company.read` + exact-Building scope) | Operations inspects Helper roster, verified attendance, personnel changes, and correction audit trail |
| `POST /api/v1/handyman/execution-scopes/:executionScopeId/helper-attendance/personnel-changes` | Operations (`tenant_company.manage` + exact-Building scope) | Operations authorizes `ADD_HELPER`, `SUBSTITUTE_HELPER`, or `REMOVE_HELPER` (validating worker Building placement with `requireLogin: false`) |

---

## 3. Error Codes for Mobile & Operations Handling

- `HANDYMAN_HELPER_ATTENDANCE_FORBIDDEN` (`403`): Caller is not the authoritative assigned Crew Lead (on Field endpoints) or lacks Operations permission.
- `BUILDING_ACCESS_DENIED` (`403`): Caller lacks an active Building assignment to the Execution Scope's exact Building.
- `HANDYMAN_HELPER_ATTENDANCE_SESSION_REQUIRED` (`409`): Lead attempted confirmation before `check-in` or after `check-out`, or passed a `workSessionId` not matching the active session.
- `HANDYMAN_HELPER_ATTENDANCE_NOT_IN_ROSTER` (`422`): Helper is not active in the effective authorized roster (or caller passed the Crew Lead's own `workerContextId`).
- `HANDYMAN_HELPER_ATTENDANCE_CORRECTION_REASON_REQUIRED` (`422`): Attempted to modify an already-confirmed Helper without `correctionReason`.
- `HANDYMAN_HELPER_ROSTER_CHANGE_CONFLICT` (`409`): Invalid Operations personnel change (e.g. target Helper already active in roster, target is Crew Lead, replaced Helper not active in roster, or target Helper lacks active Building placement).
- `HANDYMAN_HELPER_CROSS_WORK_ORDER_MISMATCH` (`409`): Supplied `workOrderId` belongs to another Client/Building or conflicts with the Work Order already bound to this Execution Scope.
