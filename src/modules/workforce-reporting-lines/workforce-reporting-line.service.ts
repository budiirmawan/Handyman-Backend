import { AppError } from '../../shared/errors';
import { organizationRepository } from '../organizations';
import {
  workforceProfileInactiveError,
  workforceProfileNotFoundError,
  workforceRepository,
} from '../workforce';
import type { WorkforceProfileRecord } from '../workforce';
import {
  workforceReportingLineAlreadyExistsError,
  workforceReportingLineCircularError,
  workforceReportingLineClientMismatchError,
  workforceReportingLineNotFoundError,
  workforceReportingLineSelfSupervisionError,
  workforceSupervisorInactiveError,
  workforceSupervisorNotFoundError,
} from './workforce-reporting-line.errors';
import { workforceReportingLineRepository } from './workforce-reporting-line.repository';
import type {
  AssignSupervisorInput,
  CurrentSupervisor,
  DirectReport,
  NewWorkforceReportingLine,
  PublicWorkforceReportingLine,
  UpdateWorkforceReportingLineInput,
  WorkforceReportingLineRecord,
} from './workforce-reporting-line.types';

export function toPublicWorkforceReportingLine(
  record: WorkforceReportingLineRecord,
): PublicWorkforceReportingLine {
  return {
    id: record.id,
    workforceProfileId: record.workforceProfileId,
    supervisorWorkforceProfileId: record.supervisorWorkforceProfileId,
    effectiveFrom: record.effectiveFrom,
    effectiveUntil: record.effectiveUntil,
    status: record.status,
  };
}

/**
 * PostgreSQL unique-violation on the partial ACTIVE index — the race-condition
 * backstop behind the explicit duplicate pre-check.
 */
function isActiveReportingLineUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505' &&
    'constraint' in error &&
    (error as { constraint?: unknown }).constraint ===
      'workforce_reporting_lines_active_unique'
  );
}

type ResolvedProfile = {
  profile: WorkforceProfileRecord;
  clientId: string;
};

/**
 * A Workforce Profile carries no `client_id` of its own — it is Client-scoped
 * transitively through its Organization. This is the single place that walks
 * that chain, so isolation cannot drift between operations.
 *
 * `notFound` is injected so the same walk can report either side of the
 * relationship with the error the caller expects.
 */
