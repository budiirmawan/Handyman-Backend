import { AppError } from '../../shared/errors';
import { resolveBuildingsForUser } from '../building-assignments';
import {
  assertBuildingCareActor,
  careAuthorityDeniedError,
  resolveBuildingCareAuthority,
} from '../handyman-care-authority';
import { getActiveDispatchRelease } from '../handyman-dispatch';
import { listHandymanQcRunsCustomerCareView } from '../handyman-evidence-qc';
import { getHandymanExecutionScopeBastCustomerCareView } from '../handyman-bast';
import {
  HANDYMAN_SERVICE_REQUEST_STATUSES,
  handymanServiceRequestNotFoundError,
  handymanServiceRequestInspectionService,
  handymanServiceRequestTriageService,
  handymanServiceRequestDiagnosisService,
} from '../handyman-requests';
import { getHandymanQuotation } from '../handyman-quotations';
import { listBuildingCareScopeVariationStatuses } from '../handyman-scope-variations';
import { getHandymanWorkSessionsCustomerCareView } from '../handyman-work-sessions';
import { listHandymanCustomerPayments } from '../handyman-customer-payments';
import { readExecutionScopeServiceWarrantyView } from '../handyman-service-warranty-api';
import {
  handymanCareStandaloneDiscoveryRepository,
  type StandaloneCareRequestFilters,
  type StandaloneCareRequestItemRecord,
  type StandaloneCareRequestPage,
  type StandaloneCareRequestRecord,
} from './handyman-care-standalone-discovery.repository';

export type BuildingCareRequestFilters = StandaloneCareRequestFilters;
export type BuildingCareRequestPage = StandaloneCareRequestPage;

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function isOptionalReadMissing(error: unknown): boolean {
  return error instanceof AppError && error.statusCode === 404;
}

async function readOptional<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (isOptionalReadMissing(error)) return null;
    throw error;
  }
}

function projectRequest(record: StandaloneCareRequestRecord) {
  return {
    id: record.id,
    buildingId: record.buildingId,
    spaceId: record.spaceId,
    serviceCatalogId: record.serviceCatalogId,
    serviceVariantId: record.serviceVariantId,
    description: record.description,
    status: record.status,
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
  };
}

/**
 * CR-HM-BE-CARE-CATALOG-STRUCTURED-01 PART 04 — allow-list projection of one
 * persisted ACTIVE structured item.
 *
 * Reported service items are NOT approved quotation lines: this projection
 * carries what was REPORTED (catalogue/variant identity, quantity, the
 * UOM the Care staff stated, free-text description, access condition and the
 * effective attribute facts with their inheritance provenance) and nothing
 * about price, approval or scheduling. An access condition is NOT a BM
 * clearance and an item is NOT a confirmed appointment.
 */
export function projectStandaloneCareRequestItem(
  record: StandaloneCareRequestItemRecord,
) {
  const inheritedAttributeValues = record.inheritedAttributeValues ?? {};
  return {
    id: record.id,
    serviceCatalogId: record.serviceCatalogId,
    serviceCode: record.serviceCode,
    serviceName: record.serviceName,
    serviceVariantId: record.serviceVariantId,
    serviceVariantCode: record.serviceVariantCode,
    serviceVariantName: record.serviceVariantName,
    quantity: record.quantity,
    uomId: record.uomId,
    uomCode: record.uomCode,
    uomName: record.uomName,
    uomSymbol: record.uomSymbol,
    itemDescription: record.itemDescription,
    accessCondition: record.accessCondition,
    attributeValues: record.attributeValues ?? {},
    inheritedAttributeValues,
    // The provenance statement: exactly which codes the variant supplied.
    inheritedAttributeCodes: Object.keys(inheritedAttributeValues).sort(),
    status: record.status,
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
  };
}

export async function requireActiveAssignedBuilding(
  actorUserId: string,
  buildingId: string,
) {
  const authority = await resolveBuildingCareAuthority({
    actorUserId,
    buildingId,
  });
  const lineage =
    await handymanCareStandaloneDiscoveryRepository.findActiveBuildingLineage(
      buildingId,
    );
  if (
    !lineage ||
    lineage.clientId !== authority.scope.clientId ||
    lineage.propertyId !== authority.scope.propertyId
  ) {
    // Keep inactive/missing ancestors and cross-scope lookups non-enumerating.
    throw careAuthorityDeniedError();
  }
  return { authority, lineage };
}

export async function listStandaloneCareBuildings(actorUserId: string) {
  await assertBuildingCareActor(actorUserId);
  const assigned = await resolveBuildingsForUser(actorUserId);
  const activeLineages =
    await handymanCareStandaloneDiscoveryRepository.listActiveBuildingLineages(
      assigned.map((context) => context.building.id),
    );
  const assignedByBuilding = new Map(
    assigned.map((context) => [context.building.id, context]),
  );
  return activeLineages
    .filter((lineage) => {
      const context = assignedByBuilding.get(lineage.id);
      return (
        context?.property?.id === lineage.propertyId &&
        context.client?.id === lineage.clientId
      );
    })
    .map((lineage) => ({
      id: lineage.id,
      code: lineage.code,
      name: lineage.name,
      property: {
        id: lineage.propertyId,
        code: lineage.propertyCode,
        name: lineage.propertyName,
      },
    }));
}

