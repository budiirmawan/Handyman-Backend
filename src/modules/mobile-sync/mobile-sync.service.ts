import { randomUUID } from 'node:crypto';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { logger } from '../../shared/logger';
import { permissionService } from '../permissions';
import { executeTaskAction } from '../task-execution/task-execution.service';
import { saveChecklistResponses } from '../checklist-executions/checklist-execution.service';
import { submitEvidenceMetadata } from '../evidence/evidence.service';
import { updateTaskAssignmentStatus } from '../task-assignments/task-assignment.service';
import { patrolExecutionService } from '../patrol-executions/patrol-execution.service';
import { meterReadingBindingService } from '../meter-reading-bindings/meter-reading-binding.service';
import {
  findStoredOperation,
  storeOperationResult,
  storedToResult,
} from './mobile-sync-idempotency';
import { detectConflict } from './mobile-sync-conflict';
import type {
  MobileSyncBatchResponse,
  MobileSyncRequestItem,
  MobileSyncResourceType,
  MobileSyncResultItem,
} from './mobile-sync.types';

/**
 * BE-25I — Offline sync batch service with idempotent, conflict-aware
 * operations.
 *
 * Executes a batch of client-generated operations by delegating each one to
 * the SAME shared service the corresponding REST endpoint uses. Validation,
 * RBAC, data scope, and workflow rules are therefore identical to the online
 * endpoints — the sync batch never bypasses them and never re-implements
 * business logic.
 *
 * Idempotency (BE-25H): each operation is keyed by (user_id, operation_id).
 * A duplicate retry (same operation id, any later batch) replays the ORIGINAL
 * stored result — success OR failure — without executing the write again.
 * The unique key also guards concurrent duplicate batches.
 *
 * Conflict handling (BE-25I): when the client sends `data.baseVersion` (the
 * resource `updatedAt` it last saw) and it is older than the CURRENT server
 * version, the operation returns a SYNC_CONFLICT result with the current
 * server state and reload guidance — the write is NOT executed and newer
 * server data is never silently overwritten. Conflicts are not persisted in
 * the idempotency store (no write happened; a corrected retry is a fresh
 * intent).
 *
 * Each operation is executed independently: a failing operation produces a
 * per-item FAILED result (which is also stored and replayed) and never
 * blocks the rest of the batch.
 */

export const MAX_SYNC_BATCH_SIZE = 100;

const REQUIRED_PERMISSION: Record<MobileSyncResourceType, string> = {
  TASK_EXECUTION: 'task.manage',
  CHECKLIST_RESPONSES: 'checklist.manage',
  EVIDENCE_SUBMISSION: 'evidence.manage',
  TASK_ASSIGNMENT: 'task.manage',
  // PART 06 — identical to the permission the published REST route enforces.
  PATROL_EXECUTION: 'patrol_execution.manage',
  PATROL_POINT_VISIT: 'patrol_execution.manage',
  METER_READING: 'meter_reading_binding.manage',
};

/**
 * CR-BE-MOB-01 PART 06 — the published operation each synced kind executes.
 * Documentation-grade traceability: a kind must map to a stable, published
 * `operationId`, and the sync dispatcher must call the SAME service that
 * operation calls.
 */
export const PUBLISHED_OPERATION_BY_TYPE: Record<
  MobileSyncResourceType,
  Readonly<Record<string, string>>
> = {
  TASK_EXECUTION: {
    START: 'startTask',
    COMPLETE: 'completeTask',
    CANCEL: 'cancelTask',
  },
  CHECKLIST_RESPONSES: { SAVE: 'saveChecklistResponses' },
  EVIDENCE_SUBMISSION: { SUBMIT: 'submitEvidence' },
  TASK_ASSIGNMENT: { UPDATE: 'updateTaskAssignment' },
  PATROL_EXECUTION: {
    START: 'startPatrolExecution',
    COMPLETE: 'completePatrolExecution',
  },
  PATROL_POINT_VISIT: { SUBMIT: 'recordPatrolPointVisit' },
  METER_READING: { SUBMIT: 'submitMeterReading' },
};

export const OPERATIONS_BY_TYPE: Record<
  MobileSyncResourceType,
  readonly string[]
