import { AppError } from '../../shared/errors';
import { organizationRepository } from '../organizations';
import {
  securityPostBuildingMismatchError,
  securityPostInactiveError,
  securityPostNotFoundError,
  securityPostRepository,
} from '../security-posts';
import {
  shiftInactiveError,
  shiftNotFoundError,
  shiftRepository,
} from '../shifts';
import {
  workforceProfileNotFoundError,
  workforceRepository,
} from '../workforce';
import {
  workforceShiftAlreadyAssignedError,
  workforceShiftAssignmentNotFoundError,
  workforceShiftClientMismatchError,
} from './workforce-shift.errors';
import { workforceShiftRepository } from './workforce-shift.repository';
import type {
  AssignWorkforceShiftInput,
  AssignWorkforceShiftPostInput,
  NewWorkforceShiftAssignment,
  PublicWorkforceShiftAssignment,
  UpdateWorkforceShiftAssignmentInput,
  WorkforceShiftAssignmentRecord,
} from './workforce-shift.types';

export function toPublicWorkforceShiftAssignment(
  record: WorkforceShiftAssignmentRecord,
): PublicWorkforceShiftAssignment {
  return {
    id: record.id,
    workforceProfileId: record.workforceProfileId,
    shiftId: record.shiftId,
    securityPostId: record.securityPostId,
    effectiveFrom: record.effectiveFrom,
    effectiveUntil: record.effectiveUntil,
    status: record.status,
  };
}

/**
 * PostgreSQL unique-violation on the partial ACTIVE index — the race-condition
 * backstop behind the explicit duplicate pre-check.
 */
function isActiveAssignmentUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505' &&
    'constraint' in error &&
    (error as { constraint?: unknown }).constraint ===
      'workforce_shift_assignments_active_unique'
  );
}

/**
 * A Workforce Profile carries no `client_id` of its own — it is Client-scoped
 * transitively through its Organization. This is the single place that walks
 * that chain, so isolation cannot drift between operations.
 */
async function resolveWorkforceClientId(
  workforceProfileId: string,
): Promise<string> {
  const profile = await workforceRepository.findById(workforceProfileId);
  if (!profile) {
    throw workforceProfileNotFoundError();
  }

  const organization = await organizationRepository.findById(
    profile.organizationId,
  );
  if (!organization) {
    // A profile always points at a real organization (enforced by FK), so this
    // is a data-integrity fault rather than a caller error.
    throw workforceProfileNotFoundError();
  }

  return organization.clientId;
}

/**
 * Resolves and cross-validates both sides of the link.
 *
 * Order is deliberate and is what the tests pin down:
 *   1. unknown Workforce  → 404
 *   2. unknown Shift      → 404
 *   3. cross-Client pair  → 400 (before any state check, so a foreign Shift's
 *                                status is never observable)
 *   4. INACTIVE Shift     → 400
 *
 * The Shift's own `client_id` is the comparison key: it was itself validated
 * against Building → Property → Client when the Shift was created, so this
 * single comparison enforces the whole chain.
 */
async function assertAssignable(
  workforceProfileId: string,
  shiftId: string,
): Promise<void> {
  const workforceClientId = await resolveWorkforceClientId(workforceProfileId);

  const shift = await shiftRepository.findById(shiftId);
  if (!shift) {
    throw shiftNotFoundError();
  }

  if (shift.clientId !== workforceClientId) {
    throw workforceShiftClientMismatchError();
  }

  if (shift.status !== 'ACTIVE') {
    throw shiftInactiveError();
  }
}

function assertEffectiveOrder(
  effectiveFrom: Date | null,
  effectiveUntil: Date | null,
): void {
  if (
    effectiveFrom !== null &&
    effectiveUntil !== null &&
    effectiveUntil < effectiveFrom
  ) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'effectiveUntil',
        message: 'effectiveUntil must be the same as or after effectiveFrom.',
      },
    ]);
  }
}

/**
 * Assigns a Shift to a Workforce Profile.
 *
 * This records a rostering link and nothing else: no Role, Permission,
 * Position, Team, Skill, or Building Assignment is read or written anywhere in
 * this path, and no attendance, timesheet, or schedule is generated.
 */
export async function assignShiftToWorkforce(
  input: AssignWorkforceShiftInput,
): Promise<PublicWorkforceShiftAssignment> {
  await assertAssignable(input.workforceProfileId, input.shiftId);

  const status = input.status ?? 'ACTIVE';
  const effectiveFrom = input.effectiveFrom ?? null;
  const effectiveUntil = input.effectiveUntil ?? null;

  assertEffectiveOrder(effectiveFrom, effectiveUntil);

  if (status === 'ACTIVE') {
    const existing = await workforceShiftRepository.findActiveByProfileAndShift(
      input.workforceProfileId,
      input.shiftId,
    );
    if (existing) {
      throw workforceShiftAlreadyAssignedError();
    }
  }

  const newAssignment: NewWorkforceShiftAssignment = {
    workforceProfileId: input.workforceProfileId,
    shiftId: input.shiftId,
    effectiveFrom,
    effectiveUntil,
    status,
  };

  try {
    const record = await workforceShiftRepository.create(newAssignment);
    return toPublicWorkforceShiftAssignment(record);
  } catch (error) {
    if (isActiveAssignmentUniqueViolation(error)) {
      throw workforceShiftAlreadyAssignedError();
    }
    throw error;
  }
}

