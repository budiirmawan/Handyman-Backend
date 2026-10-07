import { AppError, ERROR_CODES } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { areaRepository } from '../areas';
import { floorRepository } from '../floors';
import { roomRepository } from '../rooms';
import { spaceRepository } from '../spaces';
import {
  buildingAccessDeniedError,
  contextAccessService,
} from '../context-access';
import { handymanExecutionScopeRepository }
  from './handyman-execution-scope.repository';
import type {
  HandymanExecutionScopeRecord,
  NewHandymanExecutionScope,
  PublicHandymanExecutionScope,
} from './handyman-execution-scope.types';

/**
 * CR-HM-06 PART 05 — Execution Scope boundary helpers (FROZEN F8/F9/
 * F10/F12). Scope creation happens ONLY inside the PART 04/05 APPROVE
 * transaction (decision service calls `buildScopeInput` + the
 * repository); this module additionally owns the authoritative
 * location derivation (fail-closed) and the bounded read seams.
 * No assignment/scheduling/arrival/session/payment/BAST surface.
 */

function assertUuid(value: string | undefined, field: string): void {
  if (value === undefined || !isValidUuid(value)) {
    throw AppError.validation('Execution scope validation failed.', [
      { field, message: `${field} must be a valid UUID.` },
    ]);
  }
}

export function handymanExecutionScopeNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_EXECUTION_SCOPE_NOT_FOUND,
    message: 'Handyman execution scope not found.',
    statusCode: 404,
  });
}

export function handymanExecutionScopeLocationInconsistentError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_EXECUTION_SCOPE_LOCATION_INCONSISTENT,
    message:
      'The authoritative unit/space location chain could not be resolved for execution scope creation.',
    statusCode: 400,
  });
}

export function handymanExecutionScopeConflictError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_EXECUTION_SCOPE_CONFLICT,
    message:
      'An execution scope already exists for this approved quotation version.',
    statusCode: 409,
  });
}

/**
 * Authoritative location derivation (F6/F9): resolves the frozen
 * request/space → room → area → floor chain with building consistency.
 * FAIL-CLOSED when the unit chain is unavailable or inconsistent —
 * approval then rolls back entirely (PART 05 t9 semantics). Never
 * accepts caller/QR/GPS/crew/provider/FM location input.
 */
export async function deriveExecutionScopeLocation(request: {
  buildingId: string;
  spaceId: string | null;
}): Promise<{
  buildingId: string;
  floorId: string | null;
  areaId: string | null;
  roomId: string | null;
  spaceId: string | null;
}> {
  if (!request.spaceId) {
    throw handymanExecutionScopeLocationInconsistentError();
  }
  const space = await spaceRepository.findById(request.spaceId);
  if (!space) throw handymanExecutionScopeLocationInconsistentError();
  const room = await roomRepository.findById(space.roomId);
  if (!room) throw handymanExecutionScopeLocationInconsistentError();
  const area = await areaRepository.findById(room.areaId);
  if (!area) throw handymanExecutionScopeLocationInconsistentError();
  const floor = await floorRepository.findById(area.floorId);
  if (!floor) throw handymanExecutionScopeLocationInconsistentError();
  if (floor.buildingId !== request.buildingId) {
    throw handymanExecutionScopeLocationInconsistentError();
  }
  return {
    buildingId: floor.buildingId,
    floorId: floor.id,
    areaId: area.id,
    roomId: room.id,
    spaceId: space.id,
  };
}

/** Server-derived New-row input for the approval transaction (F8/F9). */
export async function buildExecutionScopeInput(args: {
  clientId: string;
  handymanRequestId: string;
  channelAttributionId: string;
  quotationId: string;
  approvedQuotationVersionId: string;
  quotationDecisionId: string;
  tenantCompanyId: string;
  tenantPicId: string | null;
  derivedBuildingId: string;
  derivedSpaceId: string | null;
  createdByUserId: string;
}): Promise<NewHandymanExecutionScope> {
  const location = await deriveExecutionScopeLocation({
    buildingId: args.derivedBuildingId,
    spaceId: args.derivedSpaceId,
  });
  return {
    clientId: args.clientId,
    handymanRequestId: args.handymanRequestId,
    channelAttributionId: args.channelAttributionId,
    quotationId: args.quotationId,
    approvedQuotationVersionId: args.approvedQuotationVersionId,
    quotationDecisionId: args.quotationDecisionId,
    tenantCompanyId: args.tenantCompanyId,
    tenantPicId: args.tenantPicId,
    ...location,
    createdByUserId: args.createdByUserId,
  };
}

export function toPublicExecutionScope(
  row: HandymanExecutionScopeRecord,
): PublicHandymanExecutionScope {
  return {
    id: row.id,
    clientId: row.clientId,
    handymanRequestId: row.handymanRequestId,
    channelAttributionId: row.channelAttributionId,
    quotationId: row.quotationId,
    approvedQuotationVersionId: row.approvedQuotationVersionId,
    quotationDecisionId: row.quotationDecisionId,
    tenantCompanyId: row.tenantCompanyId,
    tenantPicId: row.tenantPicId,
    buildingId: row.buildingId,
    floorId: row.floorId,
    areaId: row.areaId,
    roomId: row.roomId,
    spaceId: row.spaceId,
    status: row.status,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Bounded exact read: the scope of an approved quotation version. */
export async function getHandymanExecutionScopeByQuotationVersion(
  quotationVersionId: string,
  actorUserId: string,
): Promise<PublicHandymanExecutionScope> {
  assertUuid(quotationVersionId, 'quotationVersionId');
  assertUuid(actorUserId, 'actorUserId');
  const scope = await handymanExecutionScopeRepository
    .findScopeByApprovedVersion(undefined, quotationVersionId);
  if (!scope) throw handymanExecutionScopeNotFoundError();
  if (
    !(await contextAccessService.canAccessClient(actorUserId, scope.clientId))
  ) {
    throw buildingAccessDeniedError();
  }
  return toPublicExecutionScope(scope);
}
