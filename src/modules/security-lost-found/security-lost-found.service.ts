import { resolveAssetBuildingContext } from '../assets';
import { buildingNotFoundError, buildingRepository } from '../buildings';
import { contextAccessService } from '../context-access';
import {
  functionalLocationNotFoundError,
  functionalLocationRepository,
} from '../functional-locations';
import { recordOperationalEvent } from '../operational-events';
import { securityPostNotFoundError, securityPostRepository } from '../security-posts';
import {
  securityLostFoundDuplicateActiveClaimError,
  securityLostFoundFunctionalLocationBuildingMismatchError,
  securityLostFoundInvalidDateRangeError,
  securityLostFoundInvalidTransitionError,
  securityLostFoundItemCodeAlreadyExistsError,
  securityLostFoundNoActiveClaimError,
  securityLostFoundNotFoundError,
  securityLostFoundReturnInvalidError,
  securityLostFoundSecurityPostBuildingMismatchError,
  securityLostFoundTerminalError,
} from './security-lost-found.errors';
import { securityLostFoundRepository } from './security-lost-found.repository';
import type {
  CloseLostFoundInput,
  CreateSecurityLostFoundInput,
  PlaceCustodyInput,
  PublicSecurityLostFound,
  PublicSecurityLostFoundHistory,
  RegisterClaimInput,
  ReturnLostFoundInput,
  SecurityLostFoundHistoryRecord,
  SecurityLostFoundListFilters,
  SecurityLostFoundRecord,
  SecurityLostFoundStatus,
  UpdateSecurityLostFoundInput,
} from './security-lost-found.types';
import { isLostFoundTransitionAllowed as isTransitionAllowed } from './security-lost-found.types';

/**
 * BE-12L — Security Lost & Found service.
 *
 * Two surfaces:
 *   1. Master CRUD (create / get / list / patch) — the Lost & Found
 *      record's `custody_status` is the authoritative operational
 *      state and is updated in place as custody / claim / return
 *      events occur.
 *   2. Lifecycle transitions (place-in-custody / register-claim /
 *      return / close) — append-only rows on
 *      `security_lost_found_history`. Historical rows are NEVER
 *      overwritten; the master's `custody_status` is the current
 *      state.
 *
 * Validation order (pinned by tests):
 *   1. unknown Building                      → 404 BUILDING_NOT_FOUND
 *   2. inaccessible Building                 → 403 BUILDING_ACCESS_DENIED
 *   3. unknown / cross-Building Security Post → 404 / 400
 *   4. unknown / cross-Building Location     → 404 / 400
 *   5. duplicate (building, item_code)       → 409 ALREADY_EXISTS
 *   6. lifecycle: terminal state             → 400 TERMINAL
 *   7. lifecycle: invalid transition         → 400 INVALID_TRANSITION
 *   8. return without an active claim        → 400 NO_ACTIVE_CLAIM
 *   9. duplicate active claim while one is open → 409 DUPLICATE_ACTIVE_CLAIM
 */