> = {
  TASK_EXECUTION: ['START', 'COMPLETE', 'CANCEL'],
  CHECKLIST_RESPONSES: ['SAVE'],
  EVIDENCE_SUBMISSION: ['SUBMIT'],
  TASK_ASSIGNMENT: ['UPDATE'],
  // PART 06 — no new operation verb was introduced.
  PATROL_EXECUTION: ['START', 'COMPLETE'],
  PATROL_POINT_VISIT: ['SUBMIT'],
  METER_READING: ['SUBMIT'],
};

function permissionDeniedError(): AppError {
  return new AppError({
    code: ERROR_CODES.PERMISSION_DENIED,
    message: 'You do not have permission to perform this action.',
    statusCode: 403,
  });
}

async function executeOperation(
  userId: string,
  permissions: string[],
  operation: MobileSyncRequestItem,
): Promise<MobileSyncResultItem> {
  const serverTimestamp = new Date().toISOString();
  const base = {
    operationId: operation.operationId,
    clientTimestamp: operation.clientTimestamp,
  };

  try {
    const required = REQUIRED_PERMISSION[operation.resourceType];
    if (!permissions.includes(required)) {
      throw permissionDeniedError();
    }

    let result: unknown;
    switch (operation.resourceType) {
      case 'TASK_EXECUTION': {
        const action = operation.operation.toLowerCase() as 'start' | 'complete' | 'cancel';
        const completionNotes =
          operation.operation === 'COMPLETE'
            ? (operation.data?.completionNotes as string | null | undefined)
            : undefined;
        result = await executeTaskAction(
          operation.resourceId,
          action,
          userId,
          completionNotes,
        );
        break;
      }
      case 'CHECKLIST_RESPONSES': {
        result = await saveChecklistResponses(
          operation.resourceId,
          userId,
          operation.data?.responses,
        );
        break;
      }
      case 'EVIDENCE_SUBMISSION': {
        result = await submitEvidenceMetadata(
          { ...operation.data, executionId: operation.resourceId },
          userId,
        );
        break;
      }
      case 'TASK_ASSIGNMENT': {
        result = await updateTaskAssignmentStatus(
          operation.resourceId,
          operation.data?.assignmentId as string,
          userId,
          (operation.data?.status as string | undefined) ?? 'INACTIVE',
        );
        break;
      }
      case 'PATROL_EXECUTION': {
        // BE-12D. `resourceId` is the patrol execution id (= BE-07 taskId).
        // Both branches delegate to the SAME service the published
        // startPatrolExecution / completePatrolExecution routes call, so the
        // patrol checkpoint-progress rules and the shared task-execution
        // engine still own the transition.
        result =
          operation.operation === 'START'
            ? await patrolExecutionService.startPatrolExecution(
                operation.resourceId,
                userId,
              )
            : await patrolExecutionService.completePatrolExecution(
                operation.resourceId,
                userId,
                (operation.data?.completionNotes as string | null | undefined) ??
                  null,
              );
        break;
      }
      case 'PATROL_POINT_VISIT': {
        // BE-12D. `resourceId` is the patrol execution id; the checkpoint is
        // the authoritative BE-12B point id carried in the payload. No
        // identifier is fabricated and no QR target is implied.
        result = await patrolExecutionService.recordPatrolPointVisit(
          operation.resourceId,
          {
            patrolRoutePointId: operation.data?.patrolRoutePointId as string,
            ...(operation.data?.notes === undefined
              ? {}
              : { notes: operation.data?.notes as string | null }),
          },
          userId,
        );
        break;
      }
      case 'METER_READING': {
        // BE-10C. `resourceId` is the BE-07 form instance started from a
        // meter-reading binding; the value is written into BE-07
        // `form_responses` by the same idempotent upsert the published
        // submitMeterReading route uses (range + UOM stay backend-owned).
        result = await meterReadingBindingService.submitMeterReading(
          operation.resourceId,
          userId,
          {
            value: operation.data?.value as number,
            notes: (operation.data?.notes as string | null | undefined) ?? null,
          },
        );
        break;
      }
    }

    return {
      ...base,
      success: true,
      status: 'SUCCESS',
      result,
      error: null,
      serverTimestamp,
    };
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError({
            code: ERROR_CODES.INTERNAL_SERVER_ERROR,
            message: 'An unexpected server error occurred.',
            statusCode: 500,
          });
    return {
      ...base,
      success: false,
      status: 'FAILED',
      result: null,
      error: {
        code: appError.code,
        message: appError.message,
        // BE-25K — resource/context reference where useful.
        resource: {
          type: operation.resourceType,
          id: operation.resourceId,
        },
      },
      serverTimestamp,
    };
  }
}

