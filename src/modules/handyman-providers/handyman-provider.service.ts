import {
  clientInactiveError,
  clientNotFoundError,
  clientRepository,
  type ClientRecord,
} from '../clients';
import { contextAccessService } from '../context-access';
import { buildingAccessDeniedError } from '../context-access/context-access.errors';
import { entitlementService } from '../entitlements';
import {
  moduleInactiveError,
  moduleNotFoundError,
  moduleRepository,
} from '../modules';
import { subscriptionRepository } from '../subscriptions';
import {
  vendorInactiveError,
  vendorNotFoundError,
  vendorRepository,
  type VendorRecord,
} from '../vendors';
import {
  handymanProviderAlreadyDesignatedError,
  handymanProviderModuleNotEntitledError,
  handymanProviderNotFoundError,
  handymanProviderStatusInvalidError,
  handymanProviderVendorClientMismatchError,
} from './handyman-provider.errors';
import { handymanProviderRepository } from './handyman-provider.repository';
import type {
  CreateHandymanProviderInput,
  HandymanProviderFilters,
  HandymanProviderRecord,
  PublicHandymanProvider,
  UpdateHandymanProviderStatusInput,
} from './handyman-provider.types';

/**
 * CR-HM-BE-02 RUN 1 — Handyman Provider designation authority.
 *
 * Composes existing foundations; duplicates none of their rules:
 * - Client identity/status: BE-02A `clients` authority.
 * - Actor data scope: BE-02G `contextAccessService.canAccessClient` (the
 *   BE-27A client-scope idiom — permission checks stay in RBAC middleware).
 * - Vendor identity/status/ownership: BE-06A `vendors` authority.
 * - Commercial right: BE-02C module catalogue + the authoritative
 *   `resolveEffectiveEntitlements` resolver composed across the Client's
 *   Subscriptions (the BE-27C `resolveEntitledModuleIds` composition
 *   doctrine — no Subscription/License/Entitlement validity rule is
 *   repeated here).
 *
 * The HANDYMAN module is always resolved through its stable catalogue CODE
 * (`HANDYMAN`); its database id is never hardcoded (BE-02C: the catalogue is
 * authoritative, codes are the machine-readable identity).
 */

/** Stable BE-02C module catalogue code of the Handyman bounded context. */
export const HANDYMAN_MODULE_CODE = 'HANDYMAN';

const UNIQUE_VIOLATION = '23505';
const ACTIVE_UNIQUE_CONSTRAINT =
  'handyman_providers_one_active_per_client_vendor';

