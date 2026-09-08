import { AppError } from '../../shared/errors';
import { organizationRepository } from '../organizations';
import { workforceNotExternalError } from '../external-workforce';
import {
  workforceProfileInactiveError,
  workforceProfileNotFoundError,
  workforceRepository,
  type WorkforceProfileRecord,
} from '../workforce';
import {
  vendorInactiveError,
  vendorNotFoundError,
  vendorRepository,
  type VendorRecord,
} from '../vendors';
import {
  vendorPersonnelCodeAlreadyExistsError,
  vendorWorkforceAlreadyBoundError,
  vendorWorkforceBindingNotFoundError,
  vendorWorkforceClientMismatchError,
} from './vendor-workforce.errors';
import { vendorWorkforceRepository } from './vendor-workforce.repository';
import type {
  CreateVendorWorkforceBindingInput,
  NewVendorWorkforceBinding,
  PublicVendorWorkforceBinding,
  UpdateVendorWorkforceBindingInput,
  VendorWorkforceBindingRecord,
} from './vendor-workforce.types';
import { normalizeVendorPersonnelCode } from './vendor-workforce.validation';

export function toPublicVendorWorkforceBinding(
  record: VendorWorkforceBindingRecord,
): PublicVendorWorkforceBinding {
  return {
    id: record.id,
    vendorId: record.vendorId,
    workforceProfileId: record.workforceProfileId,
    vendorPersonnelCode: record.vendorPersonnelCode,
    effectiveFrom: record.effectiveFrom,
    effectiveUntil: record.effectiveUntil,
    status: record.status,
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
 * transitively through its Organization (the BE-03H idiom). This is the
 * single place that walks that chain, so isolation cannot drift.
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
    // A profile always points at a real organization (enforced by FK), so
    // this is a data-integrity fault rather than a caller error.
    throw workforceProfileNotFoundError();
  }

  return { profile, clientId: organization.clientId };
}

/**
 * Resolves and cross-validates both sides of the binding.
 *
 * Order is deliberate and mirrors BE-03H (and is what the tests pin down):
 *   1. unknown Vendor         → 404
 *   2. unknown Workforce      → 404
 *   3. cross-Client pair      → 400 (before any state/type check, so a
 *                                    foreign profile's nature is never
 *                                    observable)
 *   4. non-EXTERNAL Workforce → 400
 *   5. INACTIVE Vendor        → 400 (only when the result would be an
 *                                    ACTIVE binding)
 *   6. INACTIVE Workforce     → 400 (same condition; history stays editable)
 *
 * Nothing in this path reads or writes a User, Credential, Role, Permission,
 * User Building Access, Workforce Building Assignment, Shift, Skill, or
 * Supervisor row.
 */
