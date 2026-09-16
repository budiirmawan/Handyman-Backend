import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { AppError } from '../../shared/errors';
import { contextAccessService } from '../context-access';
import {
  handymanRequestNotFoundError,
  handymanRequestStatusInvalidError,
  handymanRequestRepository,
} from '../handyman-requests';
import { recordOperationalEvent } from '../operational-events';
import {
  handymanInspectionAlreadyOpenError,
  handymanRequestTriageNotAllowedError,
  handymanTriageNotFoundError,
} from './handyman-request-governance.errors';
import type {
  HandymanRequestTriageRecord,
  PublicHandymanRequestTriage,
  TriageHandymanRequestInput,
} from './handyman-request-governance.types';
import { handymanInspectionRepository } from './handyman-inspection.repository';
import { handymanRequestTriageRepository } from './handyman-request-triage.repository';
import { handymanServiceSelectionRepository } from './handyman-service-selection.repository';

/**
 * CR-HM-BE-03 RUN 1 — Triage history authority.
 *
 * The triage decision lives in the append-only `handyman_request_triages`
 * aggregate (never as mutable columns on the request). All request lifecycle
 * movement goes through the CR-HM-BE-01 guarded `updateStatusFrom`
 * transition, inside one transaction with the decision row and its
 * operational event, so concurrent commands cannot both win and no stale
 * write can slip through.
 *
 * Governed rules:
 * - first triage: request must be SUBMITTED; QUOTATION path → TRIAGED,
 *   INSPECTION path → INSPECTION_REQUIRED;
 * - re-triage: allowed only from the pre-quotation lifecycle states
 *   (TRIAGED / INSPECTION_REQUIRED / INSPECTION_COMPLETED) — the quotation
 *   phase states and CANCELLED are structurally excluded; the prior ACTIVE
 *   decision is superseded (history preserved) and every ACTIVE TRIAGE-source
 *   service selection is superseded with it;
 * - re-triage onto the QUOTATION path is blocked while an inspection is OPEN
 *   (complete or cancel it first);
 * - free-text request fields are never parsed into any authority.
 */

const UNIQUE_VIOLATION = '23505';
const ONE_ACTIVE_TRIAGE_CONSTRAINT = 'handyman_request_triages_one_active_per_request';

/** Pre-quotation lifecycle states from which re-triage is governed. */
const RETRIAGEABLE_REQUEST_STATUSES = new Set([
  'TRIAGED',
  'INSPECTION_REQUIRED',
  'INSPECTION_COMPLETED',
]);

function isOneActiveTriageViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { code?: string }).code === UNIQUE_VIOLATION &&
    (error as { constraint?: string }).constraint === ONE_ACTIVE_TRIAGE_CONSTRAINT
  );
}

function normalizeNotes(notes: string | null | undefined): string | null {
  if (notes === undefined || notes === null) return null;
  if (typeof notes !== 'string') {
    throw AppError.validation('Request validation failed.', [
      { field: 'notes', message: 'Notes must be a string.' },
    ]);
  }
  const trimmed = notes.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 2000) {
    throw AppError.validation('Request validation failed.', [
      { field: 'notes', message: 'Notes must be at most 2000 characters.' },
    ]);
  }
  return trimmed;
}

