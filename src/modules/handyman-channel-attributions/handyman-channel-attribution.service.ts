import type { PoolClient } from 'pg';
import { AppError } from '../../shared/errors';
import { buildingRepository } from '../buildings';
import { handymanCareActorRepository } from '../handyman-care-actors/handyman-care-actor.repository';
import {
  HANDYMAN_CARE_ACTOR_REFERENCE_MAX_LENGTH,
  HANDYMAN_CARE_ACTOR_TYPE,
  type HandymanCareActorType,
} from '../handyman-care-actors/handyman-care-actor.types';
import { propertyRepository } from '../properties';
import { tenantBuildingContextRepository } from '../tenant-building-contexts';
import {
  tenantCompanyNotFoundError,
  tenantCompanyRepository,
} from '../tenant-companies';
import { tenantPicRepository } from '../tenant-pics';
import { tenantSpaceRepository } from '../tenant-spaces';
import { userRepository } from '../users';
import {
  handymanChannelAttributionContextInvalidError,
  handymanChannelAttributionNotFoundError,
  handymanChannelAttributionOriginReferenceConflictError,
  handymanChannelAttributionRequesterInvalidError,
  handymanChannelAttributionSpaceMismatchError,
} from './handyman-channel-attribution.errors';
import { handymanChannelAttributionRepository } from './handyman-channel-attribution.repository';
import {
  HANDYMAN_CHANNEL_ATTRIBUTION_ORIGIN_REFERENCE_MAX_LENGTH,
  isHandymanChannelAttributionOriginChannel,
  type CreateHandymanChannelAttributionInput,
  type HandymanChannelAttributionOriginChannel,
  type HandymanChannelAttributionRecord,
  type PublicHandymanChannelAttribution,
} from './handyman-channel-attribution.types';

/**
 * CR-HM-01 PART 01 — Handyman Channel Attribution service.
 *
 * Creates trusted channel attribution from server-side resolved context only:
 * every reference is re-validated against backend authorities and the
 * tenant-isolation root (client) is DERIVED here — never trusted from input.
 * There is deliberately no update or delete service surface.
 */

const ORIGIN_REFERENCE_UNIQUE_CONSTRAINT =
  'handyman_channel_attributions_origin_reference_unique';

function isEffectiveNow(record: {
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
}): boolean {
  const now = Date.now();
  if (record.effectiveFrom && record.effectiveFrom.getTime() > now) return false;
  if (record.effectiveUntil && record.effectiveUntil.getTime() < now) return false;
  return true;
}

function isOriginReferenceUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate?.code === '23505' &&
    candidate?.constraint === ORIGIN_REFERENCE_UNIQUE_CONSTRAINT
  );
}

function assertOriginChannel(
  value: unknown,
): asserts value is HandymanChannelAttributionOriginChannel {
  if (!isHandymanChannelAttributionOriginChannel(value)) {
    throw AppError.validation('Attribution validation failed.', [
      {
        field: 'originChannel',
        message: 'originChannel is not a recognized Handyman origin channel.',
      },
    ]);
  }
}

function normalizeOriginReference(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > HANDYMAN_CHANNEL_ATTRIBUTION_ORIGIN_REFERENCE_MAX_LENGTH
  ) {
    throw AppError.validation('Attribution validation failed.', [
      {
        field: 'originReference',
        message: `originReference must be 1-${HANDYMAN_CHANNEL_ATTRIBUTION_ORIGIN_REFERENCE_MAX_LENGTH} characters when provided.`,
      },
    ]);
  }
  return trimmed;
}

export function toPublicHandymanChannelAttribution(
  record: HandymanChannelAttributionRecord,
): PublicHandymanChannelAttribution {
  return { ...record, createdAt: record.createdAt.toISOString() };
}

type ResolvedActorInput = {
  actorType: HandymanCareActorType;
  careActorId: string;
  actorReference: string;
};

/**
 * PART 10 — validates server-derived actor provenance supplied by the trusted
 * handoff binding seam. Rules (governance §3.5 / D8):
 * - the three actor fields are all-or-nothing;
 * - the actor type vocabulary is closed (CUSTOMER_CARE only);
 * - the registry row referenced by `careActorId` must EXIST and its stored
 *   reference must equal the attested `actorReference`, so a care attribution
 *   can never point at a users/tenant_pics identity or a mismatched reference
 *   (the FK to the registry makes the same guarantee at the storage layer);
 * - a local `createdByUserId` must not accompany an attested actor: for a
 *   Customer Care handoff the acting identity is the actor, and the
 *   represented customer's linked user must never be borrowed as the acting
 *   user.
 *
 * Lifecycle note: ACTIVE was authoritative when the exchange was issued
 * (PART 08/09). Binding records that already-resolved provenance, so it
 * re-validates integrity — not the current registry status — and a
 * deactivation cannot retroactively invalidate an exchange that was validly
 * issued.
 */
