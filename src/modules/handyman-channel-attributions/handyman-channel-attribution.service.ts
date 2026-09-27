import { AppError } from '../../shared/errors';
import { buildingRepository } from '../buildings';
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

export async function createChannelAttribution(
  input: CreateHandymanChannelAttributionInput,
): Promise<PublicHandymanChannelAttribution> {
  assertOriginChannel(input.originChannel);
  const originReference = normalizeOriginReference(input.originReference);

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

  let createdByUserId: string | null = null;
  if (input.createdByUserId !== undefined) {
    const actor = await userRepository.findById(input.createdByUserId);
    if (!actor) {
      throw AppError.validation('Attribution validation failed.', [
        {
          field: 'createdByUserId',
          message: 'createdByUserId must reference an existing user.',
        },
      ]);
    }
    createdByUserId = actor.id;
  }

  if (originReference !== null) {
    const existing = await handymanChannelAttributionRepository
      .findByOriginReference(input.originChannel, originReference);
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
    });
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