export async function createSecurityLostFound(
  input: CreateSecurityLostFoundInput,
  userId: string,
): Promise<PublicSecurityLostFound> {
  const building = await buildingRepository.findById(input.buildingId);
  if (!building) {
    throw buildingNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, input.buildingId);

  const { clientId } = await resolveAssetBuildingContext(input.buildingId);

  if (input.securityPostId) {
    await assertSecurityPost(
      input.securityPostId,
      input.buildingId,
      clientId,
    );
  }
  if (input.functionalLocationId) {
    await assertFunctionalLocation(
      input.functionalLocationId,
      input.buildingId,
    );
  }

  const existing = await securityLostFoundRepository.findByBuildingAndItemCode(
    input.buildingId,
    input.itemCode,
  );
  if (existing) {
    throw securityLostFoundItemCodeAlreadyExistsError();
  }

  let record: SecurityLostFoundRecord;
  try {
    record = await securityLostFoundRepository.create({ ...input, clientId });
  } catch (error) {
    if (
      isUniqueViolation(
        error,
        'security_lost_found_building_code_unique',
      )
    ) {
      throw securityLostFoundItemCodeAlreadyExistsError();
    }
    throw error;
  }

  // Append the create event to the history. The CREATE event is the
  // very first history row for the record.
  await securityLostFoundRepository.insertHistory({
    lostFoundId: record.id,
    eventType: 'CREATE',
    claimantName: null,
    claimantReference: null,
    claimNotes: null,
    verifiedByUserId: null,
    returnedByUserId: null,
    returnedAt: null,
    occurredAt: record.foundAt,
    notes: null,
  });

  await recordOperationalEvent({
    clientId,
    eventType: 'SECURITY_LOST_FOUND_CREATED',
    entityType: 'SECURITY_LOST_FOUND',
    entityId: record.id,
    actorUserId: userId,
    buildingId: record.buildingId,
    summary: `Security lost & found record ${record.itemCode} created.`,
    metadata: {
      itemCode: record.itemCode,
      itemName: record.itemName,
      custodyStatus: record.custodyStatus,
    },
  });

  return toPublicSecurityLostFound(record);
}

export async function getSecurityLostFound(
  id: string,
  userId: string,
): Promise<PublicSecurityLostFound> {
  const record = await securityLostFoundRepository.findById(id);
  if (!record) {
    throw securityLostFoundNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, record.buildingId);
  return toPublicSecurityLostFound(record);
}

export async function listSecurityLostFound(
  filters: SecurityLostFoundListFilters,
  userId: string,
): Promise<PublicSecurityLostFound[]> {
  if (filters.fromDate && filters.toDate) {
    if (
      new Date(filters.fromDate).getTime() >
      new Date(filters.toDate).getTime()
    ) {
      throw securityLostFoundInvalidDateRangeError();
    }
  }

  let buildingIds: string[];

  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(
      userId,
      filters.buildingId,
    );
    buildingIds = [filters.buildingId];
  } else if (filters.securityPostId) {
    const post = await securityPostRepository.findById(filters.securityPostId);
    if (!post) {
      throw securityPostNotFoundError();
    }
    await contextAccessService.assertBuildingAccess(userId, post.buildingId);
    buildingIds = [post.buildingId];
  } else {
    buildingIds = await contextAccessService.getAccessibleBuildingIds(userId);
  }

  const records = await securityLostFoundRepository.listByBuildingIds(
    buildingIds,
    filters,
  );
  return records.map(toPublicSecurityLostFound);
}

export async function updateSecurityLostFound(
  id: string,
  input: UpdateSecurityLostFoundInput,
  userId: string,
): Promise<PublicSecurityLostFound> {
  const existing = await securityLostFoundRepository.findById(id);
  if (!existing) {
    throw securityLostFoundNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, existing.buildingId);

  if (isTerminal(existing.custodyStatus)) {
    throw securityLostFoundTerminalError();
  }

  const { clientId } = await resolveAssetBuildingContext(existing.buildingId);

  if (input.securityPostId !== undefined && input.securityPostId) {
    await assertSecurityPost(
      input.securityPostId,
      existing.buildingId,
      clientId,
    );
  }
  if (
    input.functionalLocationId !== undefined &&
    input.functionalLocationId
  ) {
    await assertFunctionalLocation(
      input.functionalLocationId,
      existing.buildingId,
    );
  }

  const updated = await securityLostFoundRepository.update(id, input);
  if (!updated) {
    throw securityLostFoundNotFoundError();
  }
  return toPublicSecurityLostFound(updated);
}

/**
 * Place an item in custody. The record must currently be in
 * `FOUND`. After this call the record's `custody_status` is
 * `IN_CUSTODY`.
 */
