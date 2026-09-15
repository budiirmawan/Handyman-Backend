import { resolveAssetBuildingContext } from '../assets';
import { buildingNotFoundError, buildingRepository } from '../buildings';
import { contextAccessService } from '../context-access';
import {
  functionalLocationNotFoundError,
  functionalLocationRepository,
} from '../functional-locations';
import { organizationRepository } from '../organizations';
import { recordOperationalEvent } from '../operational-events';
import { securityPostNotFoundError, securityPostRepository } from '../security-posts';
import { workforceBuildingAssignmentRepository } from '../workforce-building-assignments';
import {
  workforceProfileNotFoundError,
  workforceRepository,
} from '../workforce';
import {
  securityKeyAlreadyIssuedError,
  securityKeyBuildingMismatchError,
  securityKeyCodeAlreadyExistsError,
  securityKeyCustodyNotFoundError,
  securityKeyFunctionalLocationBuildingMismatchError,
  securityKeyLostCannotBeIssuedError,
  securityKeyNotAvailableError,
  securityKeyNotFoundError,
  securityKeyNotIssuedError,
  securityKeyReturnInvalidError,
  securityKeySecurityPostBuildingMismatchError,
  securityKeyWorkforceBuildingMismatchError,
} from './security-key.errors';
import { securityKeyRepository } from './security-key.repository';
import type {
  CreateSecurityKeyInput,
  IssueKeyInput,
  PublicSecurityKey,
  PublicSecurityKeyCustody,
  ReturnKeyInput,
  SecurityKeyCustodyRecord,
  SecurityKeyListFilters,
  SecurityKeyRecord,
  UpdateSecurityKeyInput,
} from './security-key.types';

/**
 * BE-12K — Security Key Control service.
 *
 * Two surfaces:
 *   1. Key master CRUD (create / get / list / patch) — the Key's
 *      `status` is the authoritative operational state and is
 *      updated in place as custody transactions occur.
 *   2. Custody transactions (issue / return / mark-lost) — append-only
 *      rows on `security_key_custody`. Historical rows are NEVER
 *      overwritten; current custody is the most recent ISSUE row
 *      without a matching RETURN.
 *
 * Validation order (pinned by tests):
 *   1. unknown Building                      → 404 BUILDING_NOT_FOUND
 *   2. inaccessible Building                 → 403 BUILDING_ACCESS_DENIED
 *   3. unknown / cross-Building Security Post → 404 / 400
 *   4. unknown / cross-Building Location     → 404 / 400
 *   5. unknown / INACTIVE Workforce          → 404 / 400
 *   6. Workforce without active Building
 *      assignment for this Building          → 400
 *   7. duplicate (building, code)            → 409 ALREADY_EXISTS
 *   8. cross-Client (post / location / workforce) → 400
 *   9. issue: only AVAILABLE keys can be issued
 *      (LOST keys cannot be re-issued through the normal flow)   → 400
 *  10. issue: a Key with an open ISSUE custody row → 409 ALREADY_ISSUED
 *  11. return: a Key with NO open ISSUE custody row → 400 NOT_ISSUED
 */
export async function createSecurityKey(
  input: CreateSecurityKeyInput,
  userId: string,
): Promise<PublicSecurityKey> {
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

  const existing = await securityKeyRepository.findByBuildingAndCode(
    input.buildingId,
    input.code,
  );
  if (existing) {
    throw securityKeyCodeAlreadyExistsError();
  }

  let record: SecurityKeyRecord;
  try {
    record = await securityKeyRepository.create({ ...input, clientId });
  } catch (error) {
    if (isUniqueViolation(error, 'security_keys_building_code_unique')) {
      throw securityKeyCodeAlreadyExistsError();
    }
    throw error;
  }
  return toPublicSecurityKey(record);
}

export async function getSecurityKey(
  id: string,
  userId: string,
): Promise<PublicSecurityKey> {
  const record = await securityKeyRepository.findById(id);
  if (!record) {
    throw securityKeyNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, record.buildingId);
  return toPublicSecurityKey(record);
}

export async function listSecurityKeys(
  filters: SecurityKeyListFilters,
  userId: string,
): Promise<PublicSecurityKey[]> {
  let buildingIds: string[];

  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(userId, filters.buildingId);
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

  const records = await securityKeyRepository.listByBuildingIds(
    buildingIds,
    filters,
  );
  return records.map(toPublicSecurityKey);
}

export async function updateSecurityKey(
  id: string,
  input: UpdateSecurityKeyInput,
  userId: string,
): Promise<PublicSecurityKey> {
  const existing = await securityKeyRepository.findById(id);
  if (!existing) {
    throw securityKeyNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, existing.buildingId);

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

  const updated = await securityKeyRepository.update(id, input);
  if (!updated) {
    throw securityKeyNotFoundError();
  }
  return toPublicSecurityKey(updated);
}

/**
 * Issue a key: append an ISSUE custody row and flip the Key to
 * ISSUED. The recipient Workforce must be ACTIVE in the same Client
 * and have an active Building assignment for this Building.
 */
