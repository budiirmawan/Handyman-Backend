import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  careAuthorityDeniedError,
} from '../handyman-care-authority';
import {
  createChannelAttribution,
} from '../handyman-channel-attributions';
import {
  createHandymanServiceRequestForAttribution,
  handymanServiceRequestNotFoundError,
} from '../handyman-requests';
import { executeHandymanIdempotent } from '../handyman-audit';
import { computeRequestFingerprint } from '../request-idempotency';
import { hasCurrentUnitPartyRole } from '../apartment-master';
import { handymanRequestPartyService } from '../handyman-request-parties';
import { handymanServiceVariantService } from '../handyman-catalog';
import { createHandymanSchedulingReadinessForIntake } from '../handyman-scheduling';
import { serviceCatalogService } from '../service-catalog';
import { handymanCareInternalNoteRepository } from './handyman-care-internal-note.repository';
import { tenantBuildingContextRepository } from '../tenant-building-contexts';
import { tenantCompanyRepository } from '../tenant-companies';
import { tenantVerificationRequiredError } from '../tenant-companies/tenant-company.errors';
import {
  handymanCareStandaloneDiscoveryRepository,
  type StandaloneCareFloorRecord,
  type StandaloneCareTenantRecord,
  type StandaloneCareUnitRecord,
} from './handyman-care-standalone-discovery.repository';
import { requireActiveAssignedBuilding } from './handyman-care-standalone-discovery.service';
import type { CreateBuildingCareRequestBody } from './handyman-care-tenant-request-gateway.validation';

/**
 * CR-HM-CC-TENANT-REQUEST-GATEWAY-01 — staff-assisted Tenant request
 * creation gateway (Backend Customer Care session, Authority A).
 *
 * WHAT THIS IS: the ONE create seam by which an authenticated CUSTOMER_CARE
 * staff member (Backend Bearer session + `handyman.care.building` + ACTIVE
 * assignment to the exact Building) creates the canonical Handyman Request
 * on behalf of an authorized Tenant/PIC. The result is the same
 * `handyman_service_requests` row Handyman Operations already discovers for
 * technical triage — there is no second request system, no
 * `tenant-companies/{id}/service-requests` substitute, no BM HMAC handoff
 * credential, no `hcw_` session and no Tenant impersonation.
 *
 * AUTHORITY CHAIN (all server-side, fail-closed):
 *   1. session actor -> `resolveBuildingCareAuthority` (ACTIVE user, exact
 *      ACTIVE Building assignment, dedicated `handyman.care.building`,
 *      Client derived from the actor's own Building -> Property -> Client
 *      chain, never from the request);
 *   2. active Client/Property/Building lineage for that Building;
 *   3. tenant scope: the represented Tenant Company must be ACTIVE, belong
 *      to the derived Client and hold an ACTIVE, currently-effective
 *      context in THIS Building — otherwise the single non-enumerating
 *      `HANDYMAN_CARE_AUTHORITY_DENIED` (403), identical for "unknown" and
 *      "wrong building" so the scope never enumerates foreign tenants;
 *   4. PIC/Unit/service identifiers are re-validated inside the creation
 *      transaction by the existing attribution + intake services (ACTIVE
 *      PIC of the tenant, ACTIVE tenant-space relationship in this
 *      Building, ACTIVE Client-owned catalogue entry/variant);
 *   5. `createdByUserId` is ALWAYS the authenticated session user. The
 *      represented Tenant/PIC persist on the immutable attribution as
 *      `tenantCompanyId`/`tenantPicId` — creator and represented customer
 *      are structurally distinct rows and the customer's linked user is
 *      never borrowed as the actor.
 *
 * SOURCE/AUDIT ATTRIBUTION: the immutable channel attribution is recorded
 * with the new `CUSTOMER_CARE_BACKEND` origin channel (migration 0455 —
 * proven widening of the frozen origin-channel map; BM rows keep
 * `BM_SUPER_APP`). No audit-event vocabulary is invented: request intake
 * stays event-free by frozen CR-HM-02 contract, and the attribution row IS
 * the creation audit trail (who acted, for whom, from which channel).
 *
 * IDEMPOTENCY: the generic `request-idempotency` law bound through the
 * Handyman `hm.*` operation namespace. Same actor + same `Idempotency-Key`
 * + same normalized submission -> one attribution + one request, replay
 * returns the stored 201 body; same key with a different submission ->
 * 409 IDEMPOTENCY_CONFLICT; every failure rolls the claim back with the
 * business writes, so no poisoned or partial record ever remains.
 */

