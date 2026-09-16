import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { contextAccessService } from '../context-access';
import { isValidUuid } from '../clients';
import {
  handymanRequestNotFoundError,
  handymanRequestRepository,
} from '../handyman-requests';
import { isHandymanServiceCategory } from '../handyman-providers';
import { recordOperationalEvent } from '../operational-events';
import {
  serviceCatalogNotFoundError,
  serviceCatalogNotActiveError,
  serviceCatalogRepository,
} from '../service-catalog';
import {
  handymanRequestServiceAlreadyActiveError,
  handymanRequestServiceClientMismatchError,
  handymanRequestServiceNotFoundError,
  handymanRequestServiceNotHandymanError,
  handymanRequestServiceSourceInvalidError,
  handymanRequestServiceStateInvalidError,
  handymanRequestTriageNotAllowedError,
} from './handyman-request-governance.errors';
import type {
  HandymanGovernanceRowStatus,
  HandymanRequestServiceRecord,
  PublicHandymanRequestService,
  SelectHandymanRequestServiceInput,
} from './handyman-request-governance.types';
import { handymanInspectionRepository } from './handyman-inspection.repository';
import { handymanRequestTriageRepository } from './handyman-request-triage.repository';
import { handymanServiceSelectionRepository } from './handyman-service-selection.repository';

/**
 * CR-HM-BE-03 RUN 1 — Governed request↔service selection authority.
 *
 * The FIRST authoritative binding between a handyman request and the
 * existing CR-BE-SVC-01 `service_catalog`. Selection is only valid through
 * the governed lifecycle:
 * - source TRIAGE: the request's ACTIVE triage path is QUOTATION and the
 *   request is TRIAGED;
 * - source INSPECTION: the ACTIVE triage path is INSPECTION, the request is
 *   INSPECTION_COMPLETED, and a COMPLETED inspection exists.
 *
 * Validity rules (fail closed): the catalog entry must exist, be ACTIVE,
 * belong to the request's Client (also proven structurally by the composite
 * scope FK), and match the centralized CR-HM-BE-02 HANDYMAN category
 * convention. Request title/description free text is never parsed into
 * service authority. One ACTIVE row per (request, service); multiple
 * distinct services may be ACTIVE; superseded history is preserved.
 */

const UNIQUE_VIOLATION = '23505';
const ONE_ACTIVE_SELECTION_CONSTRAINT =
  'handyman_request_services_one_active_per_request_service';

function isOneActiveSelectionViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { code?: string }).code === UNIQUE_VIOLATION &&
    (error as { constraint?: string }).constraint === ONE_ACTIVE_SELECTION_CONSTRAINT
  );
}

