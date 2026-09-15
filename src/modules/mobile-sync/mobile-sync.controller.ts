import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../shared/errors';
import { sendSuccess } from '../../shared/api-response';
import { isValidUuid } from '../clients';
import {
  MAX_SYNC_BATCH_SIZE,
  OPERATIONS_BY_TYPE,
  mobileSyncService,
} from './mobile-sync.service';
import {
  MOBILE_SYNC_OPERATIONS,
  MOBILE_SYNC_RESOURCE_TYPES,
  type MobileSyncRequestItem,
} from './mobile-sync.types';

/**
 * BE-25G — Offline sync batch handler.
 *
 *   POST /mobile/sync   { operations: [ { operationId, resourceType,
 *                         resourceId, operation, clientTimestamp, data } ] }
 *
 * Envelope validation is batch-level (400 VALIDATION_ERROR with field
 * details) so a malformed batch is rejected before any write; per-item
 * business failures (validation, RBAC, data scope, workflow) are returned
 * as per-item FAILED results while the rest of the batch still executes.
 */
const OPERATION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateOperation(
  entry: unknown,
  index: number,
  details: { field: string; message: string }[],
): MobileSyncRequestItem | null {
  const field = (suffix: string) => `operations[${index}].${suffix}`;
  if (!isRecord(entry)) {
    details.push({
      field: `operations[${index}]`,
      message: 'Each operation must be an object.',
    });
    return null;
  }

  if (
    typeof entry.operationId !== 'string' ||
    !OPERATION_ID_PATTERN.test(entry.operationId)
  ) {
    details.push({
      field: field('operationId'),
      message:
        'operationId must be 1-128 characters of letters, digits, dots, underscores, and hyphens.',
    });
  }

  const resourceType = entry.resourceType;
  if (
    typeof resourceType !== 'string' ||
    !MOBILE_SYNC_RESOURCE_TYPES.includes(resourceType as never)
  ) {
    details.push({
      field: field('resourceType'),
      message: `resourceType must be one of: ${MOBILE_SYNC_RESOURCE_TYPES.join(', ')}.`,
    });
  }

  if (typeof entry.resourceId !== 'string' || !isValidUuid(entry.resourceId)) {
    details.push({
      field: field('resourceId'),
      message: 'resourceId must be a valid UUID.',
    });
  }

  if (
    typeof entry.operation !== 'string' ||
    !MOBILE_SYNC_OPERATIONS.includes(entry.operation as never)
  ) {
    details.push({
      field: field('operation'),
      message: `operation must be one of: ${MOBILE_SYNC_OPERATIONS.join(', ')}.`,
    });
  }

  if (typeof entry.clientTimestamp !== 'string') {
    details.push({
      field: field('clientTimestamp'),
      message: 'clientTimestamp must be an ISO-8601 timestamp string.',
    });
  } else if (Number.isNaN(Date.parse(entry.clientTimestamp))) {
    details.push({
      field: field('clientTimestamp'),
      message: 'clientTimestamp must be an ISO-8601 timestamp string.',
    });
  }

  if (!isRecord(entry.data)) {
    details.push({
      field: field('data'),
      message: 'data must be an object.',
    });
  }

  // Resource-type specific contract.
  if (typeof resourceType === 'string' && typeof entry.operation === 'string') {
    const allowed = OPERATIONS_BY_TYPE[resourceType as MobileSyncRequestItem['resourceType']];
    if (allowed && !allowed.includes(entry.operation)) {
      details.push({
        field: field('operation'),
        message: `operation ${entry.operation} is not valid for resourceType ${resourceType}.`,
      });
    }
    if (resourceType === 'EVIDENCE_SUBMISSION') {
      const data = entry.data as Record<string, unknown> | undefined;
      if (
        data &&
        typeof data.executionId === 'string' &&
        data.executionId !== entry.resourceId
      ) {
        details.push({
          field: field('data.executionId'),
          message: 'data.executionId must match resourceId for EVIDENCE_SUBMISSION.',
        });
      }
    }
    if (resourceType === 'TASK_ASSIGNMENT') {
      const data = entry.data as Record<string, unknown> | undefined;
      if (!data || typeof data.assignmentId !== 'string' || !isValidUuid(data.assignmentId)) {
        details.push({
          field: field('data.assignmentId'),
          message: 'data.assignmentId must be a valid UUID for TASK_ASSIGNMENT.',
        });
      }
    }
    if (resourceType === 'PATROL_POINT_VISIT') {
      // CR-BE-MOB-01 PART 06 — the checkpoint is an authoritative BE-12B
      // patrol route point id; it is never derived, guessed, or fabricated.
      const data = entry.data as Record<string, unknown> | undefined;
      if (
        !data ||
        typeof data.patrolRoutePointId !== 'string' ||
        !isValidUuid(data.patrolRoutePointId)
      ) {
        details.push({
          field: field('data.patrolRoutePointId'),
          message:
            'data.patrolRoutePointId must be a valid UUID for PATROL_POINT_VISIT.',
        });
      }
    }
    if (resourceType === 'METER_READING') {
      // CR-BE-MOB-01 PART 06 — the reading value is required; the UOM and the
      // effective measurement range stay backend-owned (BE-10C validates
      // them), so they are deliberately NOT accepted from the client.
      const data = entry.data as Record<string, unknown> | undefined;
      if (
        !data ||
        typeof data.value !== 'number' ||
        !Number.isFinite(data.value)
      ) {
        details.push({
          field: field('data.value'),
          message: 'data.value must be a finite number for METER_READING.',
        });
      }
    }
    if (resourceType === 'CHECKLIST_RESPONSES') {
      const data = entry.data as Record<string, unknown> | undefined;
      if (!data || (data.responses !== undefined && !Array.isArray(data.responses) && !isRecord(data.responses))) {
        details.push({
          field: field('data.responses'),
          message: 'data.responses must be an array of responses (or a single response object).',
        });
      }
    }
  }

  return {
    operationId: entry.operationId as string,
    resourceType: entry.resourceType as MobileSyncRequestItem['resourceType'],
    resourceId: entry.resourceId as string,
    operation: entry.operation as MobileSyncRequestItem['operation'],
    clientTimestamp: entry.clientTimestamp as string,
    data: (entry.data as Record<string, unknown>) ?? {},
  };
}

export async function processSyncBatchHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = req.body ?? {};
    const rawOperations = body.operations;

    const details: { field: string; message: string }[] = [];
    if (!Array.isArray(rawOperations) || rawOperations.length === 0) {
      details.push({
        field: 'operations',
        message: 'operations must be a non-empty array.',
      });
    } else if (rawOperations.length > MAX_SYNC_BATCH_SIZE) {
      details.push({
        field: 'operations',
        message: `operations must contain at most ${MAX_SYNC_BATCH_SIZE} items.`,
      });
    }

    const operations: MobileSyncRequestItem[] = [];
    if (details.length === 0) {
      rawOperations.forEach((entry: unknown, index: number) => {
        const operation = validateOperation(entry, index, details);
        if (operation) {
          operations.push(operation);
        }
      });
    }

    if (details.length > 0) {
      throw AppError.validation('Request validation failed.', details);
    }

    const batch = await mobileSyncService.processSyncBatch(
      req.auth.userId,
      operations,
      req.requestId,
    );
    sendSuccess(res, batch);
  } catch (error) {
    next(error);
  }
}
