import { AppError } from '../../shared/errors';
import {
  buildingNotFoundError,
  buildingRepository,
  type BuildingRecord,
} from '../buildings';
import { organizationRepository } from '../organizations';
import { propertyNotFoundError, propertyRepository } from '../properties';
import {
  workforceProfileInactiveError,
  workforceProfileNotFoundError,
  workforceRepository,
  type WorkforceProfileRecord,
} from '../workforce';
import {
  workforceBuildingAlreadyAssignedError,
  workforceBuildingAssignmentNotFoundError,
  workforceBuildingClientMismatchError,
  workforceBuildingInactiveError,
} from './workforce-building-assignment.errors';
import { workforceBuildingAssignmentRepository } from './workforce-building-assignment.repository';
import type {
  AssignWorkforceBuildingInput,
  NewWorkforceBuildingAssignment,
  PublicWorkforceBuildingAssignment,
  UpdateWorkforceBuildingAssignmentInput,
  WorkforceBuildingAssignmentRecord,
  WorkforceBuildingContext,
} from './workforce-building-assignment.types';

export function toPublicWorkforceBuildingAssignment(
  record: WorkforceBuildingAssignmentRecord,
): PublicWorkforceBuildingAssignment {
  return {
    id: record.id,
    workforceProfileId: record.workforceProfileId,
    buildingId: record.buildingId,
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
      'workforce_building_assignments_active_unique'
  );
}

/**
 * A Workforce Profile carries no `client_id` of its own — it is Client-scoped
 * transitively through its Organization. This is the single place that walks
 * that chain, so isolation cannot drift between operations.
 */
async function resolveWorkforce(workforceProfileId: string): Promise<{
  profile: WorkforceProfileRecord;
  clientId: string;
}> {
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

  return { profile, clientId: organization.clientId };
}

/**
 * Resolves the Client that authoritatively owns a Building.
 *
 * A Building carries no `client_id`: ownership is derived Building → Property
 * → Client (BE-02). The Building record is returned alongside so callers can
 * apply state rules without a second read.
 */
async function resolveBuilding(buildingId: string): Promise<{
  building: BuildingRecord;
  clientId: string;
}> {
  const building = await buildingRepository.findById(buildingId);
  if (!building) {
    throw buildingNotFoundError();
  }

  const property = await propertyRepository.findById(building.propertyId);
  if (!property) {
    // A Building always points at a real Property (enforced by FK), so this is
    // a data-integrity fault rather than a caller error.
    throw propertyNotFoundError();
  }

  return { building, clientId: property.clientId };
}

/**
 * Resolves and cross-validates both sides of the link.
 *
 * Order is deliberate and is what the tests pin down:
 *   1. unknown Workforce   → 404
 *   2. unknown Building    → 404
 *   3. cross-Client pair   → 400 (before any state check, so a foreign
 *                                 Building's status is never observable)
 *   4. INACTIVE Building   → 400
 *   5. INACTIVE Workforce  → 400 (only when the result would be an ACTIVE
 *                                 placement; history stays editable)
 *
 * Nothing in this path reads or writes a Role, Permission, Position, Team,
 * Shift, Skill, Supervisor, or User Building Access row.
 */