export async function placeInCustody(
  input: PlaceCustodyInput,
  userId: string,
): Promise<PublicSecurityLostFound> {
  const record = await securityLostFoundRepository.findById(input.lostFoundId);
  if (!record) {
    throw securityLostFoundNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, record.buildingId);

  if (isTerminal(record.custodyStatus)) {
    throw securityLostFoundTerminalError();
  }

  if (!isTransitionAllowed(record.custodyStatus, 'IN_CUSTODY')) {
    throw securityLostFoundInvalidTransitionError();
  }

  const { clientId } = await resolveAssetBuildingContext(record.buildingId);
  const now = new Date();

  await securityLostFoundRepository.insertHistory({
    lostFoundId: record.id,
    eventType: 'CUSTODY_PLACE',
    claimantName: null,
    claimantReference: null,
    claimNotes: null,
    verifiedByUserId: null,
    returnedByUserId: null,
    returnedAt: null,
    occurredAt: now,
    notes: input.notes ?? null,
  });

  const updated = await securityLostFoundRepository.updateCustodyStatus(
    record.id,
    'IN_CUSTODY',
  );
  if (!updated) {
    throw securityLostFoundNotFoundError();
  }

  await recordOperationalEvent({
    clientId,
    eventType: 'SECURITY_LOST_FOUND_PLACED_IN_CUSTODY',
    entityType: 'SECURITY_LOST_FOUND',
    entityId: record.id,
    actorUserId: userId,
    buildingId: record.buildingId,
    summary: `Security lost & found record ${record.itemCode} placed in custody.`,
    metadata: { itemCode: record.itemCode, previousStatus: record.custodyStatus },
  });

  return toPublicSecurityLostFound(updated);
}

/**
 * Register a claim on a Lost & Found record. Allowed from FOUND or
 * IN_CUSTODY. After this call the record's `custody_status` is
 * `CLAIMED`. A subsequent `RETURN` is the only way to terminate the
 * claim and move to RETURNED.
 */
export async function registerClaim(
  input: RegisterClaimInput,
  userId: string,
): Promise<PublicSecurityLostFound> {
  const record = await securityLostFoundRepository.findById(input.lostFoundId);
  if (!record) {
    throw securityLostFoundNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, record.buildingId);

  if (isTerminal(record.custodyStatus)) {
    throw securityLostFoundTerminalError();
  }

  // A claim can only be registered if there is no active claim
  // already open on this record. This check runs BEFORE the
  // transition check so a duplicate claim on a CLAIMED record
  // returns 409 DUPLICATE_ACTIVE_CLAIM (not 400 INVALID_TRANSITION).
  const activeClaim = await securityLostFoundRepository.findActiveClaim(
    record.id,
  );
  if (activeClaim) {
    throw securityLostFoundDuplicateActiveClaimError();
  }

  if (!isTransitionAllowed(record.custodyStatus, 'CLAIMED')) {
    throw securityLostFoundInvalidTransitionError();
  }

  const { clientId } = await resolveAssetBuildingContext(record.buildingId);
  const now = new Date();

  await securityLostFoundRepository.insertHistory({
    lostFoundId: record.id,
    eventType: 'CLAIM_REGISTER',
    claimantName: input.claimantName,
    claimantReference: input.claimantReference ?? null,
    claimNotes: input.claimNotes ?? null,
    verifiedByUserId: null,
    returnedByUserId: null,
    returnedAt: null,
    occurredAt: now,
    notes: input.notes ?? null,
  });

  const updated = await securityLostFoundRepository.updateCustodyStatus(
    record.id,
    'CLAIMED',
  );
  if (!updated) {
    throw securityLostFoundNotFoundError();
  }

  await recordOperationalEvent({
    clientId,
    eventType: 'SECURITY_LOST_FOUND_CLAIM_REGISTERED',
    entityType: 'SECURITY_LOST_FOUND',
    entityId: record.id,
    actorUserId: userId,
    buildingId: record.buildingId,
    summary: `Security lost & found record ${record.itemCode} claim registered.`,
    metadata: {
      itemCode: record.itemCode,
      previousStatus: record.custodyStatus,
      // Claimant PII stays on the append-only history row; do NOT
      // echo it into the operational event's free-form metadata.
      hasActiveClaim: true,
    },
  });

  return toPublicSecurityLostFound(updated);
}