export async function issueSecurityKey(
  input: IssueKeyInput,
  userId: string,
): Promise<PublicSecurityKey> {
  const key = await securityKeyRepository.findById(input.keyId);
  if (!key) {
    throw securityKeyNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, key.buildingId);

  if (key.status === 'LOST') {
    throw securityKeyLostCannotBeIssuedError();
  }

  const openIssue = await securityKeyRepository.findOpenIssueForKey(key.id);
  if (openIssue) {
    throw securityKeyAlreadyIssuedError();
  }

  if (key.status !== 'AVAILABLE') {
    throw securityKeyNotAvailableError();
  }

  const { clientId } = await resolveAssetBuildingContext(key.buildingId);
  await assertWorkforceForIssue(
    input.issuedToWorkforceId,
    key.buildingId,
    clientId,
  );

  const now = new Date();
  const expectedReturnAt = input.expectedReturnAt
    ? new Date(input.expectedReturnAt)
    : null;
  if (expectedReturnAt && Number.isNaN(expectedReturnAt.getTime())) {
    throw securityKeyNotAvailableError();
  }

  const custodyRow = await securityKeyRepository.insertCustody({
    keyId: key.id,
    transactionType: 'ISSUE',
    issuedToWorkforceId: input.issuedToWorkforceId,
    issuedByUserId: userId,
    issuedAt: now,
    expectedReturnAt,
    returnedAt: null,
    returnedToUserId: null,
    notes: input.notes ?? null,
  });

  const updated = await securityKeyRepository.update(key.id, {
    status: 'ISSUED',
  });
  if (!updated) {
    throw securityKeyNotFoundError();
  }

  await recordOperationalEvent({
    clientId,
    eventType: 'SECURITY_KEY_ISSUED',
    entityType: 'SECURITY_KEY_CUSTODY',
    entityId: custodyRow.id,
    actorUserId: userId,
    buildingId: key.buildingId,
    summary: `Security key ${key.code} issued.`,
    metadata: {
      keyId: key.id,
      issuedToWorkforceId: input.issuedToWorkforceId,
      expectedReturnAt: input.expectedReturnAt ?? null,
    },
  });

  return toPublicSecurityKey(updated);
}

/**
 * Return a key: append a RETURN custody row that closes the most
 * recent open ISSUE, and flip the Key to AVAILABLE. If the key was
 * past its `expected_return_at`, the service sets status to OVERDUE
 * on the return event's metadata and the post-return key status
 * remains AVAILABLE; the OVERDUE flag is recorded for audit but
 * does not block the return.
 */
export async function returnSecurityKey(
  input: ReturnKeyInput,
  userId: string,
): Promise<PublicSecurityKey> {
  const key = await securityKeyRepository.findById(input.keyId);
  if (!key) {
    throw securityKeyNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, key.buildingId);

  if (key.status === 'INACTIVE' || key.status === 'LOST') {
    throw securityKeyNotIssuedError();
  }
  if (key.status !== 'ISSUED') {
    throw securityKeyNotIssuedError();
  }

  const openIssue = await securityKeyRepository.findOpenIssueForKey(key.id);
  if (!openIssue) {
    throw securityKeyNotIssuedError();
  }

  const { clientId } = await resolveAssetBuildingContext(key.buildingId);
  const now = new Date();
  const isOverdue =
    openIssue.expectedReturnAt !== null &&
    openIssue.expectedReturnAt.getTime() < now.getTime();

  // Close the open ISSUE row with the return timestamp and the
  // receiving user. The historical columns of the ISSUE row
  // (issued_to, issued_by, issued_at, expected_return_at) are NEVER
  // modified — only the return-side fields are added. The RETURN
  // custody row below is the new "return event" record for the
  // history.
  await securityKeyRepository.closeIssueCustody(
    openIssue.id,
    now,
    input.returnedToUserId,
  );

  await securityKeyRepository.insertCustody({
    keyId: key.id,
    transactionType: 'RETURN',
    issuedToWorkforceId: null,
    issuedByUserId: null,
    issuedAt: null,
    expectedReturnAt: null,
    returnedAt: now,
    returnedToUserId: input.returnedToUserId,
    notes: input.notes ?? null,
  });

  const updated = await securityKeyRepository.update(key.id, {
    status: 'AVAILABLE',
  });
  if (!updated) {
    throw securityKeyNotFoundError();
  }

  await recordOperationalEvent({
    clientId,
    eventType: isOverdue
      ? 'SECURITY_KEY_RETURNED_OVERDUE'
      : 'SECURITY_KEY_RETURNED',
    entityType: 'SECURITY_KEY_CUSTODY',
    entityId: key.id,
    actorUserId: userId,
    buildingId: key.buildingId,
    summary: isOverdue
      ? `Security key ${key.code} returned (overdue).`
      : `Security key ${key.code} returned.`,
    metadata: {
      keyId: key.id,
      originalIssueId: openIssue.id,
      returnedToUserId: input.returnedToUserId,
      overdue: isOverdue,
    },
  });

  return toPublicSecurityKey(updated);
}

