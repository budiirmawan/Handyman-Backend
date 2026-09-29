import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { buildingAccessDeniedError, contextAccessService } from '../context-access';
import {
  handymanChannelAttributionNotFoundError,
  handymanChannelAttributionRepository,
} from '../handyman-channel-attributions';
import { handymanServiceVariantNotActiveError } from '../handyman-catalog';
import { handymanServiceVariantNotFoundError } from '../handyman-catalog';
import { handymanServiceVariantRepository } from '../handyman-catalog';
import {
  serviceCatalogNotActiveError,
  serviceCatalogNotFoundError,
  serviceCatalogRepository,
} from '../service-catalog';
import {
  handymanServiceRequestAlreadyExistsError,
  handymanServiceRequestScopeMismatchError,
} from './handyman-service-request.errors';
import { handymanServiceRequestRepository } from './handyman-service-request.repository';
import type {
  CreateHandymanServiceRequestInput,
  HandymanServiceRequestRecord,
  PublicHandymanServiceRequest,
} from './handyman-service-request.types';

/**
 * CR-HM-02 PART 03 — Handyman request intake service (frozen D3).
 *
 * Create a sibling Handyman request from an EXISTING immutable CR-HM-01
 * channel attribution. The attribution is the ONLY authoritative
 * provenance/context handle: clientId, tenantCompanyId, tenantPicId,
 * buildingId, spaceId, originChannel and originReference are all derived
 * from the loaded attribution snapshot and are NEVER accepted as
 * independent caller input (any such fields in the request body are
 * ignored by contract). The attribution row itself is never mutated.
 *
 * Validation rules (frozen governance / PART 03 spec):
 * - the attribution must exist and the actor must be able to access its
 *   Client (accessible);
 * - the selected service must be ACTIVE and belong to the attribution
 *   Client (cross-client services rejected);
 * - the optional variant must belong to the selected service and the same
 *   Client, and must be ACTIVE;
 * - attribution spaceId (and tenantPicId) are preserved exactly — no
 *   fallback or fabricated PIC/user identity ever exists;
 * - exactly one request per attribution (pre-check + UNIQUE constraint).
 *
 * Only the initial INTAKE state exists. No triage/diagnosis/escalation,
 * no FM tenant-service-request creation or conversion, no evidence,
 * no quotation, no material execution, no operational/audit event
 * vocabulary (same restraint as CR-HM-01 PART 01 / CR-HM-02 PART 01–02).
 */

const ATTRIBUTION_UNIQUE_CONSTRAINT =
  'handyman_service_requests_channel_attribution_id_key';

function isAttributionUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate?.code === '23505' &&
    candidate?.constraint === ATTRIBUTION_UNIQUE_CONSTRAINT
  );
}

function toPublic(
  record: HandymanServiceRequestRecord,
): PublicHandymanServiceRequest {
  return {
    ...record,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function assertUuid(value: string | undefined, field: string): void {
  if (value === undefined || !isValidUuid(value)) {
    throw AppError.validation('Request intake validation failed.', [
      { field, message: `${field} must be a valid UUID.` },
    ]);
  }
}

export async function createHandymanServiceRequest(
  input: CreateHandymanServiceRequestInput,
  actorUserId: string,
): Promise<PublicHandymanServiceRequest> {
  assertUuid(input.channelAttributionId, 'channelAttributionId');
  assertUuid(input.serviceCatalogId, 'serviceCatalogId');
  if (input.serviceVariantId !== undefined) {
    assertUuid(input.serviceVariantId, 'serviceVariantId');
  }

  // 1) Authoritative provenance handle: attribution must exist and the
  //    actor must be able to access its derived Client.
  const attribution = await handymanChannelAttributionRepository.findById(
    input.channelAttributionId,
  );
  if (!attribution) throw handymanChannelAttributionNotFoundError();
  if (
    !(await contextAccessService.canAccessClient(
      actorUserId,
      attribution.clientId,
    ))
  ) {
    throw buildingAccessDeniedError();
  }

  // 2) Selected service: must exist, be ACTIVE (reference-master idiom),
  //    and belong to the attribution's Client — cross-client services are
  //    rejected.
  const service = await serviceCatalogRepository.findById(
    undefined,
    input.serviceCatalogId,
  );
  if (!service) throw serviceCatalogNotFoundError();
  if (service.status !== 'ACTIVE') throw serviceCatalogNotActiveError();
  if (service.clientId !== attribution.clientId) {
    throw handymanServiceRequestScopeMismatchError();
  }

  // 3) Optional variant: must belong to the selected service and the same
  //    Client, and must be ACTIVE.
  let variantId: string | null = null;
  if (input.serviceVariantId !== undefined) {
    const variant = await handymanServiceVariantRepository.findById(
      undefined,
      input.serviceVariantId,
    );
    if (!variant) throw handymanServiceVariantNotFoundError();
    if (
      variant.serviceCatalogId !== service.id ||
      variant.clientId !== attribution.clientId
    ) {
      throw handymanServiceRequestScopeMismatchError();
    }
    if (variant.status !== 'ACTIVE') {
      throw handymanServiceVariantNotActiveError();
    }
    variantId = variant.id;
  }

  // 4) One request per immutable attribution.
  const existing = await handymanServiceRequestRepository
    .findByChannelAttribution(undefined, attribution.id);
  if (existing) throw handymanServiceRequestAlreadyExistsError();

  // 5) Optional free description (bounded like sibling catalog text).
  let description: string | null = null;
  if (input.description !== undefined) {
    const trimmed = typeof input.description === 'string'
      ? input.description.trim()
      : '';
    if (trimmed.length < 1 || trimmed.length > 1000) {
      throw AppError.validation('Request intake validation failed.', [
        {
          field: 'description',
          message: 'description must be 1-1000 characters when provided.',
        },
      ]);
    }
    description = trimmed;
  }

  // 6) Immutable attribution-derived context snapshot (never mutated).
  try {
    const record = await handymanServiceRequestRepository.insertRequest(
      undefined,
      {
        clientId: attribution.clientId,
        channelAttributionId: attribution.id,
        tenantCompanyId: attribution.tenantCompanyId,
        tenantPicId: attribution.tenantPicId,
        buildingId: attribution.buildingId,
        spaceId: attribution.spaceId,
        serviceCatalogId: service.id,
        serviceVariantId: variantId,
        originChannel: attribution.originChannel,
        originReference: attribution.originReference,
        description,
        createdByUserId: attribution.createdByUserId,
      },
    );
    return toPublic(record);
  } catch (error) {
    if (isAttributionUniqueViolation(error)) {
      throw handymanServiceRequestAlreadyExistsError();
    }
    throw error;
  }
}

export const handymanServiceRequestService = {
  createHandymanServiceRequest,
};