/**
 * Return a Lost & Found record to the verified claimant. Allowed
 * only from `CLAIMED`. After this call the record's `custody_status`
 * is `RETURNED`.
 */
export async function returnSecurityLostFound(
  input: ReturnLostFoundInput,
  userId: string,
): Promise<PublicSecurityLostFound> {
  const record = await securityLostFoundRepository.findById(input.lostFoundId);
  if (!record) {
    throw securityLostFoundNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, record.buildingId);

  if (isTerminal(record.custodyStatus)) {
    throw securityLostFoundTerminalError();
  }

  // A return requires an active claim. This check runs BEFORE the
  // transition check so a return on a FOUND / IN_CUSTODY record
  // returns 400 NO_ACTIVE_CLAIM (not 400 RETURN_INVALID). The
  // transition check then catches the "no-op" cases.
  const activeClaim = await securityLostFoundRepository.findActiveClaim(
    record.id,
  );
  if (!activeClaim) {
    throw securityLostFoundNoActiveClaimError();
  }

  if (!isTransitionAllowed(record.custodyStatus, 'RETURNED')) {
    throw securityLostFoundReturnInvalidError();
  }

  const { clientId } = await resolveAssetBuildingContext(record.buildingId);
  const now = new Date();

  // Mark the claim as verified by the actor; the verification and
  // the return are two history events so the audit trail is
  // explicit. The verify event records who verified; the return
  // event records who handed the item over.
  await securityLostFoundRepository.insertHistory({
    lostFoundId: record.id,
    eventType: 'CLAIM_VERIFY',
    claimantName: null,
    claimantReference: null,
    claimNotes: null,
    verifiedByUserId: userId,
    returnedByUserId: null,
    returnedAt: null,
    occurredAt: now,
    notes: null,
  });

  await securityLostFoundRepository.insertHistory({
    lostFoundId: record.id,
    eventType: 'RETURN',
    claimantName: null,
    claimantReference: null,
    claimNotes: null,
    verifiedByUserId: null,
    returnedByUserId: input.returnedByUserId,
    returnedAt: now,
    occurredAt: now,
    notes: input.notes ?? null,
  });

  const updated = await securityLostFoundRepository.updateCustodyStatus(
    record.id,
    'RETURNED',
  );
  if (!updated) {
    throw securityLostFoundNotFoundError();
  }

  await recordOperationalEvent({
    clientId,
    eventType: 'SECURITY_LOST_FOUND_RETURNED',
    entityType: 'SECURITY_LOST_FOUND',
    entityId: record.id,
    actorUserId: userId,
    buildingId: record.buildingId,
    summary: `Security lost & found record ${record.itemCode} returned.`,
    metadata: {
      itemCode: record.itemCode,
      previousStatus: record.custodyStatus,
    },
  });

  return toPublicSecurityLostFound(updated);
}

/**
 * Close a Lost & Found record. Allowed from any non-terminal state.
 * After this call the record's `custody_status` is `CLOSED`.
 * CLOSED is terminal — further transitions are rejected.
 *
 * Use this when an item is unclaimed past the retention window, when
 * the item is destroyed, or when an admin finalizes the record.
 */