export async function listStandaloneCareRequests(input: {
  actorUserId: string;
  buildingId: string;
  filters: BuildingCareRequestFilters;
  page?: BuildingCareRequestPage;
}) {
  const { authority } = await requireActiveAssignedBuilding(
    input.actorUserId,
    input.buildingId,
  );
  const result =
    await handymanCareStandaloneDiscoveryRepository.listBuildingCareRequests(
      authority.scope.clientId,
      authority.scope.buildingId,
      input.filters,
      input.page,
    );
  return {
    items: result.items.map((record) => projectRequest(record)),
    ...(result.total === undefined ? {} : { total: result.total }),
  };
}

async function readOperationalProgress(input: {
  actorUserId: string;
  request: NonNullable<
    Awaited<
      ReturnType<
        typeof handymanCareStandaloneDiscoveryRepository.findBuildingCareRequestById
      >
    >
  >;
}) {
  const { actorUserId, request } = input;
  const [triage, inspection, diagnosis, quotation] = await Promise.all([
    readOptional(() =>
      handymanServiceRequestTriageService.getHandymanRequestTriage(
        request.id,
        actorUserId,
      ),
    ),
    readOptional(() =>
      handymanServiceRequestInspectionService.getHandymanRequestInspection(
        request.id,
        actorUserId,
      ),
    ),
    readOptional(() =>
      handymanServiceRequestDiagnosisService.getHandymanRequestDiagnosis(
        request.id,
        actorUserId,
      ),
    ),
    readOptional(() => getHandymanQuotation(request.id, actorUserId)),
  ]);

  const execution = request.executionScopeId
    ? await readExecutionProgress(actorUserId, request.executionScopeId)
    : null;

  return {
    triage: triage
      ? {
          disposition: triage.triageDisposition,
          recordedAt: iso(triage.createdAt),
        }
      : null,
    inspection: inspection
      ? {
          result: inspection.inspectionResult,
          inspectedAt: iso(inspection.inspectedAt),
        }
      : null,
    diagnosis: diagnosis
      ? {
          scopeClassification: diagnosis.scopeClassification,
          diagnosedAt: iso(diagnosis.diagnosedAt),
        }
      : null,
    quotation: quotation
      ? {
          versions: quotation.versions.map((version) => ({
            versionNumber: version.versionNumber,
            status: version.status,
            updatedAt: iso(version.updatedAt),
          })),
        }
      : null,
    execution,
  };
}

async function readExecutionProgress(
  actorUserId: string,
  executionScopeId: string,
) {
  const [variations, dispatch, workSessions, qcRuns, bast, payments, warranty] =
    await Promise.all([
      listBuildingCareScopeVariationStatuses(actorUserId, executionScopeId),
      getActiveDispatchRelease(executionScopeId, actorUserId),
      getHandymanWorkSessionsCustomerCareView(executionScopeId, actorUserId),
      listHandymanQcRunsCustomerCareView(executionScopeId, actorUserId),
      getHandymanExecutionScopeBastCustomerCareView(
        executionScopeId,
        actorUserId,
      ),
      readOptional(() =>
        listHandymanCustomerPayments(executionScopeId, actorUserId),
      ),
      readOptional(() =>
        readExecutionScopeServiceWarrantyView(actorUserId, executionScopeId),
      ),
    ]);

  return {
    scopeVariations: variations,
    dispatchRelease: dispatch
      ? {
          status: dispatch.status,
          releasedAt: iso(dispatch.releasedAt),
        }
      : null,
    workSessions: workSessions.sessions.map((item) => ({
      status: item.session.status,
    })),
    qualityControlRuns: qcRuns.map((view) => ({
      status: view.run.status,
      updatedAt: iso(view.run.updatedAt),
    })),
    bast: bast.bast
      ? {
          status: bast.bast.status,
          issuedAt: iso(bast.bast.issuedAt),
          acceptedAt: iso(bast.bast.acceptedAt),
          rejectedAt: iso(bast.bast.rejectedAt),
          voidedAt: iso(bast.bast.voidedAt),
        }
      : null,
    paymentStatuses:
      payments === null ? null : payments.map((payment) => payment.status),
    warranty:
      warranty === null
        ? null
        : {
            status: warranty.warranty.status,
            claimStatus: warranty.lifecycle.claimStatus,
            reworkStatus: warranty.lifecycle.reworkStatus,
            chargeableAdditionalWorkStatus:
              warranty.lifecycle.chargeableAdditionalWorkStatus,
          },
  };
}

export async function getStandaloneCareRequestDetail(input: {
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

  // PART 04 — persisted ACTIVE items of THIS proven request. The read is
  // keyed by the server-derived Client and the request id already proven to
  // belong to the authorized Building, so a sibling Building or a foreign
  // request can never contribute a row. The request and progress blocks are
  // unchanged; `items` is additive.
  const items =
    await handymanCareStandaloneDiscoveryRepository.listBuildingCareRequestItems(
      authority.scope.clientId,
      record.id,
    );

  return {
    request: projectRequest(record),
    items: items.map((item) => projectStandaloneCareRequestItem(item)),
    progress: await readOperationalProgress({
      actorUserId: input.actorUserId,
      request: record,
    }),
  };
}

export async function getStandaloneCareRequestProgress(input: {
  actorUserId: string;
  buildingId: string;
  requestId: string;
}) {
  const detail = await getStandaloneCareRequestDetail(input);
  return {
    requestId: detail.request.id,
    status: detail.request.status,
    progress: detail.progress,
  };
}

export function assertStandaloneCareRequestStatus(
  value: unknown,
): value is (typeof HANDYMAN_SERVICE_REQUEST_STATUSES)[number] {
  return (
    typeof value === 'string' &&
    (HANDYMAN_SERVICE_REQUEST_STATUSES as readonly string[]).includes(value)
  );
}