export async function processSyncBatch(
  userId: string,
  operations: MobileSyncRequestItem[],
  requestId?: string,
): Promise<MobileSyncBatchResponse> {
  // Resolve the caller's effective permissions ONCE per batch (RBAC
  // authority identical to the REST endpoints).
  const permissions = await permissionService.resolvePermissionsForUser(userId);

  const results: MobileSyncResultItem[] = [];
  for (const operation of operations) {
    // Duplicate replay detection: same user + same operation id → return
    // the original stored result without executing the write again.
    const stored = await findStoredOperation(userId, operation.operationId);
    if (stored) {
      results.push(storedToResult(stored));
      continue;
    }

    // Conflict detection (BE-25I): a stale baseVersion blocks the write and
    // returns the current server state + reload guidance. Conflicts are NOT
    // stored (no write happened). Detection errors (e.g. data-scope denial
    // from the scoped reader) become per-item FAILED results — they never
    // break the batch or leak into an HTTP error.
    let conflict: Awaited<ReturnType<typeof detectConflict>> = null;
    try {
      conflict = await detectConflict(operation, userId);
    } catch (error) {
      const appError =
        error instanceof AppError
          ? error
          : new AppError({
              code: ERROR_CODES.INTERNAL_SERVER_ERROR,
              message: 'An unexpected server error occurred.',
              statusCode: 500,
            });
      results.push({
        operationId: operation.operationId,
        clientTimestamp: operation.clientTimestamp,
        success: false,
        status: 'FAILED',
        result: null,
        error: {
          code: appError.code,
          message: appError.message,
          // BE-25K — resource/context reference where useful.
          resource: {
            type: operation.resourceType,
            id: operation.resourceId,
          },
        },
        serverTimestamp: new Date().toISOString(),
      });
      continue;
    }
    if (conflict) {
      results.push({
        operationId: operation.operationId,
        clientTimestamp: operation.clientTimestamp,
        success: false,
        status: 'FAILED',
        result: null,
        error: {
          code: conflict.code,
          message: conflict.message,
          // BE-25K — resource/context reference where useful.
          resource: {
            type: operation.resourceType,
            id: operation.resourceId,
          },
          conflict: {
            current: conflict.current,
            guidance: conflict.guidance,
          },
        },
        serverTimestamp: new Date().toISOString(),
      });
      continue;
    }

    const result = await executeOperation(userId, permissions, operation);
    try {
      await storeOperationResult(userId, operation, result);
    } catch (error) {
      // The (user_id, operation_id) unique key is the race guard: when a
      // concurrent request already stored this operation, replay its result.
      if (error instanceof Error && (error as { code?: string }).code === '23505') {
        const concurrent = await findStoredOperation(userId, operation.operationId);
        if (concurrent) {
          results.push(storedToResult(concurrent));
          continue;
        }
      }
      // Storage failure must not leak into the response; the write already
      // happened, and the caller sees the live result (next retry replays).
      results.push(result);
      continue;
    }
    results.push(result);
  }

  const batchId = randomUUID();
  const failedCount = results.filter((result) => !result.success).length;
  const replayedCount = operations.length - results.length;

  // BE-25N — sync operation trace/reference: one structured summary log per
  // batch (batchId + requestId correlation + counts). Never logs tokens,
  // bodies, or evidence payloads.
  logger.info('Mobile sync batch processed', {
    requestId,
    batchId,
    userId,
    operationCount: operations.length,
    successCount: results.length - failedCount,
    failedCount,
    replayedCount,
  });
  for (const result of results) {
    if (!result.success) {
      logger.warn('Mobile sync operation failed', {
        requestId,
        batchId,
        userId,
        operationId: result.operationId,
        resourceType: result.error?.resource?.type,
        resourceId: result.error?.resource?.id,
        errorCode: result.error?.code,
      });
    }
  }

  return {
    batchId,
    receivedAt: new Date().toISOString(),
    results,
  };
}

export const mobileSyncService = { processSyncBatch };
