#!/usr/bin/env python3
"""CR-BE-MOB-01 PART 06 — sync resource-kind extension in OpenAPI.

The only OpenAPI change PART 06 requires: the published `resourceType` enum,
the `resourceId` description and the per-kind `data` contract must match the
implemented MOBILE_SYNC_RESOURCE_TYPES / dispatcher. No new path, no new
schema, no new operation verb. Idempotent.
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "docs/api/openapi.yaml"

ANCHOR = """        resourceType:
          type: string
          enum: [TASK_EXECUTION, CHECKLIST_RESPONSES, EVIDENCE_SUBMISSION, TASK_ASSIGNMENT]
        resourceId:
          type: string
          format: uuid
          description: >
            Resource reference: taskId (TASK_EXECUTION, TASK_ASSIGNMENT) or
            executionId (CHECKLIST_RESPONSES, EVIDENCE_SUBMISSION).
        operation:
          type: string
          enum: [START, COMPLETE, CANCEL, SAVE, SUBMIT, UPDATE]
        clientTimestamp:
          type: string
          format: date-time
          description: Client timestamp of when the operation happened on-device.
        data:
          type: object
          description: >
            Type-specific payload: TASK_EXECUTION: { completionNotes? };
            CHECKLIST_RESPONSES: { responses: array|object }; 
            EVIDENCE_SUBMISSION: { evidenceType, executionType, executionId,
            evidenceRequirementId?, fileReference, originalFileName, mimeType,
            fileSize, capturedAt? }; TASK_ASSIGNMENT: { assignmentId,
            status? }. Any operation may additionally carry
            `baseVersion` (BE-25I): the resource's `updatedAt` the client
            last saw; a stale baseVersion produces SYNC_CONFLICT.
          additionalProperties: true
"""

REPLACEMENT = """        resourceType:
          type: string
          description: >
            The synced resource kind. A kind exists here ONLY when an existing
            backend operation provides a faithful authoritative write target
            (authoritative id + published operation + same RBAC permission +
            same Building scope + explicit `data` contract). Offline records
            with no such target stay local and are deliberately absent — see
            `x-sync-unsupported-resource-types`.
          enum:
            [TASK_EXECUTION, CHECKLIST_RESPONSES, EVIDENCE_SUBMISSION,
             TASK_ASSIGNMENT, PATROL_EXECUTION, PATROL_POINT_VISIT,
             METER_READING]
        resourceId:
          type: string
          format: uuid
          description: >
            Authoritative resource reference — always an id the backend
            already owns, never client-generated: taskId (TASK_EXECUTION,
            TASK_ASSIGNMENT); checklist executionId (CHECKLIST_RESPONSES,
            EVIDENCE_SUBMISSION); patrol execution id, which IS the BE-07
            taskId (PATROL_EXECUTION, PATROL_POINT_VISIT); BE-07 form
            instance id started from a meter-reading binding (METER_READING).
        operation:
          type: string
          description: >
            PART 06 introduced no new verb. Valid combinations:
            TASK_EXECUTION START|COMPLETE|CANCEL; CHECKLIST_RESPONSES SAVE;
            EVIDENCE_SUBMISSION SUBMIT; TASK_ASSIGNMENT UPDATE;
            PATROL_EXECUTION START|COMPLETE; PATROL_POINT_VISIT SUBMIT;
            METER_READING SUBMIT. Any other pairing is rejected with 400
            VALIDATION_ERROR before any write.
          enum: [START, COMPLETE, CANCEL, SAVE, SUBMIT, UPDATE]
        clientTimestamp:
          type: string
          format: date-time
          description: >
            Required on every operation: the client timestamp of when the
            operation happened on-device. It is echoed on the result and is
            never used as an authoritative server time — the server records
            its own `serverTimestamp`.
        data:
          type: object
          description: >
            Type-specific payload: TASK_EXECUTION: { completionNotes? };
            CHECKLIST_RESPONSES: { responses: array|object }; 
            EVIDENCE_SUBMISSION: { evidenceType, executionType, executionId,
            evidenceRequirementId?, fileReference, originalFileName, mimeType,
            fileSize, capturedAt? }; TASK_ASSIGNMENT: { assignmentId,
            status? }; PATROL_EXECUTION: { completionNotes? } on COMPLETE;
            PATROL_POINT_VISIT: { patrolRoutePointId (required, authoritative
            BE-12B point id), notes? }; METER_READING: { value (required,
            finite number), notes? } — the UOM and the effective measurement
            range stay backend-owned and are NOT accepted from the client.
            Any operation may additionally carry `baseVersion` (BE-25I): the
            resource's `updatedAt` the client last saw; a stale baseVersion
            produces SYNC_CONFLICT. Evidence BYTES are never carried here —
            only metadata, uploaded through the evidence file API.
          additionalProperties: true
