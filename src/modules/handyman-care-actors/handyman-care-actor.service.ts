import { AppError } from '../../shared/errors';
import {
  handymanCareActorIntegrationInvalidError,
  handymanCareActorIntegrationNotFoundError,
  handymanCareActorNotFoundError,
  handymanCareActorReferenceConflictError,
} from './handyman-care-actor.errors';
import { handymanCareActorRepository } from './handyman-care-actor.repository';
import {
  HANDYMAN_CARE_ACTOR_DISPLAY_NAME_MAX_LENGTH,
  HANDYMAN_CARE_ACTOR_REFERENCE_MAX_LENGTH,
  isHandymanHandoffIntegrationActorCapability,
  type CreateHandymanCareActorInput,
  type HandymanCareActorRecord,
  type HandymanCareActorStatus,
  type HandymanHandoffIntegrationActorScope,
  type PublicHandymanCareActor,
} from './handyman-care-actor.types';

/**
 * CR-HM-01 AMENDMENT 01 PART 07 — Customer Care actor service.
 *
 * Operational registry administration ONLY: integration actor-capability
 * provisioning plus the Customer Care actor ACTIVE/INACTIVE lifecycle.
 * Deliberately absent here (governance §9):
 * - no attested actor resolver (PART 08) — no assertion/actor-claim handling;
 * - no assertion/exchange runtime integration (PART 09);
 * - no attribution actor binding (PART 10);
 * - no HTTP surface (PART 11);
 * - no local user, session, RBAC or entitlement side effects — ever.
 *
 * Registry rows are provisioned server-side by operations; an assertion can
 * only ever NAME a pre-existing, active, integration-scoped actor (PART 08).
 */

const REFERENCE_UNIQUE_CONSTRAINT =
  'handyman_handoff_care_actors_reference_unique';

function isReferenceUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate?.code === '23505' &&
    candidate?.constraint === REFERENCE_UNIQUE_CONSTRAINT
  );
}

function normalizeActorReference(value: unknown): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (
    trimmed.length === 0 ||
    trimmed.length > HANDYMAN_CARE_ACTOR_REFERENCE_MAX_LENGTH
  ) {
    throw AppError.validation('Customer Care actor validation failed.', [
      {
        field: 'actorReference',
        message: `actorReference must be 1-${HANDYMAN_CARE_ACTOR_REFERENCE_MAX_LENGTH} characters.`,
      },
    ]);
  }
  return trimmed;
}

function normalizeDisplayName(value: unknown): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (
    trimmed.length === 0 ||
    trimmed.length > HANDYMAN_CARE_ACTOR_DISPLAY_NAME_MAX_LENGTH
  ) {
    throw AppError.validation('Customer Care actor validation failed.', [
      {
        field: 'displayName',
        message: `displayName must be 1-${HANDYMAN_CARE_ACTOR_DISPLAY_NAME_MAX_LENGTH} characters.`,
      },
    ]);
  }
  return trimmed;
}

export function toPublicHandymanCareActor(
  record: HandymanCareActorRecord,
): PublicHandymanCareActor {
  return {
    ...record,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/** Operational provisioning of the integration's actor-capability scope. */
export async function setIntegrationActorCapability(input: {
  integrationId: string;
  capability: unknown;
}): Promise<HandymanHandoffIntegrationActorScope> {
  if (!isHandymanHandoffIntegrationActorCapability(input.capability)) {
    throw AppError.validation('Actor capability validation failed.', [
      {
        field: 'capability',
        message: 'capability must be NONE, CUSTOMER_CARE, or TENANT_PIC.',
      },
    ]);
  }
  const updated = await handymanCareActorRepository.setIntegrationActorCapability(
    input.integrationId,
    input.capability,
  );
  if (!updated) throw handymanCareActorIntegrationNotFoundError();
  return updated;
}

export async function getIntegrationActorScope(
  integrationId: string,
): Promise<HandymanHandoffIntegrationActorScope> {
  const scope = await handymanCareActorRepository.findIntegrationActorScopeById(
    integrationId,
  );
  if (!scope) throw handymanCareActorIntegrationNotFoundError();
  return scope;
}

/**
 * Registers a Customer Care operator inside an integration that is ACTIVE and
 * explicitly holds the CUSTOMER_CARE capability. The reference is stored
 * verbatim (trimmed) and never resolved against users/tenant-pics.
 */
export async function createCareActor(
  input: CreateHandymanCareActorInput,
): Promise<PublicHandymanCareActor> {
  const actorReference = normalizeActorReference(input.actorReference);
  const displayName = normalizeDisplayName(input.displayName);

  const scope = await handymanCareActorRepository.findIntegrationActorScopeById(
    input.integrationId,
  );
  if (!scope) throw handymanCareActorIntegrationNotFoundError();
  if (scope.status !== 'ACTIVE' || scope.actorCapability !== 'CUSTOMER_CARE') {
    throw handymanCareActorIntegrationInvalidError();
  }

  // Stable 409 before the insert; the unique constraint remains the
  // race-safe authority and is mapped identically.
  const existing = await handymanCareActorRepository
    .findByIntegrationAndReference(scope.integrationId, actorReference);
  if (existing) throw handymanCareActorReferenceConflictError();

  try {
    const record = await handymanCareActorRepository.create({
      integrationId: scope.integrationId,
      actorReference,
      displayName,
    });
    return toPublicHandymanCareActor(record);
  } catch (error) {
    if (isReferenceUniqueViolation(error)) {
      throw handymanCareActorReferenceConflictError();
    }
    throw error;
  }
}

export async function getCareActor(id: string): Promise<PublicHandymanCareActor> {
  const record = await handymanCareActorRepository.findById(id);
  if (!record) throw handymanCareActorNotFoundError();
  return toPublicHandymanCareActor(record);
}

/** Governed lifecycle: ACTIVE <-> INACTIVE. Idempotent; no delete exists. */
export async function setCareActorStatus(
  id: string,
  status: HandymanCareActorStatus,
): Promise<PublicHandymanCareActor> {
  const existing = await handymanCareActorRepository.findById(id);
  if (!existing) throw handymanCareActorNotFoundError();
  if (existing.status === status) return toPublicHandymanCareActor(existing);
  const updated = await handymanCareActorRepository.updateStatus(id, status);
  if (!updated) throw handymanCareActorNotFoundError();
  return toPublicHandymanCareActor(updated);
}

export function activateCareActor(id: string): Promise<PublicHandymanCareActor> {
  return setCareActorStatus(id, 'ACTIVE');
}

export function deactivateCareActor(id: string): Promise<PublicHandymanCareActor> {
  return setCareActorStatus(id, 'INACTIVE');
}

export const handymanCareActorService = {
  setIntegrationActorCapability,
  getIntegrationActorScope,
  createCareActor,
  getCareActor,
  setCareActorStatus,
  activateCareActor,
  deactivateCareActor,
};
