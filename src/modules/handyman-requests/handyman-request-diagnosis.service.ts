import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { withTransaction } from '../../database';
import { buildingAccessDeniedError, contextAccessService } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { handymanDisciplineRepository } from '../handyman-disciplines';
import { serviceCatalogRepository } from '../service-catalog';
import { handymanServiceRequestRepository } from './handyman-service-request.repository';
import { handymanRequestDiagnosisRepository } from './handyman-request-diagnosis.repository';
import {
  handymanDiagnosisRecommendationInvalidError,
  handymanServiceRequestAlreadyDiagnosedError,
  handymanServiceRequestNotInDiagnosisError,
} from './handyman-request-diagnosis.errors';
import { handymanServiceRequestNotFoundError } from './handyman-request-triage.errors';
import {
  handymanDisciplineInvalidError,
} from '../handyman-disciplines';
import {
  SCOPE_CLASS_TO_CLASSIFICATION,
  SCOPE_CLASS_TO_REQUEST_STATUS,
  type CreateHandymanDiagnosisInput,
  type HandymanRequestDiagnosisRecord,
  type PublicHandymanRequestDiagnosis,
} from './handyman-request-diagnosis.types';

/**
 * CR-HM-03 PART 03 — Handyman diagnosis + scope authority service
 * (FROZEN F1/F2/F4/F5/F6/F7/F9).
 *
 * Bounded: request must be in DIAGNOSIS (reachable through either the
 * direct triage path or the inspection path); the classification and the
 * projection are SERVER-DERIVED from discipline.scopeClass — a caller can
 * never independently choose/override one. Records are append-only
 * (trigger + no mutation surface).
 *
 * Boundaries: Diagnosis != Quotation; Classification != Provider
 * Assignment; SPECIALIST_REQUIRED != a referral record (PART 04 owns
 * referral persistence); OUT_OF_HANDYMAN_SCOPE != FM workflow.
 */

const DIAGNOSIS_UNIQUE_CONSTRAINT = 'handyman_request_diagnoses_request_unique';

function isDiagnosisUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate?.code === '23505' &&
    candidate?.constraint === DIAGNOSIS_UNIQUE_CONSTRAINT
  );
}

function toPublic(
  record: HandymanRequestDiagnosisRecord,
): PublicHandymanRequestDiagnosis {
  return { ...record, diagnosedAt: record.diagnosedAt.toISOString() };
}

