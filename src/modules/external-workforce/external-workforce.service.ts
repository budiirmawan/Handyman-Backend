import { AppError } from '../../shared/errors';
import {
  externalOrganizationRepository,
  type ExternalOrganizationRecord,
} from '../external-organizations';
import { organizationRepository } from '../organizations';
import {
  workforceProfileInactiveError,
  workforceProfileNotFoundError,
  workforceRepository,
  type WorkforceProfileRecord,
} from '../workforce';
import {
  externalOrganizationInactiveError,
  externalOrganizationNotFoundError,
  externalPersonnelCodeAlreadyExistsError,
  externalWorkforceAlreadyAffiliatedError,
  externalWorkforceClientMismatchError,
  externalWorkforceLinkNotFoundError,
  workforceNotExternalError,
} from './external-workforce.errors';
import { externalWorkforceRepository } from './external-workforce.repository';
import type {
  CreateExternalWorkforceLinkInput,
  ExternalWorkforceLinkRecord,
  NewExternalWorkforceLink,
  PublicExternalWorkforceLink,
  UpdateExternalWorkforceLinkInput,
} from './external-workforce.types';
import { normalizeExternalPersonnelCode } from './external-workforce.validation';

export function toPublicExternalWorkforceLink(
  record: ExternalWorkforceLinkRecord,
): PublicExternalWorkforceLink {
  return {
    id: record.id,
    workforceProfileId: record.workforceProfileId,
    externalOrganizationId: record.externalOrganizationId,
    externalPersonnelCode: record.externalPersonnelCode,
    status: record.status,
    effectiveFrom: record.effectiveFrom,
    effectiveUntil: record.effectiveUntil,
  };
}

/**
 * PostgreSQL unique-violation backstop behind the explicit duplicate
 * pre-checks: the partial ACTIVE index and the personnel-code UNIQUE both
 * protect against races.
 */
function uniqueViolationConstraint(error: unknown): string | null {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505' &&
    'constraint' in error
  ) {
    return (error as { constraint?: unknown }).constraint as string;
  }
  return null;
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
 * Resolves the External Organization reference and its owning Client. The
 * reference carries its `client_id` directly, unlike a Workforce Profile.
 */
async function resolveExternalOrganization(
  externalOrganizationId: string,
): Promise<{
  externalOrganization: ExternalOrganizationRecord;
  clientId: string;
}> {
  const externalOrganization =
    await externalOrganizationRepository.findById(externalOrganizationId);
  if (!externalOrganization) {
    throw externalOrganizationNotFoundError();
  }

  return {
    externalOrganization,
    clientId: externalOrganization.clientId,
  };
}

/**
 * Resolves and cross-validates both sides of the affiliation.
 *
 * Order is deliberate and mirrors the BE-03G checks (and is what the tests
 * pin down):
 *   1. unknown Workforce              → 404
 *   2. unknown External Organization  → 404
 *   3. cross-Client pair              → 400 (before any state check, so a
 *                                         foreign vendor's status is never
 *                                         observable)
 *   4. non-EXTERNAL Workforce         → 400
 *   5. INACTIVE External Organization → 400
 *   6. INACTIVE Workforce             → 400 (only when the result would be an
 *                                         ACTIVE affiliation; history stays
 *                                         editable)
 *
 * Nothing in this path reads or writes a User, Credential, Role, Permission,
 * Position, Team, Skill, Shift, Supervisor, Workforce Building Assignment, or
 * User Building Access row.
 */