/** Server-defined operation key for this create (hm.* namespace). */
export const CREATE_BUILDING_CARE_REQUEST_OPERATION_KEY =
  'hm.care.request.create';

type ProjectableRequest = {
  id: string;
  buildingId: string;
  spaceId: string | null;
  serviceCatalogId: string | null;
  serviceVariantId: string | null;
  description: string | null;
  status: string;
  createdAt: Date | string;
  updatedAt: Date | string;
};

/** Same allow-list as the PR #37 discovery projection — never the
 * canonical row wholesale (no Client/Tenant/PIC/creator/attribution ids). */
function projectCreatedRequest(request: ProjectableRequest) {
  const iso = (value: Date | string) =>
    value instanceof Date ? value.toISOString() : value;
  return {
    id: request.id,
    buildingId: request.buildingId,
    spaceId: request.spaceId,
    serviceCatalogId: request.serviceCatalogId,
    serviceVariantId: request.serviceVariantId,
    description: request.description,
    status: request.status,
    createdAt: iso(request.createdAt),
    updatedAt: iso(request.updatedAt),
  };
}

function isEffectiveNow(record: {
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
}): boolean {
  const now = Date.now();
  if (record.effectiveFrom && record.effectiveFrom.getTime() > now) {
    return false;
  }
  if (record.effectiveUntil && record.effectiveUntil.getTime() < now) {
    return false;
  }
  return true;
}

/** Authority + lineage + tenant scope for one Building-scoped create.
 * Fails closed with the single non-enumerating denial (403). */
async function resolveCreateScope(input: {
  actorUserId: string;
  buildingId: string;
  tenantCompanyId: string;
}) {
  const { authority, lineage } = await requireActiveAssignedBuilding(
    input.actorUserId,
    input.buildingId,
  );
  if (
    !lineage ||
    lineage.clientId !== authority.scope.clientId ||
    lineage.propertyId !== authority.scope.propertyId
  ) {
    throw careAuthorityDeniedError();
  }

  const company = await tenantCompanyRepository.findById(
    input.tenantCompanyId,
  );
  const context = company
    ? await tenantBuildingContextRepository.findActive(
        company.id,
        authority.scope.buildingId,
      )
    : null;
  if (
    !company ||
    company.status !== 'ACTIVE' ||
    company.clientId !== authority.scope.clientId ||
    !context ||
    !isEffectiveNow(context)
  ) {
    // Unknown tenant, cross-Client tenant and wrong-Building tenant are
    // indistinguishable by design (non-enumerating denial).
    throw careAuthorityDeniedError();
  }
  return { authority, lineage, company };
}

/**
 * CR-HM-MASTER-IND-01 — resolves the two independent commercial parties.
 *
 * Defaults are the represented Tenant (the pre-existing behavior). A party
 * that differs is accepted ONLY when it is an ACTIVE party of the same Client
 * AND either holds a currently-effective Unit role on the selected Unit or has
 * an ACTIVE, currently-effective Building context. Every failure collapses
 * into the same non-enumerating Care denial, so a caller cannot use this
 * selection to enumerate other tenants or Units.
 */
