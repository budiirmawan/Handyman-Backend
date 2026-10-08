import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { buildingAccessDeniedError, contextAccessService } from '../context-access';
import {
  handymanChannelAttributionNotFoundError,
  handymanChannelAttributionRepository,
  type HandymanChannelAttributionRecord,
} from '../handyman-channel-attributions';
import { bindCareHandoffExchangeInTransaction } from '../handyman-handoff/handoff-binding.service';
import { isCurrentCareRepresentation } from '../handyman-handoff/care-representation.service';
import { handoffExchangeInvalidError } from '../handyman-handoff/handoff-runtime.errors';
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
  handymanServiceRequestNotFoundError,
  handymanServiceRequestScopeMismatchError,
} from './handyman-service-request.errors';
import { handymanServiceRequestRepository } from './handyman-service-request.repository';
import {
  isHandymanServiceRequestStatus,
  type CreateHandymanServiceRequestInput,
  type HandymanCustomerCareServiceRequestRecord,
  type HandymanServiceRequestListFilters,
  type HandymanServiceRequestRecord,
  type PublicHandymanCustomerCareServiceRequest,
  type PublicHandymanServiceRequest,
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

export function toCustomerCarePublic(
  record: HandymanCustomerCareServiceRequestRecord,
): PublicHandymanCustomerCareServiceRequest {
  return {
    id: record.id,
    clientId: record.clientId,
    channelAttributionId: record.channelAttributionId,
    tenantCompanyId: record.tenantCompanyId,
    tenantPicId: record.tenantPicId,
    buildingId: record.buildingId,
    spaceId: record.spaceId,
    serviceCatalogId: record.serviceCatalogId,
    serviceVariantId: record.serviceVariantId,
    originChannel: record.originChannel,
    originReference: record.originReference,
    description: record.description,
    status: record.status,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    actorType: record.actorType,
    careActorId: record.careActorId,
    actorReference: record.actorReference,
    attribution: {
      id: record.channelAttributionId,
      originChannel: record.originChannel,
      originReference: record.originReference,
      createdByUserId: record.createdByUserId,
      actorType: record.actorType,
      careActorId: record.careActorId,
      actorReference: record.actorReference,
      createdAt: record.attributionCreatedAt.toISOString(),
    },
    executionScopeId: record.executionScopeId,
  };
}

function assertUuid(value: string | undefined, field: string): void {
  if (value === undefined || !isValidUuid(value)) {
    throw AppError.validation('Request intake validation failed.', [
      { field, message: `${field} must be a valid UUID.` },
    ]);
  }
}

type AttributionSnapshot = Pick<HandymanChannelAttributionRecord,
  'id' | 'clientId' | 'tenantCompanyId' | 'tenantPicId' | 'buildingId' |
  'spaceId' | 'originChannel' | 'originReference' | 'createdByUserId'>;

/** Shared catalogue, one-request-per-attribution and immutable snapshot rules.
 * The caller MUST authorize acting identity before entering this function. */
async function createFromAuthorizedAttribution(
  input: Omit<CreateHandymanServiceRequestInput, 'channelAttributionId'>,
  attribution: AttributionSnapshot,
  client?: PoolClient,
): Promise<PublicHandymanServiceRequest> {
  assertUuid(input.serviceCatalogId, 'serviceCatalogId');
  if (input.serviceVariantId !== undefined) {
    assertUuid(input.serviceVariantId, 'serviceVariantId');
  }
  // 2) Selected service: must exist, be ACTIVE (reference-master idiom),
  //    and belong to the attribution's Client — cross-client services are
  //    rejected.
  const service = await serviceCatalogRepository.findById(
    client,
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
      client,
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
    .findByChannelAttribution(client, attribution.id);
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
      client,
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
/** Existing local-User create path is unchanged in authority and input. */
export async function createHandymanServiceRequest(
  input: CreateHandymanServiceRequestInput,
  actorUserId: string,
): Promise<PublicHandymanServiceRequest> {
  assertUuid(input.channelAttributionId, 'channelAttributionId');
  assertUuid(input.serviceCatalogId, 'serviceCatalogId');
  if (input.serviceVariantId !== undefined) {
    assertUuid(input.serviceVariantId, 'serviceVariantId');
  }
  const attribution = await handymanChannelAttributionRepository.findById(
    input.channelAttributionId,
  );
  if (!attribution) throw handymanChannelAttributionNotFoundError();
  if (!(await contextAccessService.canAccessClient(actorUserId, attribution.clientId))) {
    throw buildingAccessDeniedError();
  }
  return createFromAuthorizedAttribution(input, attribution);
}

/**
 * PART 04: atomic care-only exchange -> immutable attribution -> request.
 * The opaque, signed-handoff-issued, single-use exchange token is the sole
 * acting credential. A public attribution ID or PIC-linked User is not one.
 * The existing binding/occupancy/property checks run before attribution and
 * again before request insertion; any failure rolls back all three writes.
 */
export async function createCareHandymanServiceRequest(
  input: { exchangeToken: string } & Omit<CreateHandymanServiceRequestInput, 'channelAttributionId'>,
): Promise<PublicHandymanServiceRequest> {
  if (typeof input?.exchangeToken !== 'string' || input.exchangeToken.length === 0) {
    throw handoffExchangeInvalidError();
  }
  return withTransaction(async (client) => {
    const { attribution, exchange } = await bindCareHandoffExchangeInTransaction(
      input.exchangeToken, client,
    );
    if (attribution.actorType !== 'CUSTOMER_CARE' ||
        !attribution.careActorId || attribution.createdByUserId !== null ||
        attribution.careActorId !== exchange.careActorId ||
        !(await isCurrentCareRepresentation(exchange, client))) {
      throw handoffExchangeInvalidError();
    }
    return createFromAuthorizedAttribution(input, attribution, client);
  });
}

/**
 * Bounded request list: retain the existing Client + tenant_company.read wall,
 * then apply the C6 represented-customer/occupancy or explicitly assigned
 * PLATFORM_ADMIN historical-read wall to every row in the repository query.
 */
export async function listHandymanServiceRequests(
  filters: HandymanServiceRequestListFilters,
  actorUserId: string,
): Promise<PublicHandymanCustomerCareServiceRequest[]> {
  assertUuid(filters.clientId, 'clientId');
  if (filters.tenantCompanyId !== undefined) {
    assertUuid(filters.tenantCompanyId, 'tenantCompanyId');
  }
  if (filters.buildingId !== undefined) {
    assertUuid(filters.buildingId, 'buildingId');
  }
  if (filters.spaceId !== undefined) {
    assertUuid(filters.spaceId, 'spaceId');
  }
  if (filters.channelAttributionId !== undefined) {
    assertUuid(filters.channelAttributionId, 'channelAttributionId');
  }
  if (
    filters.status !== undefined &&
    !isHandymanServiceRequestStatus(filters.status)
  ) {
    throw AppError.validation('Request query validation failed.', [
      {
        field: 'status',
        message: 'status is not a recognized Handyman request status.',
      },
    ]);
  }

  if (
    !(await contextAccessService.canAccessClient(actorUserId, filters.clientId))
  ) {
    throw buildingAccessDeniedError();
  }

  const records =
    await handymanServiceRequestRepository.listCustomerCareProjectionsScoped(
      undefined,
      filters,
      actorUserId,
    );
  return records.map(toCustomerCarePublic);
}

/** C6 detail read: check existence/Client as before, then perform the
 * authorized projection in one SQL statement with the occupancy/role wall. */
export async function getHandymanServiceRequestDetail(
  handymanRequestId: string,
  actorUserId: string,
): Promise<PublicHandymanCustomerCareServiceRequest> {
  assertUuid(handymanRequestId, 'handymanRequestId');

  const request = await handymanServiceRequestRepository.findById(
    undefined, handymanRequestId,
  );
  if (!request) throw handymanServiceRequestNotFoundError();
  if (!(await contextAccessService.canAccessClient(actorUserId, request.clientId))) {
    throw buildingAccessDeniedError();
  }
  const record = await handymanServiceRequestRepository.findCustomerCareProjectionById(
    undefined, handymanRequestId, actorUserId,
  );
  if (!record) throw buildingAccessDeniedError();
  return toCustomerCarePublic(record);
}

export const handymanServiceRequestService = {
  createHandymanServiceRequest,
  createCareHandymanServiceRequest,
  listHandymanServiceRequests,
  getHandymanServiceRequestDetail,
};