async function resolveProfile(
  workforceProfileId: string,
  notFound: () => AppError,
): Promise<ResolvedProfile> {
  const profile = await workforceRepository.findById(workforceProfileId);
  if (!profile) {
    throw notFound();
  }

  const organization = await organizationRepository.findById(
    profile.organizationId,
  );
  if (!organization) {
    // A profile always points at a real organization (enforced by FK), so this
    // is a data-integrity fault rather than a caller error.
    throw notFound();
  }

  return { profile, clientId: organization.clientId };
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
 * Cross-validates both sides of a reporting line.
 *
 * Order is deliberate and is what the tests pin down:
 *   1. unknown Workforce          → 404
 *   2. self-supervision           → 400 (cheap, id-only, no extra lookup)
 *   3. unknown Supervisor         → 404
 *   4. cross-Client pair          → 400 (before any state check, so a foreign
 *                                        profile's status is never observable)
 *   5. INACTIVE Workforce         → 400  ┐ only when the resulting line would
 *   6. INACTIVE Supervisor        → 400  ┘ be ACTIVE
 *   7. simple circular A→B, B→A   → 400
 *
 * Both profiles are looked up through the Organization → Client chain, so the
 * Client comparison enforces the whole isolation boundary in one place.
 */
async function assertReportable(
  workforceProfileId: string,
  supervisorWorkforceProfileId: string,
  willBeActive: boolean,
): Promise<void> {
  const subordinate = await resolveProfile(
    workforceProfileId,
    workforceProfileNotFoundError,
  );

  if (workforceProfileId === supervisorWorkforceProfileId) {
    throw workforceReportingLineSelfSupervisionError();
  }

  const supervisor = await resolveProfile(
    supervisorWorkforceProfileId,
    workforceSupervisorNotFoundError,
  );

  if (subordinate.clientId !== supervisor.clientId) {
    throw workforceReportingLineClientMismatchError();
  }

  if (willBeActive) {
    if (subordinate.profile.status !== 'ACTIVE') {
      throw workforceProfileInactiveError();
    }
    if (supervisor.profile.status !== 'ACTIVE') {
      throw workforceSupervisorInactiveError();
    }

    // Only the direct two-node cycle is rejected: if the proposed supervisor
    // already reports to this profile, A → B and B → A would both be live.
    // BE-03F deliberately stops here rather than walking the whole graph.
    const wouldBeCircular =
      await workforceReportingLineRepository.existsActiveLine(
        supervisorWorkforceProfileId,
        workforceProfileId,
      );
    if (wouldBeCircular) {
      throw workforceReportingLineCircularError();
    }
  }
}

/**
 * Assigns a Supervisor to a Workforce Profile.
 *
 * This records the reporting relationship and nothing else: no Role,
 * Permission, Position, Team, Shift, Skill, or Building Assignment is read or
 * written anywhere in this path, and there is no approval workflow.
 */
export async function assignSupervisor(
  input: AssignSupervisorInput,
): Promise<PublicWorkforceReportingLine> {
  const status = input.status ?? 'ACTIVE';

  await assertReportable(
    input.workforceProfileId,
    input.supervisorWorkforceProfileId,
    status === 'ACTIVE',
  );

  const effectiveFrom = input.effectiveFrom ?? null;
  const effectiveUntil = input.effectiveUntil ?? null;

  assertEffectiveOrder(effectiveFrom, effectiveUntil);

  if (status === 'ACTIVE') {
    // One live supervisor per Workforce Profile: re-pointing an existing line
    // is a PATCH, so a second POST is a conflict rather than a silent
    // overwrite.
    const existing =
      await workforceReportingLineRepository.findActiveByWorkforceProfileId(
        input.workforceProfileId,
      );
    if (existing) {
      throw workforceReportingLineAlreadyExistsError();
    }
  }

  const newLine: NewWorkforceReportingLine = {
    workforceProfileId: input.workforceProfileId,
    supervisorWorkforceProfileId: input.supervisorWorkforceProfileId,
    effectiveFrom,
    effectiveUntil,
    status,
  };

  try {
    const record = await workforceReportingLineRepository.create(newLine);
    return toPublicWorkforceReportingLine(record);
  } catch (error) {
    if (isActiveReportingLineUniqueViolation(error)) {
      throw workforceReportingLineAlreadyExistsError();
    }
    throw error;
  }
}

/**
 * BE-03F resolver — the Supervisor a Workforce Profile actually reports to.
 *
 * A Supervisor is current only when all of these hold:
 *   - the reporting line is ACTIVE,
 *   - the supervisor's Workforce Profile is still ACTIVE,
 *   - `effectiveFrom` is empty or already reached,
 *   - `effectiveUntil` is empty or not yet passed.
 *
 * Pure read: it never writes and never touches Role, Permission, Position,
 * Team, Shift, Skill, or Building Assignment. This is the reusable entry point
 * later slices should call instead of re-deriving the supervisor from Position
 * or Team. `asOf` defaults to now so callers (and tests) can evaluate the same
 * profile against a chosen instant deterministically.
 */
export async function resolveCurrentSupervisor(
  workforceProfileId: string,
  asOf: Date = new Date(),
): Promise<CurrentSupervisor | null> {
  // Resolving the profile proves it exists, so an unknown id is a controlled
  // 404 rather than a misleading "no supervisor".
  await resolveProfile(workforceProfileId, workforceProfileNotFoundError);

  return workforceReportingLineRepository.findCurrentSupervisor(
    workforceProfileId,
    asOf,
  );
}

/**
 * BE-03F resolver — the Workforce Profiles currently reporting to a Supervisor.
 * The mirror image of `resolveCurrentSupervisor`, and equally read-only.
 */
export async function listDirectReports(
  supervisorWorkforceProfileId: string,
  asOf: Date = new Date(),
): Promise<DirectReport[]> {
  await resolveProfile(
    supervisorWorkforceProfileId,
    workforceProfileNotFoundError,
  );

  return workforceReportingLineRepository.listDirectReports(
    supervisorWorkforceProfileId,
    asOf,
  );
}

/** Every reporting line ever recorded for a Workforce Profile, history included. */
export async function listReportingLineHistory(
  workforceProfileId: string,
): Promise<PublicWorkforceReportingLine[]> {
  await resolveProfile(workforceProfileId, workforceProfileNotFoundError);

  const records =
    await workforceReportingLineRepository.listByWorkforceProfileId(
      workforceProfileId,
    );

  return records.map(toPublicWorkforceReportingLine);
}

/**
 * Updates the reporting line of a Workforce Profile: re-point it at a different
 * Supervisor, adjust its effective window, or deactivate it.
 *
 * Deactivation is expressed as `status: 'INACTIVE'` on this same endpoint; the
 * row is retained so the reporting history stays auditable. Nothing is ever
 * hard-deleted.
 */
export async function updateReportingLine(
  workforceProfileId: string,
  input: UpdateWorkforceReportingLineInput,
): Promise<PublicWorkforceReportingLine> {
  const existing =
    await workforceReportingLineRepository.findByWorkforceProfileId(
      workforceProfileId,
    );
  if (!existing) {
    // Distinguish "no such profile" (404 WORKFORCE_PROFILE_NOT_FOUND) from
    // "profile exists but has no reporting line".
    await resolveProfile(workforceProfileId, workforceProfileNotFoundError);
    throw workforceReportingLineNotFoundError();
  }

  const supervisorWorkforceProfileId =
    input.supervisorWorkforceProfileId ?? existing.supervisorWorkforceProfileId;
  const nextStatus = input.status ?? existing.status;

  await assertReportable(
    workforceProfileId,
    supervisorWorkforceProfileId,
    nextStatus === 'ACTIVE',
  );

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

  // Re-activating a superseded line must not collide with the line that
  // replaced it.
  if (nextStatus === 'ACTIVE' && existing.status !== 'ACTIVE') {
    const active =
      await workforceReportingLineRepository.findActiveByWorkforceProfileId(
        workforceProfileId,
      );
    if (active) {
      throw workforceReportingLineAlreadyExistsError();
    }
  }

  try {
    const record = await workforceReportingLineRepository.update(
      existing.id,
      input,
    );
    if (!record) {
      throw workforceReportingLineNotFoundError();
    }
    return toPublicWorkforceReportingLine(record);
  } catch (error) {
    if (isActiveReportingLineUniqueViolation(error)) {
      throw workforceReportingLineAlreadyExistsError();
    }
    throw error;
  }
}

/** Convenience wrapper: deactivation is an update to `status: 'INACTIVE'`. */
export async function deactivateReportingLine(
  workforceProfileId: string,
): Promise<PublicWorkforceReportingLine> {
  return updateReportingLine(workforceProfileId, { status: 'INACTIVE' });
}

export const workforceReportingLineService = {
  assignSupervisor,
  deactivateReportingLine,
  listDirectReports,
  listReportingLineHistory,
  resolveCurrentSupervisor,
  toPublicWorkforceReportingLine,
  updateReportingLine,
};