function toPublicSelection(
  record: HandymanRequestServiceRecord,
): PublicHandymanRequestService {
  return {
    id: record.id,
    requestId: record.requestId,
    clientId: record.clientId,
    buildingId: record.buildingId,
    serviceCatalogId: record.serviceCatalogId,
    source: record.source,
    status: record.status,
    selectedByUserId: record.selectedByUserId,
    selectedAt: record.selectedAt.toISOString(),
    supersededAt: record.supersededAt ? record.supersededAt.toISOString() : null,
    supersededByUserId: record.supersededByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

async function loadRequestOrThrow(
  requestId: string,
  actorUserId: string,
  tx: Pick<PoolClient, 'query'>,
) {
  const request = await handymanRequestRepository.findById(requestId, tx);
  if (!request) throw handymanRequestNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, request.buildingId);
  return request;
}

export async function selectHandymanRequestService(
  input: SelectHandymanRequestServiceInput,
  actorUserId: string,
): Promise<PublicHandymanRequestService> {
  return withTransaction(async (tx) => {
    const request = await loadRequestOrThrow(input.requestId, actorUserId, tx);

    const activeTriage = await handymanRequestTriageRepository.findActiveByRequest(
      request.id,
      tx,
    );
    if (!activeTriage) {
      throw handymanRequestTriageNotAllowedError(
        'The handyman request must be triaged before services can be selected.',
      );
    }

    // Source guards: the selection source must match the governed lifecycle.
    if (input.source === 'TRIAGE') {
      if (activeTriage.path !== 'QUOTATION' || request.status !== 'TRIAGED') {
        throw handymanRequestServiceSourceInvalidError(
          'TRIAGE-source selections require an ACTIVE QUOTATION triage path and a TRIAGED request.',
        );
      }
    } else {
      const completed = await handymanInspectionRepository.countCompletedByRequest(
        request.id,
        tx,
      );
      if (
        activeTriage.path !== 'INSPECTION' ||
        request.status !== 'INSPECTION_COMPLETED' ||
        completed === 0
      ) {
        throw handymanRequestServiceSourceInvalidError(
          'INSPECTION-source selections require an ACTIVE INSPECTION triage path and a completed inspection.',
        );
      }
    }

    // Catalog validity: existence, ACTIVE status, same client, HANDYMAN
    // category (centralized CR-HM-BE-02 convention — never free text).
    if (!isValidUuid(input.serviceCatalogId)) {
      throw serviceCatalogNotFoundError();
    }
    const service = await serviceCatalogRepository.findById(tx, input.serviceCatalogId);
    if (!service) throw serviceCatalogNotFoundError();
    if (service.status !== 'ACTIVE') throw serviceCatalogNotActiveError();
    if (service.clientId !== request.clientId) {
      throw handymanRequestServiceClientMismatchError();
    }
    if (!isHandymanServiceCategory(service.category)) {
      throw handymanRequestServiceNotHandymanError();
    }

    const existing =
      await handymanServiceSelectionRepository.findActiveByRequestAndService(
        request.id,
        service.id,
        tx,
      );
    if (existing) throw handymanRequestServiceAlreadyActiveError();

    let created: HandymanRequestServiceRecord;
    try {
      created = await handymanServiceSelectionRepository.create(
        {
          requestId: request.id,
          clientId: request.clientId,
          buildingId: request.buildingId,
          serviceCatalogId: service.id,
          source: input.source,
          selectedByUserId: actorUserId,
        },
        tx,
      );
    } catch (error) {
      if (isOneActiveSelectionViolation(error)) {
        throw handymanRequestServiceAlreadyActiveError();
      }
      throw error;
    }

    await recordOperationalEvent(
      {
        clientId: request.clientId,
        buildingId: request.buildingId,
        eventType: 'HANDYMAN_REQUEST_SERVICE_SELECTED',
        entityType: 'HANDYMAN_REQUEST_SERVICE',
        entityId: created.id,
        actorUserId,
        summary: `Service ${service.code} selected for handyman request ${request.requestNumber} (${input.source}).`,
        metadata: {
          requestNumber: request.requestNumber,
          requestId: request.id,
          serviceCatalogId: service.id,
          serviceCode: service.code,
          source: input.source,
        },
      },
      tx,
    );

    return toPublicSelection(created);
  });
}

export async function supersedeHandymanRequestServiceSelection(
  selectionId: string,
  actorUserId: string,
): Promise<PublicHandymanRequestService> {
  return withTransaction(async (tx) => {
    const selection = await handymanServiceSelectionRepository.findById(
      selectionId,
      tx,
    );
    if (!selection) throw handymanRequestServiceNotFoundError();
    const request = await loadRequestOrThrow(selection.requestId, actorUserId, tx);

    const superseded = await handymanServiceSelectionRepository.supersedeActive(
      selection.id,
      actorUserId,
      tx,
    );
    if (!superseded) {
      throw handymanRequestServiceStateInvalidError(
        'The service selection is already superseded.',
      );
    }

    await recordOperationalEvent(
      {
        clientId: request.clientId,
        buildingId: request.buildingId,
        eventType: 'HANDYMAN_REQUEST_SERVICE_SUPERSEDED',
        entityType: 'HANDYMAN_REQUEST_SERVICE',
        entityId: superseded.id,
        actorUserId,
        summary: `Service selection superseded for handyman request ${request.requestNumber}.`,
        metadata: {
          requestNumber: request.requestNumber,
          requestId: request.id,
          serviceCatalogId: superseded.serviceCatalogId,
        },
      },
      tx,
    );

    return toPublicSelection(superseded);
  });
}

export async function getHandymanRequestService(
  selectionId: string,
  actorUserId: string,
): Promise<PublicHandymanRequestService> {
  const selection = await handymanServiceSelectionRepository.findById(selectionId);
  if (!selection) throw handymanRequestServiceNotFoundError();
  await loadRequestOrThrow(selection.requestId, actorUserId, getPool());
  return toPublicSelection(selection);
}

export async function listHandymanRequestServices(
  requestId: string,
  actorUserId: string,
  filters: { status?: HandymanGovernanceRowStatus } = {},
): Promise<PublicHandymanRequestService[]> {
  return withTransaction(async (tx) => {
    await loadRequestOrThrow(requestId, actorUserId, tx);
    const rows = await handymanServiceSelectionRepository.listByRequest(
      requestId,
      filters,
      tx,
    );
    return rows.map(toPublicSelection);
  });
}

export const handymanServiceSelectionService = {
  getHandymanRequestService,
  listHandymanRequestServices,
  selectHandymanRequestService,
  supersedeHandymanRequestServiceSelection,
};