"""

OPERATION_ANCHOR = """      tags: [Mobile Execution]
      security:
        - bearerAuth: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/MobileSyncBatchRequest"
"""

OPERATION_EXTENSION = """      tags: [Mobile Execution]
      security:
        - bearerAuth: []
      x-required-permission: per-resourceType (see x-sync-supported-resource-types)
      x-building-scoped: true
      x-sync-supported-resource-types:
        - resourceType: TASK_EXECUTION
          operations: [START, COMPLETE, CANCEL]
          operationIds: [startTask, completeTask, cancelTask]
          permission: task.manage
        - resourceType: CHECKLIST_RESPONSES
          operations: [SAVE]
          operationIds: [saveChecklistResponses]
          permission: checklist.manage
        - resourceType: EVIDENCE_SUBMISSION
          operations: [SUBMIT]
          operationIds: [submitEvidence]
          permission: evidence.manage
        - resourceType: TASK_ASSIGNMENT
          operations: [UPDATE]
          operationIds: [updateTaskAssignment]
          permission: task.manage
        - resourceType: PATROL_EXECUTION
          operations: [START, COMPLETE]
          operationIds: [startPatrolExecution, completePatrolExecution]
          permission: patrol_execution.manage
        - resourceType: PATROL_POINT_VISIT
          operations: [SUBMIT]
          operationIds: [recordPatrolPointVisit]
          permission: patrol_execution.manage
        - resourceType: METER_READING
          operations: [SUBMIT]
          operationIds: [submitMeterReading]
          permission: meter_reading_binding.manage
      x-sync-unsupported-resource-types:
        - resourceType: WORK_ORDER_ACTION
          status: MISSING
          reason: >-
            The BE-08 action set is acknowledge / start / hold / resume / note
            / complete / cancel, but the sync envelope has no verb for
            acknowledge, hold, resume or note. Adding a kind that could carry
            only part of the action set would advertise a half-contract, and
            adding verbs is a separate decision.
          useInstead: [acknowledgeWorkOrder, startWorkOrder, completeWorkOrder]
        - resourceType: WORK_ORDER_MATERIAL_USAGE
          status: MISSING
          reason: >-
            `recordWorkOrderMaterialUsage` is a stock-ledger write (STOCK_OUT
            + balance + cost snapshot). Queued offline issues would be applied
            against availability that may no longer exist, and the contract
            has no reservation concept. This needs an explicit product
            decision, not a dispatcher entry.
          useInstead: [recordWorkOrderMaterialUsage]
        - resourceType: INCIDENT
          status: MISSING
          reason: >-
            Incident and Operational Incident creation requires a
            client-supplied `incidentNumber` that must be unique per Client;
            offline devices cannot allocate one safely, and the sync envelope
            keys every operation to an EXISTING authoritative `resourceId`.
          useInstead: [createIncident, createOperationalIncident]
        - resourceType: SECURITY_FINDING
          status: MISSING
          reason: >-
            Same create-shaped gap as INCIDENT — `createSecurityFinding`
            creates a new BE-09 Finding, so there is no prior authoritative
            resourceId to key the operation to.
          useInstead: [createSecurityFinding, createEngineeringFinding]
        - resourceType: SUPERVISOR_DECISION
          status: MISSING
          reason: >-
            Supervisor verification is an online reviewer act on a completed
            execution; queueing a stale approve/reject offline would let a
            decision be applied to state the reviewer never saw. Deliberately
            excluded.
          useInstead:
            [submitSupervisorInspectionDecision, submitMobileVerification,
             submitWorkOrderVerification]
        - resourceType: EVIDENCE_BYTES
          status: NOT_REQUIRED
          reason: >-
            The backend must not hold an offline byte queue. EVIDENCE_SUBMISSION
            syncs metadata only; bytes go to the evidence file API.
          useInstead: [uploadMobileEvidence, uploadEvidenceFile]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/MobileSyncBatchRequest"
"""


def main() -> None:
    text = SPEC.read_text()
    if "x-sync-supported-resource-types" in text:
        print("already extended")
        return

    if ANCHOR not in text:
        raise SystemExit("MobileSyncOperationItem anchor not found")
    text = text.replace(ANCHOR, REPLACEMENT, 1)

    if OPERATION_ANCHOR not in text:
        raise SystemExit("processSyncBatch request-body anchor not found")
    text = text.replace(OPERATION_ANCHOR, OPERATION_EXTENSION, 1)

    SPEC.write_text(text)
    print("extended mobile sync resource kinds in OpenAPI")


if __name__ == "__main__":
    main()