export async function closeSecurityLostFound(
  input: CloseLostFoundInput,
  userId: string,
): Promise<PublicSecurityLostFound> {
  const record = await securityLostFoundRepository.findById(input.lostFoundId);
  if (!record) {
    throw securityLostFoundNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, record.buildingId);

  if (isTerminal(record.custodyStatus)) {
    throw securityLostFoundTerminalError();
  }

  if (!isTransitionAllowed(record.custodyStatus, 'CLOSED')) {
    throw securityLostFoundInvalidTransitionError();
  }

  const { clientId } = await resolveAssetBuildingContext(record.buildingId);
  const now = new Date();

  // CLOSE is the unified final-state entry. The single CLOSE event
  // is sufficient for an unverified-finalization of an open claim
  // because the operational event and the custody_status both
  // record the closure explicitly.
  await securityLostFoundRepository.insertHistory({
    lostFoundId: record.id,
    eventType: 'CLOSE',
    claimantName: null,
    claimantReference: null,
    claimNotes: null,
    verifiedByUserId: null,
    returnedByUserId: null,
    returnedAt: null,
    occurredAt: now,
    notes: input.notes ?? null,
  });

  const updated = await securityLostFoundRepository.updateCustodyStatus(
    record.id,
    'CLOSED',
  );
  if (!updated) {
    throw securityLostFoundNotFoundError();
  }

  await recordOperationalEvent({
    clientId,
    eventType: 'SECURITY_LOST_FOUND_CLOSED',
    entityType: 'SECURITY_LOST_FOUND',
    entityId: record.id,
    actorUserId: userId,
    buildingId: record.buildingId,
    summary: `Security lost & found record ${record.itemCode} closed.`,
    metadata: {
      itemCode: record.itemCode,
      previousStatus: record.custodyStatus,
    },
  });

  return toPublicSecurityLostFound(updated);
}

export async function getSecurityLostFoundHistory(
  id: string,
  userId: string,
): Promise<PublicSecurityLostFoundHistory[]> {
  const record = await securityLostFoundRepository.findById(id);
  if (!record) {
    throw securityLostFoundNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, record.buildingId);
  const records = await securityLostFoundRepository.listHistory(id);
  return records.map(toPublicSecurityLostFoundHistory);
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function isTerminal(status: SecurityLostFoundStatus): boolean {
  return status === 'DISPOSED' || status === 'CLOSED';
}

async function assertSecurityPost(
  securityPostId: string,
  buildingId: string,
  clientId: string,
): Promise<void> {
  const post = await securityPostRepository.findById(securityPostId);
  if (!post) {
    throw securityPostNotFoundError();
  }
  if (post.buildingId !== buildingId || post.clientId !== clientId) {
    throw securityLostFoundSecurityPostBuildingMismatchError();
  }
}

async function assertFunctionalLocation(
  functionalLocationId: string,
  buildingId: string,
): Promise<void> {
  const location = await functionalLocationRepository.findById(
    functionalLocationId,
  );
  if (!location) {
    throw functionalLocationNotFoundError();
  }
  if (location.buildingId !== buildingId) {
    throw securityLostFoundFunctionalLocationBuildingMismatchError();
  }
}

function isUniqueViolation(
  error: unknown,
  constraint: string,
): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23505' && candidate.constraint === constraint;
}

function toPublicSecurityLostFound(
  record: SecurityLostFoundRecord,
): PublicSecurityLostFound {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    securityPostId: record.securityPostId,
    functionalLocationId: record.functionalLocationId,
    itemCode: record.itemCode,
    itemName: record.itemName,
    description: record.description,
    foundAt: record.foundAt.toISOString(),
    foundByUserId: record.foundByUserId,
    custodyStatus: record.custodyStatus,
    notes: record.notes,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function toPublicSecurityLostFoundHistory(
  record: SecurityLostFoundHistoryRecord,
): PublicSecurityLostFoundHistory {
  return {
    id: record.id,
    lostFoundId: record.lostFoundId,
    eventType: record.eventType,
    claimantName: record.claimantName,
    claimantReference: record.claimantReference,
    claimNotes: record.claimNotes,
    verifiedByUserId: record.verifiedByUserId,
    returnedByUserId: record.returnedByUserId,
    returnedAt: record.returnedAt ? record.returnedAt.toISOString() : null,
    occurredAt: record.occurredAt.toISOString(),
    notes: record.notes,
    createdAt: record.createdAt.toISOString(),
  };
}

export const securityLostFoundService = {
  closeSecurityLostFound,
  createSecurityLostFound,
  getSecurityLostFound,
  getSecurityLostFoundHistory,
  listSecurityLostFound,
  placeInCustody,
  registerClaim,
  returnSecurityLostFound,
  updateSecurityLostFound,
};