async function resolveDesignatedParties(input: {
  clientId: string;
  buildingId: string;
  representedTenantId: string;
  spaceId: string | null;
  approvalTenantCompanyId?: string;
  costResponsibleTenantCompanyId?: string;
}): Promise<{
  approvalTenantCompanyId: string;
  costResponsibleTenantCompanyId: string;
}> {
  const approval = input.approvalTenantCompanyId ?? input.representedTenantId;
  const costResponsibility =
    input.costResponsibleTenantCompanyId ?? input.representedTenantId;

  for (const partyId of new Set([approval, costResponsibility])) {
    // CR-HM-MASTER-TENANT-BATCH-01 — approval/billing authority requires a
    // VERIFIED party, including the represented-Tenant default. An unverified
    // temporary registration gets a precise 409 (never approval authority).
    const designated = await tenantCompanyRepository.findById(partyId);
    if (designated && designated.verificationStatus !== 'VERIFIED') {
      throw tenantVerificationRequiredError();
    }
    if (partyId === input.representedTenantId) continue;

    const company = await tenantCompanyRepository.findById(partyId);
    if (
      !company ||
      company.status !== 'ACTIVE' ||
      company.clientId !== input.clientId
    ) {
      throw careAuthorityDeniedError();
    }

    if (input.spaceId !== null) {
      const holdsUnitRole = await hasCurrentUnitPartyRole({
        clientId: input.clientId,
        buildingId: input.buildingId,
        unitId: input.spaceId,
        tenantCompanyId: partyId,
      });
      if (!holdsUnitRole) throw careAuthorityDeniedError();
    } else {
      const partyContext = await tenantBuildingContextRepository.findActive(
        partyId,
        input.buildingId,
      );
      if (!partyContext || !isEffectiveNow(partyContext)) {
        throw careAuthorityDeniedError();
      }
    }
  }

  return {
    approvalTenantCompanyId: approval,
    costResponsibleTenantCompanyId: costResponsibility,
  };
}

/**
 * Creates the canonical Handyman Request for the represented Tenant/PIC.
 * Returns the stored 201 payload plus `replayed` so the transport can keep
 * the idempotent contract truthful without reserializing anything else.
 */
