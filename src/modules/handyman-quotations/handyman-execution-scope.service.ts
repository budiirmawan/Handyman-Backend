import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { isValidUuid } from '../clients';
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
 * W03 PART 03F (A01 E1–E3): creation is PIC-only and independently re-reads
 * the exact APPROVE decision, binding, session, lifecycle and lineage through
 * 0443's predicate before INSERT. Location and eligibility share the approval's
 * transaction. 0443 repeats the check at INSERT even if a future writer skips
 * this helper. USER rows remain a historical read shape only (A9/E4).
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
}, executor: Pick<PoolClient, 'query'> = getPool()): Promise<{
  buildingId: string;
  floorId: string | null;
  areaId: string | null;
  roomId: string | null;
  spaceId: string | null;
}> {
  if (!request.spaceId) {
    throw handymanExecutionScopeLocationInconsistentError();
  }
  const location = await handymanExecutionScopeRepository.resolveScopeLocation(
    executor, request.buildingId, request.spaceId,
  );
  if (!location) throw handymanExecutionScopeLocationInconsistentError();
  return location;
}

/** Server-derived New-row input for the approval transaction (F8/F9). */
export async function buildExecutionScopeInput(tx: PoolClient, args: {
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
  // E1/E2: a historical USER shape is never a creation capability. The supplied
  // PIC comparison is only an early refusal; the stored decision is re-read below.
  if (args.actor.kind !== 'TENANT_PIC' ||
      args.decisionTenantPicId !== args.actor.tenantPicId) {
    throw handymanExecutionScopeActorMismatchError();
  }
  const location = await deriveExecutionScopeLocation({
    buildingId: args.derivedBuildingId,
    spaceId: args.derivedSpaceId,
  }, tx);
  const input: NewHandymanExecutionScope = {
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
  if (!(await handymanExecutionScopeRepository.isNewScopeApprovalValid(tx, input))) {
    throw handymanExecutionScopeActorMismatchError();
  }
  return input;
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
