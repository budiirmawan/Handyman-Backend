import { createInitialCareSchedulingReadiness, parseOptionalHandymanRequestedWindow } from '../handyman-scheduling/handyman-scheduling.service';
import type { OptionalHandymanRequestedWindow } from '../handyman-scheduling/handyman-scheduling.types';
import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  assertBuildingScopedResourceAccess,
  buildingAccessDeniedError,
  contextAccessService,
} from '../context-access';
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
  type HandymanServiceRequestPageOptions,
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
/**
 * Existing local-User create path: BE-02G exact-Building authority on
 * the attribution's server-resolved client/building (PART 06I); the
 * input is unchanged.
 */
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
    undefined,
    input.channelAttributionId,
  );
  if (!attribution) throw handymanChannelAttributionNotFoundError();
  // CR-HM-SEC-01 PART 06I — BE-02G exact-Building check on the
  // attribution's authoritative server-resolved client/building pair
  // (the attribution snapshot is the sole authority; the create input
  // never carries a buildingId — caller-supplied context keys are
  // ignored by contract), replacing the client-level canAccessClient
  // shortcut: a same-Client sibling Building assignment must not
  // create an intake request. The denial vocabulary (403
  // BUILDING_ACCESS_DENIED — the guard's own thrower) and the wall's
  // position (after the attribution 404, before validation, the
  // one-request-per-attribution uniqueness check and insertion) are
  // unchanged. This is the LOCAL-USER create path only; the BM
  // Customer Care exchange-token intake (createCareHandymanServiceRequest)
  // is a separate function and is NOT altered.
  await assertBuildingScopedResourceAccess(actorUserId, {
    clientId: attribution.clientId,
    buildingId: attribution.buildingId,
  });
  return createFromAuthorizedAttribution(input, attribution);
}

/**
 * CR-HM-CC-TENANT-REQUEST-GATEWAY-01 — transactional create from an ALREADY
 * authorized attribution row.
 *
 * The Backend Customer Care staff gateway creates the immutable attribution
 * and the canonical request inside ONE caller-owned transaction (the generic
 * idempotency claim transaction). This helper performs the same frozen
 * PART 03 rules as the local-User path — exact-Building authority for the
 * acting staff user (BE-02G), shared catalogue/variant validation, the
 * one-request-per-attribution uniqueness wall and the INTAKE insert — but
 * accepts an existing transaction client so attribution + request commit or
 * roll back together. It invents no second persistence path: the request row,
 * its server-issued UUID and its initial `INTAKE` state come from the same
 * `insertRequest` used by every other intake seam.
 */
export async function createHandymanServiceRequestForAttribution(
  input: CreateHandymanServiceRequestInput & OptionalHandymanRequestedWindow,
  actorUserId: string,
  client: PoolClient,
): Promise<PublicHandymanServiceRequest> {
  assertUuid(input.channelAttributionId, 'channelAttributionId');
  assertUuid(input.serviceCatalogId, 'serviceCatalogId');
  if (input.serviceVariantId !== undefined) {
    assertUuid(input.serviceVariantId, 'serviceVariantId');
  }
  const attribution = await handymanChannelAttributionRepository.findById(
    client,
    input.channelAttributionId,
  );
  if (!attribution) throw handymanChannelAttributionNotFoundError();
  await assertBuildingScopedResourceAccess(actorUserId, {
    clientId: attribution.clientId,
    buildingId: attribution.buildingId,
  });
  const request = await createFromAuthorizedAttribution(input, attribution, client);
  return attachInitialCarePreference(client, request, input);
}

async function attachInitialCarePreference(
  client: PoolClient, request: PublicHandymanServiceRequest, input: OptionalHandymanRequestedWindow,
): Promise<PublicHandymanServiceRequest> {
  const dates = parseOptionalHandymanRequestedWindow(input.preferredWindowStart, input.preferredWindowEnd);
  if (!dates) return request; // Preserve the exact legacy no-date response/write set.
  const row = await createInitialCareSchedulingReadiness(client, request.id, dates);
  const { id, timezone, preferredWindowStart, preferredWindowEnd, status, supersedesReadinessId } = row;
  return { ...request, schedulingReadiness: { id, timezone, preferredWindowStart, preferredWindowEnd, status, supersedesReadinessId } };
}

/**
 * PART 04: atomic care-only exchange -> immutable attribution -> request.
 * The opaque, signed-handoff-issued, single-use exchange token is the sole
 * acting credential. A public attribution ID or PIC-linked User is not one.
 * The existing binding/occupancy/property checks run before attribution and
 * again before request insertion; any failure rolls back all three writes.
 */
export async function createCareHandymanServiceRequest(
  input: { exchangeToken: string } & Omit<CreateHandymanServiceRequestInput, 'channelAttributionId'> & OptionalHandymanRequestedWindow,
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
    const request = await createFromAuthorizedAttribution(input, attribution, client);
    return attachInitialCarePreference(client, request, input);
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

/**
 * Read one bounded Customer Care page for the Operations queue adapter.
 * This deliberately reuses the existing Client/tenant_company.read and
 * per-row C6 occupancy/PLATFORM_ADMIN SQL wall. A supplied Building is
 * additionally checked against the actor's exact Client + Building assignment
 * before querying, so a same-Client sibling Building is denied (BE-02G).
 */
export async function listHandymanServiceRequestsPage(
  filters: HandymanServiceRequestListFilters,
  page: HandymanServiceRequestPageOptions,
  actorUserId: string,
): Promise<{
  items: PublicHandymanCustomerCareServiceRequest[];
  hasMore: boolean;
}> {
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
  if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 100) {
    throw AppError.validation('Request query validation failed.', [
      { field: 'limit', message: 'limit must be an integer between 1 and 100.' },
    ]);
  }
  if (!Number.isInteger(page.offset) || page.offset < 0 || page.offset > 10000) {
    throw AppError.validation('Request query validation failed.', [
      { field: 'offset', message: 'offset must be an integer between 0 and 10000.' },
    ]);
  }

  if (filters.buildingId !== undefined) {
    await assertBuildingScopedResourceAccess(actorUserId, {
      clientId: filters.clientId,
      buildingId: filters.buildingId,
    });
  }
  if (!(await contextAccessService.canAccessClient(actorUserId, filters.clientId))) {
    throw buildingAccessDeniedError();
  }

  const records =
    await handymanServiceRequestRepository.listCustomerCareProjectionsScoped(
      undefined,
      filters,
      actorUserId,
      { limit: page.limit + 1, offset: page.offset },
    );
  const hasMore = records.length > page.limit;
  return {
    items: records.slice(0, page.limit).map(toCustomerCarePublic),
    hasMore,
  };
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
  // CR-HM-SEC-01 PART 02: BE-02G building-scope guard over the request's
  // own building_id (no same-Client shortcut). The C6 represented-customer
  // SQL wall below is unchanged and stays the per-row authority.
  await assertBuildingScopedResourceAccess(actorUserId, {
    clientId: request.clientId,
    buildingId: request.buildingId,
  });
  const record = await handymanServiceRequestRepository.findCustomerCareProjectionById(
    undefined, handymanRequestId, actorUserId,
  );
  if (!record) throw buildingAccessDeniedError();
  return toCustomerCarePublic(record);
}

export const handymanServiceRequestService = {
  createHandymanServiceRequest,
  createHandymanServiceRequestForAttribution,
  createCareHandymanServiceRequest,
  listHandymanServiceRequests,
  listHandymanServiceRequestsPage,
  getHandymanServiceRequestDetail,
};