/** Lists every Shift assignment held by one Workforce Profile. */
export async function listWorkforceShifts(
  workforceProfileId: string,
): Promise<PublicWorkforceShiftAssignment[]> {
  // Resolving the Client also proves the profile exists — unknown ids 404
  // rather than returning a misleading empty list.
  await resolveWorkforceClientId(workforceProfileId);

  const records =
    await workforceShiftRepository.listByWorkforceProfileId(workforceProfileId);

  return records.map(toPublicWorkforceShiftAssignment);
}

/**
 * Updates the assignment addressed by (workforce, shift).
 *
 * Deactivation is expressed as `status: 'INACTIVE'` on this same endpoint; the
 * row is retained so the rostering history stays auditable.
 */
export async function updateWorkforceShiftAssignment(
  workforceProfileId: string,
  shiftId: string,
  input: UpdateWorkforceShiftAssignmentInput,
): Promise<PublicWorkforceShiftAssignment> {
  const workforceClientId = await resolveWorkforceClientId(workforceProfileId);

  const shift = await shiftRepository.findById(shiftId);
  if (!shift) {
    throw shiftNotFoundError();
  }
  if (shift.clientId !== workforceClientId) {
    throw workforceShiftClientMismatchError();
  }

  const existing = await workforceShiftRepository.findByProfileAndShift(
    workforceProfileId,
    shiftId,
  );
  if (!existing) {
    throw workforceShiftAssignmentNotFoundError();
  }

  // Merge against the stored record so a partial update cannot produce an
  // invalid window (e.g. moving only effectiveUntil behind the stored
  // effectiveFrom).
  const effectiveFrom =
    input.effectiveFrom === undefined
      ? existing.effectiveFrom
      : input.effectiveFrom;
  const effectiveUntil =
    input.effectiveUntil === undefined
      ? existing.effectiveUntil
      : input.effectiveUntil;

  assertEffectiveOrder(effectiveFrom, effectiveUntil);

  // Re-activating requires the Shift to still be assignable and must not
  // collide with another live assignment of the same Shift.
  if (input.status === 'ACTIVE' && existing.status !== 'ACTIVE') {
    if (shift.status !== 'ACTIVE') {
      throw shiftInactiveError();
    }

    const active = await workforceShiftRepository.findActiveByProfileAndShift(
      workforceProfileId,
      shiftId,
    );
    if (active) {
      throw workforceShiftAlreadyAssignedError();
    }
  }

  try {
    const record = await workforceShiftRepository.update(existing.id, input);
    if (!record) {
      throw workforceShiftAssignmentNotFoundError();
    }
    return toPublicWorkforceShiftAssignment(record);
  } catch (error) {
    if (isActiveAssignmentUniqueViolation(error)) {
      throw workforceShiftAlreadyAssignedError();
    }
    throw error;
  }
}

/** Convenience wrapper: deactivation is an update to `status: 'INACTIVE'`. */
export async function deactivateWorkforceShiftAssignment(
  workforceProfileId: string,
  shiftId: string,
): Promise<PublicWorkforceShiftAssignment> {
  return updateWorkforceShiftAssignment(workforceProfileId, shiftId, {
    status: 'INACTIVE',
  });
}

/**
 * MOB-C03 PART 03A — assign or clear the Security Post on an existing
 * workforce shift assignment (persistence/service layer only; not exposed on
 * any HTTP or mobile read model in this PART).
 *
 * Authority chain:
 *   workforce_shift_assignments → shifts.building_id
 *   security_posts.building_id
 * A non-null post is accepted only when it exists, is ACTIVE, and its Building
 * is the SAME Building as the rostered Shift. `securityPostId: null` clears
 * the binding without touching the post, the shift, the roster row, or any
 * attendance/patrol/handover data. The same-Building rule cannot be expressed
 * by the FK alone (see migration 0337), so it is enforced here on write.
 */
export async function assignSecurityPostToWorkforceShift(
  input: AssignWorkforceShiftPostInput,
): Promise<PublicWorkforceShiftAssignment> {
  const assignment = await workforceShiftRepository.findById(
    input.workforceShiftAssignmentId,
  );
  if (!assignment) {
    throw workforceShiftAssignmentNotFoundError();
  }

  // Clearing: null is always permitted (it only nulls the binding).
  if (input.securityPostId === null) {
    const cleared = await workforceShiftRepository.updateSecurityPost(
      assignment.id,
      null,
    );
    if (!cleared) {
      throw workforceShiftAssignmentNotFoundError();
    }
    return toPublicWorkforceShiftAssignment(cleared);
  }

  const shift = await shiftRepository.findById(assignment.shiftId);
  if (!shift) {
    throw shiftNotFoundError();
  }

  const post = await securityPostRepository.findById(input.securityPostId);
  if (!post) {
    throw securityPostNotFoundError();
  }
  if (post.status !== 'ACTIVE') {
    throw securityPostInactiveError();
  }
  if (post.buildingId !== shift.buildingId) {
    throw securityPostBuildingMismatchError();
  }

  try {
    const updated = await workforceShiftRepository.updateSecurityPost(
      assignment.id,
      post.id,
    );
    if (!updated) {
      throw workforceShiftAssignmentNotFoundError();
    }
    return toPublicWorkforceShiftAssignment(updated);
  } catch (error) {
    // FK race backstop: a post deleted between the check and the write is a
    // referential failure, surfaced as the governed not-found error.
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === '23503'
    ) {
      throw securityPostNotFoundError();
    }
    throw error;
  }
}

export const workforceShiftService = {
  assignSecurityPostToWorkforceShift,
  assignShiftToWorkforce,
  deactivateWorkforceShiftAssignment,
  listWorkforceShifts,
  toPublicWorkforceShiftAssignment,
  updateWorkforceShiftAssignment,
};
