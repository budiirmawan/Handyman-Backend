import { contextAccessService, getAccessibleBuildingIds } from '../context-access';
import {
  correctiveActionNotFoundError,
  correctiveActionRepository,
  type CorrectiveActionCompositeRecord,
} from '../corrective-actions';
import { incidentNotFoundError, incidentRepository } from '../incidents';
import { recordOperationalEvent } from '../operational-events';
import { permissionService } from '../permissions';
import {
  correctiveActionNotReviewableError,
  correctiveActionVerificationAlreadyOpenError,
  correctiveActionVerificationImmutableError,
  correctiveActionVerificationNotFoundError,
  correctiveActionVerificationReviewerMismatchError,
  correctiveActionVerificationSelfReviewError,
} from './corrective-action-verification.errors';
import { correctiveActionVerificationRepository } from './corrective-action-verification.repository';
import {
  isVerifiableCorrectiveActionStatus,
  VERIFICATION_DECISION_OUTCOMES,
  type CorrectiveActionVerificationContext,
  type CorrectiveActionVerificationFilters,
  type CorrectiveActionVerificationRecord,
  type OpenCorrectiveActionVerificationInput,
  type PublicCorrectiveActionVerification,
  type SubmitCorrectiveActionVerificationInput,
} from './corrective-action-verification.types';

/**
 * BE-21J — Corrective Action Verification service.
 *
 * REUSE, NOT A NEW ENGINE
 * -----------------------
 * Verification records are rows in the shared BE-07 `reviews` table, and the
 * decision vocabulary is the shared `ReviewDecision`. This service is the
 * binding between BE-21G Corrective Actions and that primitive; it introduces
 * no storage and no parallel decision model. Structurally it mirrors BE-09F's
 * finding-review service, which does the same job for Findings.
 *
 * WHAT THIS PART GUARANTEES
 * -------------------------
 *   - Only a genuinely reviewable context can be verified (COMPLETED action,
 *     under a REPORTED Incident).
 *   - The reviewer must be authorized: permission, Building access, assigned
 *     to the open verification, and NOT the person who completed the work.
 *   - A recorded decision is final — enforced by a status-guarded UPDATE in
 *     the database, not merely by a service check.
 *   - The backend owns the resulting lifecycle move; the client never asserts
 *     the status directly.
 *
 * Closure (BE-21K) is NOT implemented: VERIFIED is terminal in this PART.
 */