export function toPublicHandymanProvider(
  record: HandymanProviderRecord,
): PublicHandymanProvider {
  return {
    id: record.id,
    clientId: record.clientId,
    vendorId: record.vendorId,
    status: record.status,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

async function assertClientAccess(
  userId: string,
  clientId: string,
): Promise<void> {
  if (!(await contextAccessService.canAccessClient(userId, clientId))) {
    throw buildingAccessDeniedError();
  }
}

async function requireClient(clientId: string): Promise<ClientRecord> {
  const client = await clientRepository.findById(clientId);
  if (!client) {
    throw clientNotFoundError();
  }
  return client;
}

/**
 * Resolves the HANDYMAN module through the existing BE-02C catalogue
 * authority and asserts that at least one of the Client's Subscriptions
 * yields it through the authoritative effective-entitlement resolver
 * (Subscription effective ∧ License effective ∧ Entitlement ACTIVE in
 * window ∧ Module ACTIVE). Configuration or designation can never grant
 * the commercial right — only the BE-02C chain can.
 */
export async function assertClientHandymanEntitlement(
  clientId: string,
): Promise<void> {
  const handymanModule = await moduleRepository.findByCode(HANDYMAN_MODULE_CODE);
  if (!handymanModule) {
    throw moduleNotFoundError();
  }
  if (handymanModule.status !== 'ACTIVE') {
    throw moduleInactiveError();
  }

  const subscriptions = await subscriptionRepository.findByClientId(clientId);
  const now = new Date();
  for (const subscription of subscriptions) {
    const effectiveModules = await entitlementService.resolveEffectiveEntitlements(
      subscription.id,
      now,
    );
    if (effectiveModules.some((module) => module.moduleId === handymanModule.id)) {
      return;
    }
  }

  throw handymanProviderModuleNotEntitledError();
}

async function requireDesignatableVendor(
  clientId: string,
  vendorId: string,
): Promise<VendorRecord> {
  const vendor = await vendorRepository.findById(vendorId);
  if (!vendor) {
    throw vendorNotFoundError();
  }
  // Same-Client invariant the FKs cannot express (BE-06D idiom): the Vendor
  // must resolve to the requesting Client.
  if (vendor.clientId !== clientId) {
    throw handymanProviderVendorClientMismatchError();
  }
  if (vendor.status !== 'ACTIVE') {
    throw vendorInactiveError();
  }
  return vendor;
}

function isActiveUniqueViolation(error: unknown): boolean {
  if (
    !(error instanceof Error) ||
    (error as { code?: string }).code !== UNIQUE_VIOLATION
  ) {
    return false;
  }
  return (
    (error as { constraint?: string }).constraint === ACTIVE_UNIQUE_CONSTRAINT
  );
}

/**
 * Designates an existing ACTIVE Vendor of the Client as a Handyman Provider.
 * `createdByUserId` always comes from the authenticated actor — the input
 * shape deliberately cannot carry an actor identity.
 */
export async function designateHandymanProvider(
  input: CreateHandymanProviderInput,
  actorUserId: string,
): Promise<PublicHandymanProvider> {
  // 1. Client existence, then actor data scope, then Client status
  //    (the BE-27A client-scope resolution order).
  const client = await requireClient(input.clientId);
  await assertClientAccess(actorUserId, client.id);
  if (client.status !== 'ACTIVE') {
    throw clientInactiveError();
  }

  // 2. Commercial right through the existing BE-02C authority.
  await assertClientHandymanEntitlement(client.id);

  // 3. Vendor ownership + status invariants.
  await requireDesignatableVendor(client.id, input.vendorId);

  // 4. Duplicate ACTIVE designation.
  const existing = await handymanProviderRepository.findActiveByClientAndVendor(
    client.id,
    input.vendorId,
  );
  if (existing) {
    throw handymanProviderAlreadyDesignatedError();
  }

  try {
    const record = await handymanProviderRepository.create({
      clientId: client.id,
      vendorId: input.vendorId,
      status: 'ACTIVE',
      createdByUserId: actorUserId,
    });
    return toPublicHandymanProvider(record);
  } catch (error) {
    // Concurrent designation race: the partial unique index is the
    // structural authority (migration 0349).
    if (isActiveUniqueViolation(error)) {
      throw handymanProviderAlreadyDesignatedError();
    }
    throw error;
  }
}

export async function getHandymanProviderById(
  id: string,
  actorUserId: string,
): Promise<PublicHandymanProvider> {
  const record = await handymanProviderRepository.findById(id);
  if (!record) {
    throw handymanProviderNotFoundError();
  }
  await assertClientAccess(actorUserId, record.clientId);
  return toPublicHandymanProvider(record);
}

/**
 * Lists a Client's designations including deactivated history rows — the
 * preserved designation history is a first-class read surface. An optional
 * status filter narrows to ACTIVE or INACTIVE.
 */
export async function listHandymanProviders(
  clientId: string,
  actorUserId: string,
  filters: HandymanProviderFilters = {},
): Promise<PublicHandymanProvider[]> {
  await requireClient(clientId);
  await assertClientAccess(actorUserId, clientId);
  const records = await handymanProviderRepository.listByClient(
    clientId,
    filters,
  );
  return records.map(toPublicHandymanProvider);
}

/**
 * ACTIVE ↔ INACTIVE lifecycle on the designation row.
 *
 * Deactivation always succeeds from ACTIVE (fail-safe direction — no
 * invariant re-checks). Reactivation re-asserts the full designation
 * invariants (the BE-06D reactivation idiom): ACTIVE Client, effective
 * HANDYMAN entitlement, ACTIVE Vendor, and no other ACTIVE designation for
 * the pair. The transition itself is guarded (`updateStatusFrom`) so
 * concurrent lifecycle commands cannot both succeed.
 */
export async function updateHandymanProviderStatus(
  id: string,
  input: UpdateHandymanProviderStatusInput,
  actorUserId: string,
): Promise<PublicHandymanProvider> {
  const record = await handymanProviderRepository.findById(id);
  if (!record) {
    throw handymanProviderNotFoundError();
  }
  await assertClientAccess(actorUserId, record.clientId);

  if (record.status === input.status) {
    throw handymanProviderStatusInvalidError(
      input.status === 'INACTIVE'
        ? 'The handyman provider designation is already inactive.'
        : 'The handyman provider designation is already active.',
    );
  }

  if (input.status === 'ACTIVE') {
    const client = await requireClient(record.clientId);
    if (client.status !== 'ACTIVE') {
      throw clientInactiveError();
    }
    await assertClientHandymanEntitlement(record.clientId);
    const vendor = await vendorRepository.findById(record.vendorId);
    if (!vendor) {
      throw vendorNotFoundError();
    }
    if (vendor.status !== 'ACTIVE') {
      throw vendorInactiveError();
    }
    const active = await handymanProviderRepository.findActiveByClientAndVendor(
      record.clientId,
      record.vendorId,
    );
    if (active) {
      throw handymanProviderAlreadyDesignatedError();
    }
  }

  const updated = await handymanProviderRepository.updateStatusFrom(
    id,
    record.status,
    input.status,
  );
  if (!updated) {
    throw handymanProviderStatusInvalidError(
      'The handyman provider designation changed status concurrently; retry the transition.',
    );
  }
  return toPublicHandymanProvider(updated);
}

export const handymanProviderService = {
  assertClientHandymanEntitlement,
  designateHandymanProvider,
  getHandymanProviderById,
  listHandymanProviders,
  toPublicHandymanProvider,
  updateHandymanProviderStatus,
};
