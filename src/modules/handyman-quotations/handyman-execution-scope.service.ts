import { AppError, ERROR_CODES } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { areaRepository } from '../areas';
import { floorRepository } from '../floors';
import { roomRepository } from '../rooms';
import { spaceRepository } from '../spaces';
import { assertBuildingScopedResourceAccess } from '../context-access';
import { handymanExecutionScopeRepository }
  from './handyman-execution-scope.repository';
import type {
  HandymanExecutionScopeActor,
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
 *
 * W03 PART 03E (A01 §7.1/§7.2 E1–E3, §10.3 C6/C7): creation is now actor-aware —
 * `buildExecutionScopeInput` takes the deciding actor rather than a staff user id,
 * checks the scope PIC against the decision PIC (E2), and the read seam projects
 * the actor class. There is still exactly one call site of `insertScope` in this
 * repository (the APPROVE branch of the decision engine), which is what makes E1
 * structural rather than a convention; the matching DB-side guard on the scope row
 * is the ratified 03F row and is NOT implemented here.
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
 * A01 §7.2 E2 — the scope's tenant/PIC context disagrees with the decision that
 * authorises it. Reuses the existing scope-conflict code because C15 forbids
 * minting new vocabulary for this PART; the diagnostic class is identical ("the
 * scope this transaction is about to write is not the one the decision supports").
 */
export function handymanExecutionScopeActorMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_EXECUTION_SCOPE_CONFLICT,
    message:
      'The execution scope context does not match the decision that authorises it.',
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
  /**
   * The deciding principal, passed straight through. E1's "only the APPROVE
   * branch of a decision may create a scope" is why this is an actor and not a
   * user id: a PIC approval has no user id, and inventing one to fill a NOT NULL
   * column is the leak A01 §6.1 exists to close.
   */
  actor: HandymanExecutionScopeActor;
  /** E2: the PIC recorded on the APPROVE decision itself. */
  decisionTenantPicId: string | null;
}): Promise<NewHandymanExecutionScope> {
  const location = await deriveExecutionScopeLocation({
    buildingId: args.derivedBuildingId,
    spaceId: args.derivedSpaceId,
  });
  if (args.actor.kind === 'TENANT_PIC') {
    // E2, service-side half. The DB guard independently requires the same PIC to
    // be ACTIVE in this tenant and the session to belong to it, so a stale or
    // borrowed id cannot ride a correct binding; this check exists so the caller
    // gets a typed conflict instead of a rolled-back insert.
    if (args.decisionTenantPicId !== args.actor.tenantPicId) {
      throw handymanExecutionScopeActorMismatchError();
    }
  } else if (args.decisionTenantPicId !== null) {
    // A USER decision never carries a PIC attribution, so this combination means
    // the decision and the scope were assembled from different rows.
    throw handymanExecutionScopeActorMismatchError();
  }
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
    actor: args.actor,
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
    createdByActorType: row.createdByActorType,
    createdByTenantPicId: row.createdByTenantPicId,
    // C7 deliberately does NOT project `createdByPicSessionId`: the session id is
    // the credential's identity, and a downstream operational read has no reason
    // to learn which credential carried an approval it only has to execute.
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
  // CR-HM-SEC-01 PART 02: the scope carries its own authoritative
  // building_id location snapshot (server-derived from the request
  // lineage) — enforce BE-02G directly (no same-Client shortcut).
  await assertBuildingScopedResourceAccess(actorUserId, {
    clientId: scope.clientId,
    buildingId: scope.buildingId,
  });
  return toPublicExecutionScope(scope);
}