export async function createBuildingCareRequest(input: {
  actorUserId: string;
  buildingId: string;
  idempotencyKey: string;
  body: CreateBuildingCareRequestBody;
}): Promise<{
  responseStatus: number;
  responseBody: unknown;
  replayed: boolean;
}> {
  // Scope validation BEFORE the claim: a denied submission never touches
  // the idempotency store at all.
  const { authority } = await resolveCreateScope({
    actorUserId: input.actorUserId,
    buildingId: input.buildingId,
    tenantCompanyId: input.body.tenantCompanyId,
  });

  // CR-HM-MASTER-IND-01 — approval and cost responsibility are resolved
  // BEFORE the idempotency claim, exactly like the tenant scope, so a denied
  // designation never touches the idempotency store.
  const parties = await resolveDesignatedParties({
    clientId: authority.scope.clientId,
    buildingId: authority.scope.buildingId,
    representedTenantId: input.body.tenantCompanyId,
    spaceId: input.body.spaceId ?? null,
    ...(input.body.approvalTenantCompanyId === undefined
      ? {}
      : { approvalTenantCompanyId: input.body.approvalTenantCompanyId }),
    ...(input.body.costResponsibleTenantCompanyId === undefined
      ? {}
      : {
        costResponsibleTenantCompanyId:
          input.body.costResponsibleTenantCompanyId,
      }),
  });

  const preferredWindow = input.body.preferredWindowStart !== undefined &&
      input.body.preferredWindowEnd !== undefined
    ? {
        start: input.body.preferredWindowStart,
        end: input.body.preferredWindowEnd,
      }
    : null;
  const normalized = {
    buildingId: authority.scope.buildingId,
    tenantCompanyId: input.body.tenantCompanyId,
    tenantPicId: input.body.tenantPicId ?? null,
    spaceId: input.body.spaceId ?? null,
    serviceCatalogId: input.body.serviceCatalogId ?? null,
    serviceVariantId: input.body.serviceVariantId ?? null,
    description: input.body.description ?? null,
    approvalTenantCompanyId: parties.approvalTenantCompanyId,
    costResponsibleTenantCompanyId: parties.costResponsibleTenantCompanyId,
    // Keep the legacy catalogue fingerprint byte-stable when the new
    // optional fields were not supplied; replay of pre-0481 keys still works.
    ...(input.body.internalNote === undefined
      ? {}
      : { internalNote: input.body.internalNote }),
    ...(preferredWindow === null
      ? {}
      : {
          preferredWindowStart: preferredWindow.start,
          preferredWindowEnd: preferredWindow.end,
        }),
  };
  const requestFingerprint = computeRequestFingerprint(normalized);

  const result = await executeHandymanIdempotent({
    actorUserId: input.actorUserId,
    operationKey: CREATE_BUILDING_CARE_REQUEST_OPERATION_KEY,
    idempotencyKey: input.idempotencyKey,
    requestFingerprint,
    work: async (client) => {
      // Immutable attribution first: represented Tenant/PIC from the
      // validated selection, acting identity = the authenticated staff
      // session user, source = the Backend Care channel. The attribution
      // service re-validates every reference inside this transaction.
      const attribution = await createChannelAttribution(
        {
          tenantCompanyId: normalized.tenantCompanyId,
          buildingId: normalized.buildingId,
          originChannel: 'CUSTOMER_CARE_BACKEND',
          createdByUserId: input.actorUserId,
          ...(normalized.tenantPicId === null
            ? {}
            : { tenantPicId: normalized.tenantPicId }),
          ...(normalized.spaceId === null ? {} : { spaceId: normalized.spaceId }),
        },
        client,
      );

      // Canonical request row: server-issued UUID + initial INTAKE state
      // from the shared intake insert; one-request-per-attribution wall
      // and exact-Building authority included.
      const request = await createHandymanServiceRequestForAttribution(
        {
          channelAttributionId: attribution.id,
          serviceCatalogId: normalized.serviceCatalogId,
          ...(normalized.serviceVariantId === null
            ? {}
            : { serviceVariantId: normalized.serviceVariantId }),
          ...(normalized.description === null
            ? {}
            : { description: normalized.description }),
        },
        input.actorUserId,
        client,
      );

      // CR-HM-MASTER-IND-01 — explicit customer-side designations, recorded
      // in the SAME transaction (and therefore the same idempotency claim) as
      // the canonical request. Creator and represented Tenant are unchanged.
      await handymanRequestPartyService.recordRequestParties(
        {
          clientId: attribution.clientId,
          requestId: request.id,
          actorUserId: input.actorUserId,
          approvalTenantCompanyId: normalized.approvalTenantCompanyId,
          costResponsibleTenantCompanyId:
            normalized.costResponsibleTenantCompanyId,
        },
        client,
      );

      // Reuse the existing scheduling-readiness PREFERENCE authority. This
      // writes no appointment and joins the same transaction/idempotency
      // claim as attribution + request + parties.
      if (preferredWindow !== null) {
        await createHandymanSchedulingReadinessForIntake(
          request,
          {
            preferredWindowStart: preferredWindow.start,
            preferredWindowEnd: preferredWindow.end,
          },
          input.actorUserId,
          client,
        );
      }

      // Dedicated Care-only INTERNAL fact. It never enters the canonical
      // request projection used by tenant-facing readers.
      if (normalized.internalNote !== undefined) {
        await handymanCareInternalNoteRepository.insertForIntake(client, {
          clientId: attribution.clientId,
          buildingId: attribution.buildingId,
          handymanRequestId: request.id,
          note: normalized.internalNote,
          createdByUserId: input.actorUserId,
        });
      }

      return {
        responseStatus: 201,
        responseBody: projectCreatedRequest(request),
      };
    },
  });

  return {
    responseStatus: result.responseStatus,
    responseBody: result.responseBody,
    replayed: result.replayed,
  };
}

/**
 * Tower -> Floor -> Unit / Tenant / catalogue readers.
 *
 * Each reader reuses `requireActiveAssignedBuilding` (Authority A +
 * lineage), then queries only by the Server-derived (clientId, buildingId)
 * pair. Tenant/Unit readers double as eligibility contracts: only ACTIVE,
 * currently-effective rows are returned, so anything the staff can select
 * here can be submitted to the create endpoint above.
 */