export function toPublicVerification(
  record: CorrectiveActionVerificationRecord,
): PublicCorrectiveActionVerification {
  return {
    ...record,
    reviewedAt: record.reviewedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * Loads the Corrective Action and asserts Building access.
 *
 * Order is pinned by tests and consistent with every other BE-21 PART:
 * unknown action 404 → inaccessible Building 403. Isolation is inherited from
 * BE-21A through the Incident, never re-derived here.
 */
async function resolveAction(
  correctiveActionId: string,
  actorUserId: string,
): Promise<CorrectiveActionCompositeRecord> {
  const record = await correctiveActionRepository.findById(correctiveActionId);
  if (!record) throw correctiveActionNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, record.buildingId);
  return record;
}

/**
 * Why this action cannot currently be verified.
 *
 * Returned as data rather than thrown, so the context endpoint can EXPLAIN
 * the situation while the write endpoints refuse it. Both read from this one
 * function, so an explanation can never contradict an enforcement.
 */
function resolveBlockers(record: CorrectiveActionCompositeRecord): string[] {
  const blockers: string[] = [];
  if (record.incidentStatus !== 'REPORTED') {
    blockers.push('A CANCELLED Incident freezes its corrective actions.');
  }
  if (!isVerifiableCorrectiveActionStatus(record.status)) {
    blockers.push(
      record.status === 'VERIFIED'
        ? 'This Corrective Action has already been verified.'
        : `A Corrective Action in state ${record.status} cannot be verified; it must be COMPLETED first.`,
    );
  }
  return blockers;
}

/**
 * Finality takes precedence over every other refusal.
 *
 * Once an APPROVED decision is on record the remedy is confirmed, and any
 * further verification write is an attempt to overwrite that decision. Such
 * an attempt is reported as a CONFLICT (409) rather than as a generic
 * "not in a reviewable state" (400): both refuse the write, but only the
 * former tells the caller WHY — that a final decision already exists. This
 * check runs before `resolveBlockers` precisely so the vaguer message can
 * never mask it.
 */
async function assertNotFinalized(correctiveActionId: string): Promise<void> {
  const history = await correctiveActionVerificationRepository
    .listByCorrectiveActionId(correctiveActionId);
  if (
    history.some(
      (row) => row.status === 'COMPLETED' && row.decision === 'APPROVED',
    )
  ) {
    throw correctiveActionVerificationImmutableError(
      'This Corrective Action has already been verified; the decision is final.',
    );
  }
}

async function recordHistory(
  record: CorrectiveActionCompositeRecord,
  eventType: string,
  actorUserId: string,
  summary: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await recordOperationalEvent({
    clientId: record.clientId,
    buildingId: record.buildingId,
    entityType: 'CORRECTIVE_ACTION',
    entityId: record.id,
    eventType,
    actorUserId,
    summary,
    metadata: { incidentId: record.incidentId, ...metadata },
  });
}

/**
 * The verification context — the backend's authoritative answer to "can this
 * be verified, by whom, and what has already been decided?".
 */
export async function getVerificationContext(
  correctiveActionId: string,
  actorUserId: string,
): Promise<CorrectiveActionVerificationContext> {
  const record = await resolveAction(correctiveActionId, actorUserId);
  const history = await correctiveActionVerificationRepository
    .listByCorrectiveActionId(record.id);

  const pending = history.find((row) => row.status === 'PENDING') ?? null;
  const completed = [...history]
    .reverse()
    .find((row) => row.status === 'COMPLETED') ?? null;
  const blockers = resolveBlockers(record);

  return {
    correctiveActionId: record.id,
    incidentId: record.incidentId,
    clientId: record.clientId,
    buildingId: record.buildingId,
    correctiveActionStatus: record.status,
    verifiable: blockers.length === 0,
    blockers,
    currentVerification: pending ? toPublicVerification(pending) : null,
    latestVerification: completed ? toPublicVerification(completed) : null,
    // An APPROVED decision is the final word: the remedy is confirmed.
    finalized: history.some(
      (row) => row.status === 'COMPLETED' && row.decision === 'APPROVED',
    ),
  };
}

/**
 * Opens a verification against a COMPLETED Corrective Action.
 *
 * The reviewer is the authenticated actor: verification is claimed, not
 * assigned to someone else, so nobody can be made accountable for a decision
 * they did not take.
 */
export async function openVerification(
  input: OpenCorrectiveActionVerificationInput,
): Promise<PublicCorrectiveActionVerification> {
  const record = await resolveAction(
    input.correctiveActionId,
    input.reviewerUserId,
  );

  await assertNotFinalized(record.id);

  const blockers = resolveBlockers(record);
  if (blockers.length > 0) {
    throw correctiveActionNotReviewableError(blockers[0]);
  }

  // Independence: the person who completed the work cannot verify it.
  if (record.completedByUserId === input.reviewerUserId) {
    throw correctiveActionVerificationSelfReviewError();
  }

  const existing = await correctiveActionVerificationRepository
    .findPendingByCorrectiveActionId(record.id);
  if (existing) throw correctiveActionVerificationAlreadyOpenError();

  try {
    const created = await correctiveActionVerificationRepository.createPending({
      clientId: record.clientId,
      correctiveActionId: record.id,
      reviewerUserId: input.reviewerUserId,
      notes: input.notes?.trim() || null,
    });

    await recordHistory(
      record,
      'CORRECTIVE_ACTION_VERIFICATION_OPENED',
      input.reviewerUserId,
      `Verification opened for corrective action ${record.actionType}`,
      { verificationId: created.id, reviewerUserId: input.reviewerUserId },
    );
    return toPublicVerification(created);
  } catch (error) {
    // The partial unique index is what actually wins a concurrent open.
    if (isPendingUniqueViolation(error)) {
      throw correctiveActionVerificationAlreadyOpenError();
    }
    throw error;
  }
}

/**
 * Submits the verification decision and applies its lifecycle outcome.
 *
 * FINALITY. Three independent layers protect a recorded decision:
 *   1. `finalized` — once APPROVED, no further verification may be opened or
 *      submitted at all.
 *   2. The service refuses when no PENDING verification exists, reporting
 *      "immutable" (409) rather than "not found" when one was already decided.
 *   3. The repository's `WHERE status = 'PENDING'` guard means a racing
 *      second submission updates NO row and is rejected — the database, not
 *      application ordering, is the guarantee.
 */
export async function submitVerification(
  input: SubmitCorrectiveActionVerificationInput,
  actorUserId: string,
): Promise<{
  verification: PublicCorrectiveActionVerification;
  correctiveActionStatus: string;
}> {
  const record = await resolveAction(input.correctiveActionId, actorUserId);

  await assertNotFinalized(record.id);

  const blockers = resolveBlockers(record);
  if (blockers.length > 0) {
    throw correctiveActionNotReviewableError(blockers[0]);
  }

  const pending = await correctiveActionVerificationRepository
    .findPendingByCorrectiveActionId(record.id);

  if (!pending) {
    const history = await correctiveActionVerificationRepository
      .listByCorrectiveActionId(record.id);
    // Distinguish "already decided" from "never opened": overwriting a
    // recorded decision is a conflict, not a missing resource.
    if (history.some((row) => row.status === 'COMPLETED')) {
      throw correctiveActionVerificationImmutableError();
    }
    throw correctiveActionVerificationNotFoundError();
  }

  if (pending.reviewerUserId !== actorUserId) {
    throw correctiveActionVerificationReviewerMismatchError();
  }
  // Re-checked at submission: the completer could have changed since the
  // verification was opened.
  if (record.completedByUserId === actorUserId) {
    throw correctiveActionVerificationSelfReviewError();
  }

  const completed = await correctiveActionVerificationRepository.complete(
    pending.id,
    input.decision,
    input.notes?.trim() || pending.notes,
  );
  // Lost the race to a concurrent submission; the recorded decision stands.
  if (!completed) throw correctiveActionVerificationImmutableError();

  await recordHistory(
    record,
    'CORRECTIVE_ACTION_VERIFICATION_SUBMITTED',
    actorUserId,
    `Verification decision ${input.decision} recorded for corrective action ${record.actionType}`,
    {
      verificationId: completed.id,
      decision: input.decision,
      reviewerUserId: actorUserId,
    },
  );

  // The BACKEND applies the lifecycle outcome, derived from one map — the
  // client never asserts the resulting status.
  const outcome = VERIFICATION_DECISION_OUTCOMES[input.decision];
  let status: string = record.status;

  if (outcome === 'VERIFIED') {
    const moved = await correctiveActionRepository.markVerified(
      record.id,
      record.status,
      actorUserId,
    );
    if (!moved) throw correctiveActionVerificationImmutableError();
    status = 'VERIFIED';
    await recordHistory(
      record,
      'CORRECTIVE_ACTION_VERIFIED',
      actorUserId,
      `Corrective action ${record.actionType} verified`,
      { verificationId: completed.id },
    );
  } else if (outcome === 'IN_PROGRESS') {
    const moved = await correctiveActionRepository.returnToProgress(
      record.id,
      record.status,
    );
    if (!moved) throw correctiveActionVerificationImmutableError();
    status = 'IN_PROGRESS';
    await recordHistory(
      record,
      'CORRECTIVE_ACTION_REWORK_REQUIRED',
      actorUserId,
      `Corrective action ${record.actionType} returned for rework`,
      { verificationId: completed.id },
    );
  }

  return {
    verification: toPublicVerification(completed),
    correctiveActionStatus: status,
  };
}

/** The authoritative result: the most recent COMPLETED verification. */
export async function getLatestVerification(
  correctiveActionId: string,
  actorUserId: string,
): Promise<PublicCorrectiveActionVerification | null> {
  const record = await resolveAction(correctiveActionId, actorUserId);
  const history = await correctiveActionVerificationRepository
    .listByCorrectiveActionId(record.id);
  const latest = [...history]
    .reverse()
    .find((row) => row.status === 'COMPLETED') ?? null;
  return latest ? toPublicVerification(latest) : null;
}

/** Full history, oldest first — every attempt is preserved, none replaced. */
export async function listVerificationHistory(
  correctiveActionId: string,
  actorUserId: string,
): Promise<PublicCorrectiveActionVerification[]> {
  const record = await resolveAction(correctiveActionId, actorUserId);
  const history = await correctiveActionVerificationRepository
    .listByCorrectiveActionId(record.id);
  return history.map(toPublicVerification);
}

export async function listVerifications(
  filters: CorrectiveActionVerificationFilters,
  actorUserId: string,
): Promise<PublicCorrectiveActionVerification[]> {
  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(
      actorUserId,
      filters.buildingId,
    );
  }
  // Filtering by Incident asserts access to THAT Incident's Building, so an
  // unauthorized caller gets 403 rather than a silently empty list.
  if (filters.incidentId) {
    const incident = await incidentRepository.findById(filters.incidentId);
    if (!incident) throw incidentNotFoundError();
    await contextAccessService.assertBuildingAccess(
      actorUserId,
      incident.buildingId,
    );
  }
  const buildingIds = await getAccessibleBuildingIds(actorUserId);
  const records = await correctiveActionVerificationRepository.list(
    filters,
    buildingIds,
  );
  return records.map(toPublicVerification);
}

/** Whether the actor holds the permission needed to decide a verification. */
export async function canVerify(actorUserId: string): Promise<boolean> {
  const permissions = new Set(
    await permissionService.resolvePermissionsForUser(actorUserId),
  );
  return permissions.has('corrective_action_verification.manage');
}

function isPendingUniqueViolation(error: unknown): boolean {
  const value = error as { code?: string; constraint?: string } | null;
  return (
    value?.code === '23505' &&
    value.constraint === 'corrective_action_pending_review_unique'
  );
}

export const correctiveActionVerificationService = {
  canVerify,
  getLatestVerification,
  getVerificationContext,
  listVerificationHistory,
  listVerifications,
  openVerification,
  submitVerification,
  toPublicVerification,
};