/**
 * Mark a key as LOST: append a MARK_LOST custody row and flip the
 * Key to LOST. A LOST key cannot be re-issued through the normal
 * flow.
 */
export async function markKeyLost(
  id: string,
  userId: string,
  notes: string | null,
): Promise<PublicSecurityKey> {
  const key = await securityKeyRepository.findById(id);
  if (!key) {
    throw securityKeyNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, key.buildingId);

  const { clientId } = await resolveAssetBuildingContext(key.buildingId);

  await securityKeyRepository.insertCustody({
    keyId: key.id,
    transactionType: 'MARK_LOST',
    issuedToWorkforceId: null,
    issuedByUserId: null,
    issuedAt: null,
    expectedReturnAt: null,
    returnedAt: null,
    returnedToUserId: null,
    notes,
  });

  const updated = await securityKeyRepository.update(id, {
    status: 'LOST',
  });
  if (!updated) {
    throw securityKeyNotFoundError();
  }

  await recordOperationalEvent({
    clientId,
    eventType: 'SECURITY_KEY_MARKED_LOST',
    entityType: 'SECURITY_KEY',
    entityId: id,
    actorUserId: userId,
    buildingId: key.buildingId,
    summary: `Security key ${key.code} marked lost.`,
    metadata: { keyId: id, notes },
  });

  return toPublicSecurityKey(updated);
}

export async function getCurrentCustody(
  keyId: string,
  userId: string,
): Promise<PublicSecurityKeyCustody | null> {
  const key = await securityKeyRepository.findById(keyId);
  if (!key) {
    throw securityKeyNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, key.buildingId);
  const openIssue = await securityKeyRepository.findOpenIssueForKey(keyId);
  return openIssue ? toPublicSecurityKeyCustody(openIssue) : null;
}

export async function getCustodyHistory(
  keyId: string,
  userId: string,
): Promise<PublicSecurityKeyCustody[]> {
  const key = await securityKeyRepository.findById(keyId);
  if (!key) {
    throw securityKeyNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, key.buildingId);
  const records = await securityKeyRepository.listCustodyHistory(keyId);
  return records.map(toPublicSecurityKeyCustody);
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

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
    throw securityKeySecurityPostBuildingMismatchError();
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
    throw securityKeyFunctionalLocationBuildingMismatchError();
  }
}

async function assertWorkforceForIssue(
  workforceProfileId: string,
  buildingId: string,
  clientId: string,
): Promise<void> {
  const profile = await workforceRepository.findById(workforceProfileId);
  if (!profile) {
    throw workforceProfileNotFoundError();
  }
  if (profile.status !== 'ACTIVE') {
    throw securityKeyWorkforceBuildingMismatchError();
  }
  const organization = await organizationRepository.findById(
    profile.organizationId,
  );
  if (!organization) {
    throw workforceProfileNotFoundError();
  }
  if (organization.clientId !== clientId) {
    throw securityKeyWorkforceBuildingMismatchError();
  }
  const assignment =
    await workforceBuildingAssignmentRepository.findActiveByProfileAndBuilding(
      workforceProfileId,
      buildingId,
    );
  if (!assignment) {
    throw securityKeyWorkforceBuildingMismatchError();
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

function toPublicSecurityKey(
  record: SecurityKeyRecord,
): PublicSecurityKey {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    code: record.code,
    name: record.name,
    description: record.description,
    securityPostId: record.securityPostId,
    functionalLocationId: record.functionalLocationId,
    status: record.status,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function toPublicSecurityKeyCustody(
  record: SecurityKeyCustodyRecord,
): PublicSecurityKeyCustody {
  return {
    id: record.id,
    keyId: record.keyId,
    transactionType: record.transactionType,
    issuedToWorkforceId: record.issuedToWorkforceId,
    issuedByUserId: record.issuedByUserId,
    issuedAt: record.issuedAt ? record.issuedAt.toISOString() : null,
    expectedReturnAt: record.expectedReturnAt
      ? record.expectedReturnAt.toISOString()
      : null,
    returnedAt: record.returnedAt ? record.returnedAt.toISOString() : null,
    returnedToUserId: record.returnedToUserId,
    notes: record.notes,
    createdAt: record.createdAt.toISOString(),
  };
}

// `securityKeyReturnInvalidError` and `securityKeyCustodyNotFoundError`
// are reserved for future endpoints (e.g. an explicit "return by
// custody id" flow). They are intentionally not thrown by the
// current service so the API surface stays minimal.
void securityKeyReturnInvalidError;
void securityKeyCustodyNotFoundError;

export const securityKeyService = {
  createSecurityKey,
  getCustodyHistory,
  getCurrentCustody,
  getSecurityKey,
  issueSecurityKey,
  listSecurityKeys,
  markKeyLost,
  returnSecurityKey,
  updateSecurityKey,
};