export async function listBuildingCareTenants(input: {
  actorUserId: string;
  buildingId: string;
}): Promise<StandaloneCareTenantRecord[]> {
  const { authority } = await requireActiveAssignedBuilding(
    input.actorUserId,
    input.buildingId,
  );
  return handymanCareStandaloneDiscoveryRepository.listBuildingCareTenants(
    authority.scope.clientId,
    authority.scope.buildingId,
  );
}

export async function listBuildingCareFloors(input: {
  actorUserId: string;
  buildingId: string;
}): Promise<StandaloneCareFloorRecord[]> {
  await requireActiveAssignedBuilding(input.actorUserId, input.buildingId);
  return handymanCareStandaloneDiscoveryRepository.listBuildingCareFloors(
    input.buildingId,
  );
}

export async function listBuildingCareUnits(input: {
  actorUserId: string;
  buildingId: string;
  tenantCompanyId: string;
  floorId?: string;
}): Promise<StandaloneCareUnitRecord[]> {
  if (!isValidUuid(input.tenantCompanyId)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'tenantCompanyId',
        message: 'tenantCompanyId must be a valid UUID.',
      },
    ]);
  }
  if (input.floorId !== undefined && !isValidUuid(input.floorId)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'floorId', message: 'floorId must be a valid UUID.' },
    ]);
  }
  // Same non-enumerating tenant-scope wall as the create endpoint: an
  // unknown or foreign tenant is rejected before any unit is disclosed.
  const { authority } = await resolveCreateScope({
    actorUserId: input.actorUserId,
    buildingId: input.buildingId,
    tenantCompanyId: input.tenantCompanyId,
  });
  return handymanCareStandaloneDiscoveryRepository.listBuildingCareUnits(
    authority.scope.clientId,
    authority.scope.buildingId,
    input.tenantCompanyId,
    input.floorId,
  );
}

/** Building-scoped ACTIVE service catalogue (+ ACTIVE Handyman variants)
 * for the Server-derived Client — same composition as the customer-facing
 * catalogue handler, reached through the Care Building authority instead
 * of a caller-supplied clientId. */
export async function listBuildingCareCatalogueServices(input: {
  actorUserId: string;
  buildingId: string;
}) {
  const { authority } = await requireActiveAssignedBuilding(
    input.actorUserId,
    input.buildingId,
  );
  const clientId = authority.scope.clientId;
  const entries = await serviceCatalogService.listServiceCatalogEntries(
    { clientId, status: 'ACTIVE' },
    input.actorUserId,
  );
  return Promise.all(
    entries.map(async (service) => ({
      service,
      variants: await handymanServiceVariantService.listHandymanServiceVariants(
        { clientId, serviceCatalogId: service.id, status: 'ACTIVE' },
        input.actorUserId,
      ),
    })),
  );
}

/**
 * CR-HM-MASTER-IND-01 — approval / cost-responsibility designations for one
 * request in the authorized Building. Same non-disclosure rule as the other
 * request-scoped Care reads: a request outside this Building/Client is a
 * standard 404, never an existence oracle.
 */
export async function listBuildingCareRequestParties(input: {
  actorUserId: string;
  buildingId: string;
  requestId: string;
}) {
  const { authority } = await requireActiveAssignedBuilding(
    input.actorUserId,
    input.buildingId,
  );
  const record =
    await handymanCareStandaloneDiscoveryRepository.findBuildingCareRequestById(
      authority.scope.clientId,
      authority.scope.buildingId,
      input.requestId,
    );
  if (!record) throw handymanServiceRequestNotFoundError();
  const parties = await handymanRequestPartyService.listRequestParties(
    record.id,
    authority.scope.clientId,
  );
  return {
    requestId: record.id,
    buildingId: record.buildingId,
    parties,
  };
}