async function assertBindable(
  vendorId: string,
  workforceProfileId: string,
  intendedStatus: 'ACTIVE' | 'INACTIVE',
): Promise<{ vendor: VendorRecord; profile: WorkforceProfileRecord }> {
  const vendor = await vendorRepository.findById(vendorId);
  if (!vendor) {
    throw vendorNotFoundError();
  }

  const { profile, clientId: workforceClientId } =
    await resolveWorkforce(workforceProfileId);

  if (workforceClientId !== vendor.clientId) {
    throw vendorWorkforceClientMismatchError();
  }

  if (profile.workforceType !== 'EXTERNAL') {
    throw workforceNotExternalError();
  }

  if (intendedStatus === 'ACTIVE' && vendor.status !== 'ACTIVE') {
    throw vendorInactiveError();
  }

  if (intendedStatus === 'ACTIVE' && profile.status !== 'ACTIVE') {
    throw workforceProfileInactiveError();
  }

  return { vendor, profile };
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
 * Binds an EXTERNAL Workforce Profile to a Vendor.
 *
 * This records vendor context and nothing else. It creates no User,
 * Credential, Role, Permission, User Building Access, Workforce Building
 * Assignment, Shift, Skill, or Supervisor change, and it creates no second
 * person master — the profile row in `workforce_profiles` stays the only
 * person record.
 *
 * Duplicate control: one ACTIVE binding per (vendor, profile), and the
 * vendor's personnel code stays reserved per Vendor across active and
 * historical rows.
 */
export async function createVendorWorkforceBinding(
  input: CreateVendorWorkforceBindingInput,
): Promise<PublicVendorWorkforceBinding> {
  const status = input.status ?? 'ACTIVE';

  await assertBindable(input.vendorId, input.workforceProfileId, status);

  const effectiveFrom = input.effectiveFrom ?? null;
  const effectiveUntil = input.effectiveUntil ?? null;

  assertEffectiveOrder(effectiveFrom, effectiveUntil);

  const vendorPersonnelCode = normalizeVendorPersonnelCode(
    input.vendorPersonnelCode,
  );

  // The duplicate-active check runs first so re-submitting the same pair
  // reports the binding conflict (mirroring BE-03H), not the code
  // reservation.
  if (status === 'ACTIVE') {
    const existing =
      await vendorWorkforceRepository.findActiveByVendorAndWorkforce(
        input.vendorId,
        input.workforceProfileId,
      );
    if (existing) {
      throw vendorWorkforceAlreadyBoundError();
    }
  }

  const codeTaken =
    await vendorWorkforceRepository.findByVendorAndPersonnelCode(
      input.vendorId,
      vendorPersonnelCode,
    );
  if (codeTaken) {
    throw vendorPersonnelCodeAlreadyExistsError();
  }

  const newBinding: NewVendorWorkforceBinding = {
    vendorId: input.vendorId,
    workforceProfileId: input.workforceProfileId,
    vendorPersonnelCode,
    effectiveFrom,
    effectiveUntil,
    status,
  };

  try {
    const record = await vendorWorkforceRepository.create(newBinding);
    return toPublicVendorWorkforceBinding(record);
  } catch (error) {
    const constraint = uniqueViolationConstraint(error);
    if (constraint === 'vendor_workforce_bindings_active_unique') {
      throw vendorWorkforceAlreadyBoundError();
    }
    if (constraint === 'vendor_workforce_bindings_personnel_code_unique') {
      throw vendorPersonnelCodeAlreadyExistsError();
    }
    throw error;
  }
}

/**
 * Returns the single binding addressed by (vendor, workforce). Both ids
 * must exist and belong to the same Client — an unknown side 404s, a
 * cross-Client pair 400s — and the binding itself 404s when no row exists
 * for the pair.
 */
export async function getVendorWorkforceBinding(
  vendorId: string,
  workforceProfileId: string,
): Promise<PublicVendorWorkforceBinding> {
  const vendor = await vendorRepository.findById(vendorId);
  if (!vendor) {
    throw vendorNotFoundError();
  }

  const { clientId: workforceClientId } =
    await resolveWorkforce(workforceProfileId);
  if (workforceClientId !== vendor.clientId) {
    throw vendorWorkforceClientMismatchError();
  }

  const record = await vendorWorkforceRepository.findByVendorAndWorkforce(
    vendorId,
    workforceProfileId,
  );
  if (!record) {
    throw vendorWorkforceBindingNotFoundError();
  }

  return toPublicVendorWorkforceBinding(record);
}

/** Lists every workforce binding held by one Vendor. */
export async function listVendorWorkforce(
  vendorId: string,
): Promise<PublicVendorWorkforceBinding[]> {
  // Resolving the vendor also proves it exists — unknown ids 404 rather
  // than returning a misleading empty list.
  const vendor = await vendorRepository.findById(vendorId);
  if (!vendor) {
    throw vendorNotFoundError();
  }

  const records = await vendorWorkforceRepository.listByVendorId(vendorId);
  return records.map(toPublicVendorWorkforceBinding);
}

/** Lists every Vendor binding held by one Workforce Profile. */
export async function listWorkforceVendorBindings(
  workforceProfileId: string,
): Promise<PublicVendorWorkforceBinding[]> {
  // Proves the profile exists so unknown ids 404 instead of returning [].
  await resolveWorkforce(workforceProfileId);

  const records =
    await vendorWorkforceRepository.listByWorkforceProfileId(
      workforceProfileId,
    );
  return records.map(toPublicVendorWorkforceBinding);
}

/**
 * Updates the binding addressed by (vendor, workforce).
 *
 * Deactivation is expressed as `status: 'INACTIVE'` on this same endpoint;
 * the row is retained so the binding history stays auditable.
 */
export async function updateVendorWorkforceBinding(
  vendorId: string,
  workforceProfileId: string,
  input: UpdateVendorWorkforceBindingInput,
): Promise<PublicVendorWorkforceBinding> {
  const vendor = await vendorRepository.findById(vendorId);
  if (!vendor) {
    throw vendorNotFoundError();
  }

  const { profile, clientId: workforceClientId } =
    await resolveWorkforce(workforceProfileId);
  if (workforceClientId !== vendor.clientId) {
    throw vendorWorkforceClientMismatchError();
  }

  const existing = await vendorWorkforceRepository.findByVendorAndWorkforce(
    vendorId,
    workforceProfileId,
  );
  if (!existing) {
    throw vendorWorkforceBindingNotFoundError();
  }

  // Merge against the stored record so a partial update cannot produce an
  // invalid window.
  const effectiveFrom =
    input.effectiveFrom === undefined
      ? existing.effectiveFrom
      : input.effectiveFrom;
  const effectiveUntil =
    input.effectiveUntil === undefined
      ? existing.effectiveUntil
      : input.effectiveUntil;

  assertEffectiveOrder(effectiveFrom, effectiveUntil);

  const effectiveInput: UpdateVendorWorkforceBindingInput = { ...input };

  if (input.vendorPersonnelCode !== undefined) {
    const normalized = normalizeVendorPersonnelCode(input.vendorPersonnelCode);
    if (normalized !== existing.vendorPersonnelCode) {
      const codeTaken =
        await vendorWorkforceRepository.findByVendorAndPersonnelCode(
          vendorId,
          normalized,
        );
      if (codeTaken && codeTaken.id !== existing.id) {
        throw vendorPersonnelCodeAlreadyExistsError();
      }
    }
    effectiveInput.vendorPersonnelCode = normalized;
  }

  // Re-activating a historical row must respect Vendor and profile state and
  // the one-ACTIVE-per-pair rule.
  if (input.status === 'ACTIVE' && existing.status !== 'ACTIVE') {
    if (vendor.status !== 'ACTIVE') {
      throw vendorInactiveError();
    }
    if (profile.status !== 'ACTIVE') {
      throw workforceProfileInactiveError();
    }

    const active =
      await vendorWorkforceRepository.findActiveByVendorAndWorkforce(
        vendorId,
        workforceProfileId,
      );
    if (active && active.id !== existing.id) {
      throw vendorWorkforceAlreadyBoundError();
    }
  }

  try {
    const record = await vendorWorkforceRepository.update(
      existing.id,
      effectiveInput,
    );
    return toPublicVendorWorkforceBinding(
      record as VendorWorkforceBindingRecord,
    );
  } catch (error) {
    const constraint = uniqueViolationConstraint(error);
    if (constraint === 'vendor_workforce_bindings_active_unique') {
      throw vendorWorkforceAlreadyBoundError();
    }
    if (constraint === 'vendor_workforce_bindings_personnel_code_unique') {
      throw vendorPersonnelCodeAlreadyExistsError();
    }
    throw error;
  }
}

export const vendorWorkforceService = {
  createVendorWorkforceBinding,
  getVendorWorkforceBinding,
  listVendorWorkforce,
  listWorkforceVendorBindings,
  toPublicVendorWorkforceBinding,
  updateVendorWorkforceBinding,
};
