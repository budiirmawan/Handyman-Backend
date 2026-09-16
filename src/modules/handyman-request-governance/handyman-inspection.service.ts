import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { AppError } from '../../shared/errors';
import { loadChecklistExecutionRow } from '../checklist-executions';
import { contextAccessService } from '../context-access';
import {
  handymanRequestNotFoundError,
  handymanRequestRepository,
} from '../handyman-requests';
import { recordOperationalEvent } from '../operational-events';
import {
  handymanInspectionAlreadyOpenError,
  handymanInspectionChecklistInvalidError,
  handymanInspectionNotAllowedError,
  handymanInspectionNotFoundError,
  handymanInspectionStateInvalidError,
} from './handyman-request-governance.errors';
import type {
  CompleteHandymanInspectionInput,
  HandymanInspectionRecord,
  OpenHandymanInspectionInput,
  PublicHandymanInspection,
} from './handyman-request-governance.types';
import { handymanInspectionRepository } from './handyman-inspection.repository';
import { handymanRequestTriageRepository } from './handyman-request-triage.repository';

/**
 * CR-HM-BE-03 RUN 1 — Inspection authority.
 *
 * A thin domain aggregate over the request lifecycle: an inspection may be
 * opened only for a request whose ACTIVE triage path is INSPECTION (request
 * status INSPECTION_REQUIRED), at most one OPEN inspection per request, and
 * completion is a guarded OPEN → COMPLETED transition that writes diagnosis
 * + scope exactly once and moves the request to INSPECTION_COMPLETED.
 * COMPLETED inspections are immutable.
 *
 * Checklist reuse without duplication: the optional binding is validated
 * through the existing BE-07 authority (`loadChecklistExecutionRow`, which
 * enforces existence and the BE-02G accessible-client scope) plus an exact
 * same-client-as-request check and a not-cancelled check. Evidence keeps
 * flowing through the existing checklist/evidence foundations — this module
 * creates no checklist or evidence logic.
 */

const UNIQUE_VIOLATION = '23505';
const ONE_OPEN_INSPECTION_CONSTRAINT = 'handyman_inspections_one_open_per_request';

function isOneOpenInspectionViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { code?: string }).code === UNIQUE_VIOLATION &&
    (error as { constraint?: string }).constraint === ONE_OPEN_INSPECTION_CONSTRAINT
  );
}

function toPublicInspection(
  record: HandymanInspectionRecord,
): PublicHandymanInspection {
  return {
    id: record.id,
    requestId: record.requestId,
    clientId: record.clientId,
    buildingId: record.buildingId,
    spaceId: record.spaceId,
    status: record.status,
    diagnosis: record.diagnosis,
    scopeNotes: record.scopeNotes,
    checklistExecutionId: record.checklistExecutionId,
    openedByUserId: record.openedByUserId,
    openedAt: record.openedAt.toISOString(),
    inspectedByUserId: record.inspectedByUserId,
    inspectedAt: record.inspectedAt ? record.inspectedAt.toISOString() : null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function parseCompletionInput(
  input: CompleteHandymanInspectionInput,
): { diagnosis: string; scopeNotes: string } {
  const details: { field: string; message: string }[] = [];
  const diagnosis =
    typeof input.diagnosis === 'string' ? input.diagnosis.trim() : '';
  const scopeNotes =
    typeof input.scopeNotes === 'string' ? input.scopeNotes.trim() : '';
  if (diagnosis.length === 0 || diagnosis.length > 4000) {
    details.push({
      field: 'diagnosis',
      message: 'Diagnosis is required and must be at most 4000 characters.',
    });
  }
  if (scopeNotes.length === 0 || scopeNotes.length > 2000) {
    details.push({
      field: 'scopeNotes',
      message: 'Scope notes are required and must be at most 2000 characters.',
    });
  }
  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }
  return { diagnosis, scopeNotes };
}

async function loadRequestOrThrow(
  requestId: string,
  actorUserId: string,
  tx: Pick<PoolClient, 'query'>,
) {
  const request = await handymanRequestRepository.findById(requestId, tx);
  if (!request) throw handymanRequestNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, request.buildingId);
  return request;
}

export async function openHandymanInspection(
  input: OpenHandymanInspectionInput,
  actorUserId: string,
): Promise<PublicHandymanInspection> {
  return withTransaction(async (tx) => {
    const request = await loadRequestOrThrow(input.requestId, actorUserId, tx);

    const activeTriage = await handymanRequestTriageRepository.findActiveByRequest(
      request.id,
      tx,
    );
    if (!activeTriage || activeTriage.path !== 'INSPECTION') {
      throw handymanInspectionNotAllowedError();
    }
    if (request.status !== 'INSPECTION_REQUIRED') {
      throw handymanInspectionNotAllowedError(
        `An inspection can only be opened while the request is INSPECTION_REQUIRED (current status: ${request.status}).`,
      );
    }

    const open = await handymanInspectionRepository.findOpenByRequest(request.id, tx);
    if (open) throw handymanInspectionAlreadyOpenError();

    // Optional checklist binding — validated through the existing BE-07
    // authority (existence + actor client scope), then pinned to the
    // request's client and rejected when cancelled.
    let checklistExecutionId: string | null = null;
    if (input.checklistExecutionId !== undefined && input.checklistExecutionId !== null) {
      const execution = await loadChecklistExecutionRow(
        input.checklistExecutionId,
        actorUserId,
      );
      if (execution.client_id !== request.clientId) {
        throw handymanInspectionChecklistInvalidError(
          'The checklist execution belongs to a different client.',
        );
      }
      if (execution.status === 'CANCELLED') {
        throw handymanInspectionChecklistInvalidError(
          'The checklist execution is cancelled.',
        );
      }
      checklistExecutionId = execution.id;
    }

    let created: HandymanInspectionRecord;
    try {
      created = await handymanInspectionRepository.create(
        {
          requestId: request.id,
          clientId: request.clientId,
          buildingId: request.buildingId,
          spaceId: request.spaceId,
          checklistExecutionId,
          openedByUserId: actorUserId,
        },
        tx,
      );
    } catch (error) {
      if (isOneOpenInspectionViolation(error)) {
        throw handymanInspectionAlreadyOpenError();
      }
      throw error;
    }

    await recordOperationalEvent(
      {
        clientId: request.clientId,
        buildingId: request.buildingId,
        eventType: 'HANDYMAN_INSPECTION_OPENED',
        entityType: 'HANDYMAN_INSPECTION',
        entityId: created.id,
        actorUserId,
        summary: `Inspection opened for handyman request ${request.requestNumber}.`,
        metadata: {
          requestNumber: request.requestNumber,
          requestId: request.id,
          checklistExecutionId,
        },
      },
      tx,
    );

    return toPublicInspection(created);
  });
}