async function resolveActorInput(
  input: CreateHandymanChannelAttributionInput,
): Promise<ResolvedActorInput | null> {
  const hasAnyActorField =
    input.actorType !== undefined ||
    input.careActorId !== undefined ||
    input.actorReference !== undefined;
  if (!hasAnyActorField) return null;

  const hasAllActorFields =
    input.actorType !== undefined &&
    input.careActorId !== undefined &&
    input.actorReference !== undefined;
  if (!hasAllActorFields) {
    throw AppError.validation('Attribution validation failed.', [
      {
        field: 'actorType',
        message:
          'Attested actor provenance requires actorType, careActorId and actorReference together.',
      },
    ]);
  }
  if (input.actorType !== HANDYMAN_CARE_ACTOR_TYPE) {
    throw AppError.validation('Attribution validation failed.', [
      {
        field: 'actorType',
        message: 'actorType is not a recognized Handyman actor type.',
      },
    ]);
  }
  const careActorId = input.careActorId as string;
  const actorReference =
    typeof input.actorReference === 'string' ? input.actorReference.trim() : '';
  if (
    actorReference.length === 0 ||
    actorReference.length > HANDYMAN_CARE_ACTOR_REFERENCE_MAX_LENGTH
  ) {
    throw AppError.validation('Attribution validation failed.', [
      {
        field: 'actorReference',
        message: `actorReference must be 1-${HANDYMAN_CARE_ACTOR_REFERENCE_MAX_LENGTH} characters when provided.`,
      },
    ]);
  }
  if (input.createdByUserId !== undefined) {
    throw AppError.validation('Attribution validation failed.', [
      {
        field: 'createdByUserId',
        message:
          'createdByUserId must not be supplied for an attested Customer Care actor attribution.',
      },
    ]);
  }

  const registryRow = await handymanCareActorRepository.findById(careActorId);
  if (!registryRow || registryRow.actorReference !== actorReference) {
    throw AppError.validation('Attribution validation failed.', [
      {
        field: 'careActorId',
        message:
          'careActorId must reference an existing Customer Care actor whose stored reference matches actorReference.',
      },
    ]);
  }

  return {
    actorType: HANDYMAN_CARE_ACTOR_TYPE,
    careActorId: registryRow.id,
    actorReference: registryRow.actorReference,
  };
}

/**
 * Creates the immutable attribution after re-validating every server-side
 * reference and deriving the tenant-isolation root. `client` (existing
 * withTransaction convention) lets a wrapping unit of work make the insert
 * atomic with its own writes — the caller-owned transaction then also governs
 * the origin-reference pre-check below.
 */
export async function createChannelAttribution(
  input: CreateHandymanChannelAttributionInput,
  client?: PoolClient,
): Promise<PublicHandymanChannelAttribution> {
  assertOriginChannel(input.originChannel);
  const originReference = normalizeOriginReference(input.originReference);
  // PART 10 — attested Customer Care actor provenance (server-derived only).
  const actor = await resolveActorInput(input);

  const company = await tenantCompanyRepository.findById(input.tenantCompanyId);
  if (!company) throw tenantCompanyNotFoundError();
  if (company.status !== 'ACTIVE') {
    throw handymanChannelAttributionContextInvalidError();
  }

  const building = await buildingRepository.findById(input.buildingId);
  if (!building || building.status !== 'ACTIVE') {
    throw handymanChannelAttributionContextInvalidError();
  }

  // Tenant isolation: the building must belong to the SAME client as the
  // tenant company. The isolation root is always derived, never supplied.
  const property = await propertyRepository.findById(building.propertyId);
  if (!property || property.clientId !== company.clientId) {
    throw handymanChannelAttributionContextInvalidError();
  }

  const context = await tenantBuildingContextRepository.findActive(
    company.id,
    building.id,
  );
  if (!context || !isEffectiveNow(context)) {
    throw handymanChannelAttributionContextInvalidError();
  }

  let tenantPicId: string | null = null;
  if (input.tenantPicId !== undefined) {
    const requester = await tenantPicRepository.findById(input.tenantPicId);
    if (
      !requester ||
      requester.tenantCompanyId !== company.id ||
      requester.status !== 'ACTIVE'
    ) {
      throw handymanChannelAttributionRequesterInvalidError();
    }
    tenantPicId = requester.id;
  }

  let spaceId: string | null = null;
  if (input.spaceId !== undefined) {
    const relationship =
      await tenantSpaceRepository.findActiveByTenantBuildingAndSpace(
        company.id,
        building.id,
        input.spaceId,
      );
    if (!relationship || !isEffectiveNow(relationship)) {
      throw handymanChannelAttributionSpaceMismatchError();
    }
    spaceId = input.spaceId;
  }

  // Acting local user. `resolveActorInput` already rejected supplying one
  // together with an attested actor, so this can only be a legacy/manual
  // attribution (no actor) — the represented PIC user is never borrowed here
  // for Customer Care flows.
  let createdByUserId: string | null = null;
  if (input.createdByUserId !== undefined) {
    const actingUser = await userRepository.findById(input.createdByUserId);
    if (!actingUser) {
      throw AppError.validation('Attribution validation failed.', [
        {
          field: 'createdByUserId',
          message: 'createdByUserId must reference an existing user.',
        },
      ]);
    }
    createdByUserId = actingUser.id;
  }

  if (originReference !== null) {
    const existing = await handymanChannelAttributionRepository
      .findByOriginReference(input.originChannel, originReference, client);
    if (existing) throw handymanChannelAttributionOriginReferenceConflictError();
  }

  try {
    const record = await handymanChannelAttributionRepository.create({
      clientId: company.clientId,
      tenantCompanyId: company.id,
      tenantPicId,
      buildingId: building.id,
      spaceId,
      originChannel: input.originChannel,
      originReference,
      createdByUserId,
      actorType: actor?.actorType ?? null,
      careActorId: actor?.careActorId ?? null,
      actorReference: actor?.actorReference ?? null,
    }, client);
    return toPublicHandymanChannelAttribution(record);
  } catch (error) {
    if (isOriginReferenceUniqueViolation(error)) {
      throw handymanChannelAttributionOriginReferenceConflictError();
    }
    throw error;
  }
}

export async function getChannelAttribution(
  id: string,
): Promise<PublicHandymanChannelAttribution> {
  const record = await handymanChannelAttributionRepository.findById(id);
  if (!record) throw handymanChannelAttributionNotFoundError();
  return toPublicHandymanChannelAttribution(record);
}

export const handymanChannelAttributionService = {
  createChannelAttribution,
  getChannelAttribution,
};
