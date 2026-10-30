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
  type StandaloneCareRequestPage,
  type StandaloneCareRequestRecord,
} from './handyman-care-standalone-discovery.repository';
import { handymanParameterizedCatalogRepository } from '../handyman-parameterized-catalog/handyman-parameterized-catalog.repository';

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

  // CR-HM-BE-CARE-CATALOG-STRUCTURED-01 — authoritative structured-item
  // readback for the authorized Building: the PERSISTED ACTIVE items of
  // this request (quantity, reported UOM, per-item note, effective
  // attributes and the inherited provenance), read through the same
  // Building/Client authority that resolved the parent request. REMOVED
  // items stay invisible here, exactly as in the quotation scope.
  const items = await handymanParameterizedCatalogRepository.listRequestItems(
    undefined,
    authority.scope.clientId,
    record.id,
    'ACTIVE',
  );

  return {
    request: projectRequest(record),
    items: items.map((item) => ({
      id: item.id,
      serviceCatalogId: item.serviceCatalogId,
      serviceVariantId: item.serviceVariantId,
      quantity: item.quantity,
      uomId: item.uomId,
      itemDescription: item.itemDescription,
      attributeValues: item.attributeValues,
      inheritedAttributeValues: item.inheritedAttributeValues,
      accessCondition: item.accessCondition,
      status: item.status,
      createdAt: iso(item.createdAt),
      updatedAt: iso(item.updatedAt),
    })),
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