import { getPool } from '../../database';
import { openHandymanCustomerTransaction } from '../handyman-customer-transactions';
import {
  handymanCustomerPaymentConflictError,
  recordHandymanCustomerPayment,
  type RecordHandymanCustomerPaymentInput,
} from '../handyman-customer-payments';
import { uploadExecutionScopePaymentProof } from '../handyman-payment-proof';
import { parseRecordCustomerPaymentBody } from '../handyman-customer-ledger-api/handyman-customer-ledger-api.validation';

/**
 * Exact-Building assertion for request-scoped Care reads (intake evidence).
 * Same non-disclosure as the discovery detail read: a request outside the
 * selected Building/Client is a standard 404, never an existence oracle.
 */
export async function assertBuildingCareRequest(input: {
  actorUserId: string;
  buildingId: string;
  requestId: string;
}): Promise<{ requestId: string; clientId: string; buildingId: string }> {
  const { authority } = await requireActiveAssignedBuilding(
    input.actorUserId,
    input.buildingId,
  );
  const record =
    await handymanCareStandaloneDiscoveryRepository.findBuildingCareRequestById(
      authority.scope.clientId,
      authority.scope.buildingId,
      input.requestId,
    );
  if (!record) throw handymanServiceRequestNotFoundError();
  return {
    requestId: record.id,
    clientId: authority.scope.clientId,
    buildingId: authority.scope.buildingId,
  };
}

async function resolveRequestExecutionScopeId(
  clientId: string,
  requestId: string,
): Promise<string> {
  const res = await getPool().query<{ id: string }>(
    `SELECT id
       FROM handyman_execution_scopes
      WHERE handyman_request_id = $1 AND client_id = $2
      ORDER BY created_at DESC LIMIT 1`,
    [requestId, clientId],
  );
  const scopeId = res.rows[0]?.id;
  if (!scopeId) {
    throw handymanCustomerPaymentConflictError(
      'execution-scope-not-authorized-for-request',
    );
  }
  return scopeId;
}

export async function reportBuildingCareRequestPayment(input: {
  actorUserId: string;
  buildingId: string;
  requestId: string;
  body: unknown;
}) {
  const { clientId } = await assertBuildingCareRequest({
    actorUserId: input.actorUserId,
    buildingId: input.buildingId,
    requestId: input.requestId,
  });
  const parsed = parseRecordCustomerPaymentBody(input.body);
  const executionScopeId = await resolveRequestExecutionScopeId(
    clientId,
    input.requestId,
  );

  const txCheck = await getPool().query<{ id: string }>(
    `SELECT id FROM handyman_customer_transactions WHERE execution_scope_id = $1`,
    [executionScopeId],
  );
  if (!txCheck.rows[0]) {
    await openHandymanCustomerTransaction(
      {
        executionScopeId,
        idempotencyKey: `care-open-tx:${executionScopeId}`,
      },
      input.actorUserId,
    );
  }

  const recordInput: RecordHandymanCustomerPaymentInput = {
    executionScopeId,
    amount: parsed.amount,
    channel: parsed.channel,
    obligationStage: parsed.obligationStage,
    providerName: parsed.providerName,
    providerReference: parsed.providerReference,
    externalReference: parsed.externalReference,
    idempotencyKey: parsed.idempotencyKey,
  };
  return recordHandymanCustomerPayment(recordInput, input.actorUserId);
}

export async function uploadBuildingCareRequestPaymentProof(input: {
  actorUserId: string;
  buildingId: string;
  requestId: string;
  paymentId: string;
  evidenceType: unknown;
  file: {
    buffer: Buffer;
    mimetype: string;
    originalname: string;
    size: number;
  };
}) {
  const { clientId } = await assertBuildingCareRequest({
    actorUserId: input.actorUserId,
    buildingId: input.buildingId,
    requestId: input.requestId,
  });
  const executionScopeId = await resolveRequestExecutionScopeId(
    clientId,
    input.requestId,
  );
  return uploadExecutionScopePaymentProof({
    executionScopeId,
    paymentId: input.paymentId,
    actorUserId: input.actorUserId,
    evidenceType: input.evidenceType,
    file: input.file,
  });
}