async function assertAssignable(
  workforceProfileId: string,
  buildingId: string,
  intendedStatus: 'ACTIVE' | 'INACTIVE',
): Promise<void> {
  const { profile, clientId: workforceClientId } =
    await resolveWorkforce(workforceProfileId);
  const { building, clientId: buildingClientId } =
    await resolveBuilding(buildingId);

  if (buildingClientId !== workforceClientId) {
    throw workforceBuildingClientMismatchError();
  }

  if (building.status !== 'ACTIVE') {
    throw workforceBuildingInactiveError();
  }

  if (intendedStatus === 'ACTIVE' && profile.status !== 'ACTIVE') {
    throw workforceProfileInactiveError();
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
 * Assigns a Building to a Workforce Profile.
 *
 * This records an operational placement and nothing else. It grants the
 * profile's linked User no data access whatsoever — BE-02F
 * `user_building_assignments` is a separate table written by a separate slice —
 * and it creates no Role, Permission, Position, Team, Shift, Skill, or
 * Supervisor change.
 *
 * A profile may hold several Buildings at once; only a duplicate *active*
 * placement of the same Building is rejected.
 */
export async function assignBuildingToWorkforce(
  input: AssignWorkforceBuildingInput,
): Promise<PublicWorkforceBuildingAssignment> {
  const status = input.status ?? 'ACTIVE';

  await assertAssignable(input.workforceProfileId, input.buildingId, status);

  const effectiveFrom = input.effectiveFrom ?? null;
  const effectiveUntil = input.effectiveUntil ?? null;

  assertEffectiveOrder(effectiveFrom, effectiveUntil);

  if (status === 'ACTIVE') {
    const existing =
      await workforceBuildingAssignmentRepository.findActiveByProfileAndBuilding(
        input.workforceProfileId,
        input.buildingId,
      );
    if (existing) {
      throw workforceBuildingAlreadyAssignedError();
    }
  }

  const newAssignment: NewWorkforceBuildingAssignment = {
    workforceProfileId: input.workforceProfileId,
    buildingId: input.buildingId,
    effectiveFrom,
    effectiveUntil,
    status,
  };

  try {
    const record =
      await workforceBuildingAssignmentRepository.create(newAssignment);
    return toPublicWorkforceBuildingAssignment(record);
  } catch (error) {
    if (isActiveAssignmentUniqueViolation(error)) {
      throw workforceBuildingAlreadyAssignedError();
    }
    throw error;
  }
}

/** Lists every Building assignment held by one Workforce Profile. */
export async function listWorkforceBuildings(
  workforceProfileId: string,
): Promise<PublicWorkforceBuildingAssignment[]> {
  // Resolving the profile also proves it exists — unknown ids 404 rather than
  // returning a misleading empty list.
  await resolveWorkforce(workforceProfileId);

  const records =
    await workforceBuildingAssignmentRepository.listByWorkforceProfileId(
      workforceProfileId,
    );

  return records.map(toPublicWorkforceBuildingAssignment);
}

/**
 * Lists every Workforce Profile operationally assigned to one Building.
 *
 * This is the workforce roster of a Building, not its access list: the users
 * who may *read* the Building's data come from BE-02F and are unrelated to
 * these rows.
 */
export async function listBuildingWorkforce(
  buildingId: string,
): Promise<PublicWorkforceBuildingAssignment[]> {
  // Proves the Building exists so unknown ids 404 instead of returning [].
  await resolveBuilding(buildingId);

  const records =
    await workforceBuildingAssignmentRepository.listByBuildingId(buildingId);

  return records.map(toPublicWorkforceBuildingAssignment);
}

/**
 * Reusable resolver: the Buildings a Workforce Profile is *effectively*
 * assigned to at `asOf` (default: now).
 *
 * "Effective" means the assignment is ACTIVE, its validity window covers the
 * instant, and the Building itself is still ACTIVE. Every consumer that needs
 * "where does this person work right now" must go through here rather than
 * re-implementing the rules, and must not infer placement from User Building
 * Access, Role, Position, Team, Shift, or Supervisor.
 */
export async function resolveBuildingsForWorkforce(
  workforceProfileId: string,
  asOf: Date = new Date(),
): Promise<WorkforceBuildingContext[]> {
  // Unknown profiles 404 rather than resolving to an empty placement set.
  await resolveWorkforce(workforceProfileId);

  return workforceBuildingAssignmentRepository.listEffectiveByWorkforceProfileId(
    workforceProfileId,
    asOf,
  );
}

/**
 * Updates the assignment addressed by (workforce, building).
 *
 * Deactivation is expressed as `status: 'INACTIVE'` on this same endpoint; the
 * row is retained so the placement history stays auditable.
 */
export async function updateWorkforceBuildingAssignment(
  workforceProfileId: string,
  buildingId: string,
  input: UpdateWorkforceBuildingAssignmentInput,
): Promise<PublicWorkforceBuildingAssignment> {
  const { profile, clientId: workforceClientId } =
    await resolveWorkforce(workforceProfileId);
  const { building, clientId: buildingClientId } =
    await resolveBuilding(buildingId);

  if (buildingClientId !== workforceClientId) {
    throw workforceBuildingClientMismatchError();
  }

  const existing =
    await workforceBuildingAssignmentRepository.findByProfileAndBuilding(
      workforceProfileId,
      buildingId,
    );
  if (!existing) {
    throw workforceBuildingAssignmentNotFoundError();
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

  // Re-activating requires the Building to still be assignable, the profile to
  // still be active, and no colliding live placement of the same Building.
  if (input.status === 'ACTIVE' && existing.status !== 'ACTIVE') {
    if (building.status !== 'ACTIVE') {
      throw workforceBuildingInactiveError();
    }

    if (profile.status !== 'ACTIVE') {
      throw workforceProfileInactiveError();
    }

    const active =
      await workforceBuildingAssignmentRepository.findActiveByProfileAndBuilding(
        workforceProfileId,
        buildingId,
      );
    if (active) {
      throw workforceBuildingAlreadyAssignedError();
    }
  }

  try {
    const record = await workforceBuildingAssignmentRepository.update(
      existing.id,
      input,
    );
    if (!record) {
      throw workforceBuildingAssignmentNotFoundError();
    }
    return toPublicWorkforceBuildingAssignment(record);
  } catch (error) {
    if (isActiveAssignmentUniqueViolation(error)) {
      throw workforceBuildingAlreadyAssignedError();
    }
    throw error;
  }
}

/** Convenience wrapper: deactivation is an update to `status: 'INACTIVE'`. */
export async function deactivateWorkforceBuildingAssignment(
  workforceProfileId: string,
  buildingId: string,
): Promise<PublicWorkforceBuildingAssignment> {
  return updateWorkforceBuildingAssignment(workforceProfileId, buildingId, {
    status: 'INACTIVE',
  });
}

export const workforceBuildingAssignmentService = {
  assignBuildingToWorkforce,
  deactivateWorkforceBuildingAssignment,
  listBuildingWorkforce,
  listWorkforceBuildings,
  resolveBuildingsForWorkforce,
  toPublicWorkforceBuildingAssignment,
  updateWorkforceBuildingAssignment,
};