export async function completeHandymanInspection(
  inspectionId: string,
  input: CompleteHandymanInspectionInput,
  actorUserId: string,
): Promise<PublicHandymanInspection> {
  const completion = parseCompletionInput(input);

  return withTransaction(async (tx) => {
    const inspection = await handymanInspectionRepository.findById(inspectionId, tx);
    if (!inspection) throw handymanInspectionNotFoundError();
    const request = await loadRequestOrThrow(inspection.requestId, actorUserId, tx);

    if (inspection.status !== 'OPEN') {
      throw handymanInspectionStateInvalidError(
        `Only open inspections can be completed (current status: ${inspection.status}).`,
      );
    }

    const completed = await handymanInspectionRepository.completeFromOpen(
      inspection.id,
      completion,
      actorUserId,
      tx,
    );
    if (!completed) {
      throw handymanInspectionStateInvalidError(
        'The inspection changed state concurrently; retry the completion.',
      );
    }

    const moved = await handymanRequestRepository.updateStatusFrom(
      request.id,
      'INSPECTION_REQUIRED',
      'INSPECTION_COMPLETED',
      tx,
    );
    if (!moved) {
      // Rolling back keeps inspection completion and request lifecycle
      // atomic — a completed inspection can never outlive a stale request.
      throw handymanInspectionStateInvalidError(
        'The request lifecycle changed concurrently; the inspection completion was rolled back.',
      );
    }

    await recordOperationalEvent(
      {
        clientId: request.clientId,
        buildingId: request.buildingId,
        eventType: 'HANDYMAN_INSPECTION_COMPLETED',
        entityType: 'HANDYMAN_INSPECTION',
        entityId: completed.id,
        actorUserId,
        summary: `Inspection completed for handyman request ${request.requestNumber}.`,
        metadata: {
          requestNumber: request.requestNumber,
          requestId: request.id,
          inspectionId: completed.id,
        },
      },
      tx,
    );

    return toPublicInspection(completed);
  });
}

export async function cancelHandymanInspection(
  inspectionId: string,
  actorUserId: string,
): Promise<PublicHandymanInspection> {
  return withTransaction(async (tx) => {
    const inspection = await handymanInspectionRepository.findById(inspectionId, tx);
    if (!inspection) throw handymanInspectionNotFoundError();
    const request = await loadRequestOrThrow(inspection.requestId, actorUserId, tx);

    if (inspection.status !== 'OPEN') {
      throw handymanInspectionStateInvalidError(
        `Only open inspections can be cancelled (current status: ${inspection.status}).`,
      );
    }

    const cancelled = await handymanInspectionRepository.cancelFromOpen(
      inspection.id,
      tx,
    );
    if (!cancelled) {
      throw handymanInspectionStateInvalidError(
        'The inspection changed state concurrently; retry the cancellation.',
      );
    }

    await recordOperationalEvent(
      {
        clientId: request.clientId,
        buildingId: request.buildingId,
        eventType: 'HANDYMAN_INSPECTION_CANCELLED',
        entityType: 'HANDYMAN_INSPECTION',
        entityId: cancelled.id,
        actorUserId,
        summary: `Inspection cancelled for handyman request ${request.requestNumber}.`,
        metadata: {
          requestNumber: request.requestNumber,
          requestId: request.id,
          inspectionId: cancelled.id,
        },
      },
      tx,
    );

    return toPublicInspection(cancelled);
  });
}

export async function getHandymanInspection(
  inspectionId: string,
  actorUserId: string,
): Promise<PublicHandymanInspection> {
  const inspection = await handymanInspectionRepository.findById(inspectionId);
  if (!inspection) throw handymanInspectionNotFoundError();
  await loadRequestOrThrow(inspection.requestId, actorUserId, getPool());
  return toPublicInspection(inspection);
}

export async function listHandymanInspections(
  requestId: string,
  actorUserId: string,
): Promise<PublicHandymanInspection[]> {
  return withTransaction(async (tx) => {
    await loadRequestOrThrow(requestId, actorUserId, tx);
    const rows = await handymanInspectionRepository.listByRequest(requestId, tx);
    return rows.map(toPublicInspection);
  });
}

export const handymanInspectionService = {
  cancelHandymanInspection,
  completeHandymanInspection,
  getHandymanInspection,
  listHandymanInspections,
  openHandymanInspection,
};