function toPublicTriage(
  record: HandymanRequestTriageRecord,
): PublicHandymanRequestTriage {
  return {
    id: record.id,
    requestId: record.requestId,
    clientId: record.clientId,
    buildingId: record.buildingId,
    path: record.path,
    notes: record.notes,
    status: record.status,
    triagedByUserId: record.triagedByUserId,
    triagedAt: record.triagedAt.toISOString(),
    supersededAt: record.supersededAt ? record.supersededAt.toISOString() : null,
    supersededByUserId: record.supersededByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
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

export async function triageHandymanRequest(
  input: TriageHandymanRequestInput,
  actorUserId: string,
): Promise<PublicHandymanRequestTriage> {
  const notes = normalizeNotes(input.notes);
  const targetStatus = input.path === 'QUOTATION' ? 'TRIAGED' : 'INSPECTION_REQUIRED';

  return withTransaction(async (tx) => {
    const request = await loadRequestOrThrow(input.requestId, actorUserId, tx);
    const activeTriage = await handymanRequestTriageRepository.findActiveByRequest(
      request.id,
      tx,
    );

    let previousTriageId: string | null = null;
    let supersededSelectionIds: string[] = [];
    const previousStatus = request.status;

    if (!activeTriage) {
      // First triage: SUBMITTED only (BE-01 cancel semantics untouched).
      if (request.status !== 'SUBMITTED') {
        throw handymanRequestStatusInvalidError(
          'Only submitted handyman requests can be triaged.',
        );
      }
      const moved = await handymanRequestRepository.updateStatusFrom(
        request.id,
        'SUBMITTED',
        targetStatus,
        tx,
      );
      if (!moved) {
        throw handymanRequestTriageNotAllowedError(
          'The handyman request lifecycle changed concurrently; retry the triage.',
        );
      }
    } else {
      // Re-triage: pre-quotation states only; history is superseded, never
      // overwritten. QUOTATION_PENDING / APPROVED / QUOTATION_REJECTED /
      // CANCELLED are structurally excluded by the allowlist.
      if (!RETRIAGEABLE_REQUEST_STATUSES.has(request.status)) {
        throw handymanRequestTriageNotAllowedError(
          `A handyman request in status ${request.status} can no longer be re-triaged.`,
        );
      }
      if (input.path === 'QUOTATION') {
        const openInspection = await handymanInspectionRepository.findOpenByRequest(
          request.id,
          tx,
        );
        if (openInspection) {
          throw handymanInspectionAlreadyOpenError();
        }
      }
      if (request.status !== targetStatus) {
        const moved = await handymanRequestRepository.updateStatusFrom(
          request.id,
          previousStatus,
          targetStatus,
          tx,
        );
        if (!moved) {
          throw handymanRequestTriageNotAllowedError(
            'The handyman request lifecycle changed concurrently; retry the triage.',
          );
        }
      }
      const superseded = await handymanRequestTriageRepository.supersedeActive(
        activeTriage.id,
        actorUserId,
        tx,
      );
      if (!superseded) {
        throw handymanRequestTriageNotAllowedError(
          'The prior triage decision changed concurrently; retry the triage.',
        );
      }
      previousTriageId = activeTriage.id;
      // Re-triage supersedes every ACTIVE TRIAGE-source selection; INSPECTION
      // selections belong to completed-inspection history and remain.
      supersededSelectionIds =
        await handymanServiceSelectionRepository.supersedeActiveTriageSource(
          request.id,
          actorUserId,
          tx,
        );
    }

    let created: HandymanRequestTriageRecord;
    try {
      created = await handymanRequestTriageRepository.create(
        {
          requestId: request.id,
          clientId: request.clientId,
          buildingId: request.buildingId,
          path: input.path,
          notes,
          triagedByUserId: actorUserId,
        },
        tx,
      );
    } catch (error) {
      if (isOneActiveTriageViolation(error)) {
        throw handymanRequestTriageNotAllowedError(
          'A concurrent triage command won; retry the triage.',
        );
      }
      throw error;
    }

    await recordOperationalEvent(
      {
        clientId: request.clientId,
        buildingId: request.buildingId,
        eventType: previousTriageId
          ? 'HANDYMAN_REQUEST_RETRIAGED'
          : 'HANDYMAN_REQUEST_TRIAGED',
        entityType: 'HANDYMAN_REQUEST',
        entityId: request.id,
        actorUserId,
        summary: `Handyman request ${request.requestNumber} triaged onto the ${input.path} path.`,
        metadata: {
          requestNumber: request.requestNumber,
          path: input.path,
          triageId: created.id,
          previousTriageId,
          previousStatus,
          newStatus: targetStatus,
          supersededSelectionIds,
        },
      },
      tx,
    );

    return toPublicTriage(created);
  });
}

export async function getHandymanRequestTriage(
  triageId: string,
  actorUserId: string,
): Promise<PublicHandymanRequestTriage> {
  const triage = await handymanRequestTriageRepository.findById(triageId);
  if (!triage) throw handymanTriageNotFoundError();
  await loadRequestOrThrow(triage.requestId, actorUserId, getPool());
  return toPublicTriage(triage);
}

export async function listHandymanRequestTriages(
  requestId: string,
  actorUserId: string,
): Promise<PublicHandymanRequestTriage[]> {
  return withTransaction(async (tx) => {
    await loadRequestOrThrow(requestId, actorUserId, tx);
    const rows = await handymanRequestTriageRepository.listByRequest(requestId, tx);
    return rows.map(toPublicTriage);
  });
}

export const handymanRequestTriageService = {
  getHandymanRequestTriage,
  listHandymanRequestTriages,
  triageHandymanRequest,
};