async function assertAffiliatable(
  workforceProfileId: string,
  externalOrganizationId: string,
  intendedStatus: 'ACTIVE' | 'INACTIVE',
): Promise<void> {
  const { profile, clientId: workforceClientId } =
    await resolveWorkforce(workforceProfileId);
  const { externalOrganization, clientId: organizationClientId } =
    await resolveExternalOrganization(externalOrganizationId);

  if (organizationClientId !== workforceClientId) {
    throw externalWorkforceClientMismatchError();
  }

  if (profile.workforceType !== 'EXTERNAL') {
    throw workforceNotExternalError();
  }

  if (externalOrganization.status !== 'ACTIVE') {
    throw externalOrganizationInactiveError();
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
 * Creates the external workforce affiliation.
 *
 * This records the vendor context of an EXTERNAL Workforce Profile and
 * nothing else. It creates no credentials, no Role, no Permission, and no
 * Building access — and it is unrelated to the BE-02F User Building Access
 * Assignment in both directions.
 *
 * Duplicate control: one ACTIVE affiliation per (profile, external
 * organization), and the vendor's personnel code stays reserved per external
 * organization across active and historical rows.
 */
export async function createExternalWorkforceLink(
  input: CreateExternalWorkforceLinkInput,
): Promise<PublicExternalWorkforceLink> {
  const status = input.status ?? 'ACTIVE';

  await assertAffiliatable(
    input.workforceProfileId,
    input.externalOrganizationId,
    status,
  );

  const effectiveFrom = input.effectiveFrom ?? null;
  const effectiveUntil = input.effectiveUntil ?? null;

  assertEffectiveOrder(effectiveFrom, effectiveUntil);

  const externalPersonnelCode = normalizeExternalPersonnelCode(
    input.externalPersonnelCode,
  );

  // The duplicate-active check runs first so re-submitting the same pair
  // reports the affiliation conflict (mirroring BE-03G), not the code
  // reservation.
  if (status === 'ACTIVE') {
    const existing =
      await externalWorkforceRepository.findActiveByWorkforceAndOrganization(
        input.workforceProfileId,
        input.externalOrganizationId,
      );
    if (existing) {
      throw externalWorkforceAlreadyAffiliatedError();
    }
  }

  const codeTaken =
    await externalWorkforceRepository.findByOrganizationAndPersonnelCode(
      input.externalOrganizationId,
      externalPersonnelCode,
    );
  if (codeTaken) {
    throw externalPersonnelCodeAlreadyExistsError();
  }

  const newLink: NewExternalWorkforceLink = {
    workforceProfileId: input.workforceProfileId,
    externalOrganizationId: input.externalOrganizationId,
    externalPersonnelCode,
    effectiveFrom,
    effectiveUntil,
    status,
  };

  try {
    const record = await externalWorkforceRepository.create(newLink);
    return toPublicExternalWorkforceLink(record);
  } catch (error) {
    const constraint = uniqueViolationConstraint(error);
    if (constraint === 'external_workforce_links_active_unique') {
      throw externalWorkforceAlreadyAffiliatedError();
    }
    if (constraint === 'external_workforce_links_personnel_code_unique') {
      throw externalPersonnelCodeAlreadyExistsError();
    }
    throw error;
  }
}

/**
 * Returns the single affiliation addressed by (workforce, external
 * organization). Both ids must exist and belong to the same Client — an
 * unknown side 404s, a cross-Client pair 400s — and the link itself 404s when
 * no row exists for the pair.
 */
export async function getExternalWorkforceLink(
  workforceProfileId: string,
  externalOrganizationId: string,
): Promise<PublicExternalWorkforceLink> {
  const { clientId: workforceClientId } =
    await resolveWorkforce(workforceProfileId);
  const { clientId: organizationClientId } =
    await resolveExternalOrganization(externalOrganizationId);

  if (organizationClientId !== workforceClientId) {
    throw externalWorkforceClientMismatchError();
  }

  const record =
    await externalWorkforceRepository.findByWorkforceAndOrganization(
      workforceProfileId,
      externalOrganizationId,
    );
  if (!record) {
    throw externalWorkforceLinkNotFoundError();
  }

  return toPublicExternalWorkforceLink(record);
}

/** Lists every affiliation held by one Workforce Profile, history included. */
export async function listWorkforceAffiliations(
  workforceProfileId: string,
): Promise<PublicExternalWorkforceLink[]> {
  // Resolving the profile also proves it exists — unknown ids 404 rather than
  // returning a misleading empty list.
  await resolveWorkforce(workforceProfileId);

  const records =
    await externalWorkforceRepository.listByWorkforceProfileId(
      workforceProfileId,
    );

  return records.map(toPublicExternalWorkforceLink);
}

/**
 * Lists every workforce member affiliated with one External Organization —
 * the vendor's external workforce roster.
 */
export async function listExternalOrganizationWorkforce(
  externalOrganizationId: string,
): Promise<PublicExternalWorkforceLink[]> {
  // Proves the reference exists so unknown ids 404 instead of returning [].
  await resolveExternalOrganization(externalOrganizationId);

  const records =
    await externalWorkforceRepository.listByExternalOrganizationId(
      externalOrganizationId,
    );

  return records.map(toPublicExternalWorkforceLink);
}

/**
 * Updates the affiliation addressed by (workforce, external organization).
 *
 * Deactivation is expressed as `status: 'INACTIVE'` on this same endpoint; the
 * row is retained so the affiliation history stays auditable.
 */
export async function updateExternalWorkforceLink(
  workforceProfileId: string,
  externalOrganizationId: string,
  input: UpdateExternalWorkforceLinkInput,
): Promise<PublicExternalWorkforceLink> {
  const { profile, clientId: workforceClientId } =
    await resolveWorkforce(workforceProfileId);
  const { externalOrganization, clientId: organizationClientId } =
    await resolveExternalOrganization(externalOrganizationId);

  if (organizationClientId !== workforceClientId) {
    throw externalWorkforceClientMismatchError();
  }

  const existing =
    await externalWorkforceRepository.findByWorkforceAndOrganization(
      workforceProfileId,
      externalOrganizationId,
    );
  if (!existing) {
    throw externalWorkforceLinkNotFoundError();
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

  const externalPersonnelCode =
    input.externalPersonnelCode === undefined
      ? existing.externalPersonnelCode
      : normalizeExternalPersonnelCode(input.externalPersonnelCode);

  if (externalPersonnelCode !== existing.externalPersonnelCode) {
    const codeTaken =
      await externalWorkforceRepository.findByOrganizationAndPersonnelCode(
        externalOrganizationId,
        externalPersonnelCode,
      );
    if (codeTaken && codeTaken.id !== existing.id) {
      throw externalPersonnelCodeAlreadyExistsError();
    }
  }

  // Re-activating requires the reference to still be usable, the profile to
  // still be EXTERNAL and active, and no colliding live affiliation.
  if (input.status === 'ACTIVE' && existing.status !== 'ACTIVE') {
    if (externalOrganization.status !== 'ACTIVE') {
      throw externalOrganizationInactiveError();
    }

    if (profile.workforceType !== 'EXTERNAL') {
      throw workforceNotExternalError();
    }

    if (profile.status !== 'ACTIVE') {
      throw workforceProfileInactiveError();
    }

    const active =
      await externalWorkforceRepository.findActiveByWorkforceAndOrganization(
        workforceProfileId,
        externalOrganizationId,
      );
    if (active) {
      throw externalWorkforceAlreadyAffiliatedError();
    }
  }

  const updateInput: UpdateExternalWorkforceLinkInput = {
    ...(input.externalPersonnelCode === undefined
      ? {}
      : { externalPersonnelCode }),
    ...(input.effectiveFrom === undefined ? {} : { effectiveFrom }),
    ...(input.effectiveUntil === undefined ? {} : { effectiveUntil }),
    ...(input.status === undefined ? {} : { status: input.status }),
  };

  try {
    const record = await externalWorkforceRepository.update(
      existing.id,
      updateInput,
    );
    if (!record) {
      throw externalWorkforceLinkNotFoundError();
    }
    return toPublicExternalWorkforceLink(record);
  } catch (error) {
    const constraint = uniqueViolationConstraint(error);
    if (constraint === 'external_workforce_links_active_unique') {
      throw externalWorkforceAlreadyAffiliatedError();
    }
    if (constraint === 'external_workforce_links_personnel_code_unique') {
      throw externalPersonnelCodeAlreadyExistsError();
    }
    throw error;
  }
}

/** Convenience wrapper: deactivation is an update to `status: 'INACTIVE'`. */
export async function deactivateExternalWorkforceLink(
  workforceProfileId: string,
  externalOrganizationId: string,
): Promise<PublicExternalWorkforceLink> {
  return updateExternalWorkforceLink(workforceProfileId, externalOrganizationId, {
    status: 'INACTIVE',
  });
}

export const externalWorkforceService = {
  createExternalWorkforceLink,
  deactivateExternalWorkforceLink,
  getExternalWorkforceLink,
  listExternalOrganizationWorkforce,
  listWorkforceAffiliations,
  toPublicExternalWorkforceLink,
  updateExternalWorkforceLink,
};