/** Record the diagnosis and project the derived bounded F1 state atomically. */
export async function recordHandymanDiagnosis(
  input: CreateHandymanDiagnosisInput,
  actorUserId: string,
): Promise<PublicHandymanRequestDiagnosis> {
  if (!isValidUuid(input.handymanRequestId)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'handymanRequestId',
        message: 'handymanRequestId must be a valid UUID.',
      },
    ]);
  }
  if (!isValidUuid(input.disciplineId)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'disciplineId', message: 'disciplineId must be a valid UUID.' },
    ]);
  }
  if (!isValidUuid(actorUserId)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'actorUserId', message: 'actorUserId must be a valid local user UUID.' },
    ]);
  }
  if (
    input.recommendedServiceCatalogId != null &&
    !isValidUuid(input.recommendedServiceCatalogId)
  ) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'recommendedServiceCatalogId',
        message: 'recommendedServiceCatalogId must be a valid UUID when present.',
      },
    ]);
  }
  const diagnosisText =
    typeof input.diagnosis === 'string' ? input.diagnosis.trim() : '';
  if (diagnosisText.length < 1 || diagnosisText.length > 1000) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'diagnosis',
        message: 'diagnosis is required (1-1000 characters).',
      },
    ]);
  }

  try {
    return await withTransaction(async (tx) => {
      // 1) Lock the parent for the decision chain.
      const request = await handymanServiceRequestRepository.lockById(
        tx,
        input.handymanRequestId,
      );
      if (!request) throw handymanServiceRequestNotFoundError();

      // 2) Frozen F1 source-state gate.
      if (request.status !== 'DIAGNOSIS') {
        throw handymanServiceRequestNotInDiagnosisError();
      }

      // 3) Realm authority: existing accessible-Client convention over the
      //    request-derived scope (never caller-shaped context).
      if (
        !(await contextAccessService.canAccessClient(
          actorUserId,
          request.clientId,
        ))
      ) {
        throw buildingAccessDeniedError();
      }

      // 4) F9 authority check: the referenced discipline is the scope root.
      const discipline = await handymanDisciplineRepository.findDisciplineById(
        tx,
        input.disciplineId,
      );
      if (!discipline || discipline.status !== 'ACTIVE') {
        throw handymanDisciplineInvalidError();
      }
      const scopeClassification =
        SCOPE_CLASS_TO_CLASSIFICATION[discipline.scopeClass];
      const nextStatus = SCOPE_CLASS_TO_REQUEST_STATUS[discipline.scopeClass];

      // 5) Optional catalogue recommendation: ACTIVE + same-Client +
      //    associated with the SELECTED F9 discipline. The free-text
      //    service_catalog.category is never consulted as authority.
      if (input.recommendedServiceCatalogId != null) {
        const catalog = await serviceCatalogRepository.findById(
          tx,
          input.recommendedServiceCatalogId,
        );
        if (
          !catalog ||
          catalog.status !== 'ACTIVE' ||
          catalog.clientId !== request.clientId
        ) {
          throw handymanDiagnosisRecommendationInvalidError();
        }
        const association =
          await handymanDisciplineRepository.findAssociationByCatalog(
            tx,
            input.recommendedServiceCatalogId,
          );
        if (!association || association.handymanDisciplineId !== discipline.id) {
          throw handymanDiagnosisRecommendationInvalidError();
        }
      }

      // 6) F2 pre-check; UNIQUE constrains races to the SAME 409 contract.
      const existing = await handymanRequestDiagnosisRepository.findByRequest(
        tx,
        request.id,
      );
      if (existing) throw handymanServiceRequestAlreadyDiagnosedError();

      // 7) Append the minimum immutable diagnosis decision.
      const record = await handymanRequestDiagnosisRepository.insertDiagnosis(
        tx,
        {
          clientId: request.clientId,
          handymanRequestId: request.id,
          channelAttributionId: request.channelAttributionId,
          buildingId: request.buildingId,
          handymanDisciplineId: discipline.id,
          disciplineCode: discipline.code,
          diagnosis: diagnosisText,
          scopeClassification,
          recommendedServiceCatalogId:
            input.recommendedServiceCatalogId ?? null,
          diagnosedByUserId: actorUserId,
        },
      );

      // 8) Derived F1 projection (READY_FOR_NEXT_STEP or terminal REFERRED).
      const projected = await handymanServiceRequestRepository.updateStatus(
        tx,
        request.id,
        nextStatus,
      );
      if (!projected) throw handymanServiceRequestNotFoundError();

      // 9) FROZEN F6 journal row — SAME executor; history only.
      await recordOperationalEvent(
        {
          clientId: request.clientId,
          eventType: 'HANDYMAN_DIAGNOSIS_RECORDED',
          entityType: 'HANDYMAN_SERVICE_REQUEST',
          entityId: request.id,
          actorUserId,
          buildingId: request.buildingId,
          summary: `Handyman diagnosis recorded: ${scopeClassification} (${discipline.code}).`,
          metadata: {
            diagnosisId: record.id,
            disciplineCode: discipline.code,
            scopeClassification,
            ...(input.recommendedServiceCatalogId != null
              ? { recommendedServiceCatalogId: input.recommendedServiceCatalogId }
              : {}),
          },
        },
        tx,
      );

      return toPublic(record);
    });
  } catch (error) {
    if (isDiagnosisUniqueViolation(error)) {
      throw handymanServiceRequestAlreadyDiagnosedError();
    }
    throw error;
  }
}

/** Bounded read of the immutable F2 diagnosis record for one request. */
export async function getHandymanRequestDiagnosis(
  handymanRequestId: string,
): Promise<PublicHandymanRequestDiagnosis> {
  if (!isValidUuid(handymanRequestId)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'handymanRequestId',
        message: 'handymanRequestId must be a valid UUID.',
      },
    ]);
  }
  const record = await handymanRequestDiagnosisRepository.findByRequest(
    undefined,
    handymanRequestId,
  );
  if (!record) {
    throw AppError.notFound('Handyman request diagnosis record not found.');
  }
  return toPublic(record);
}

export const handymanServiceRequestDiagnosisService = {
  recordHandymanDiagnosis,
  getHandymanRequestDiagnosis,
};
