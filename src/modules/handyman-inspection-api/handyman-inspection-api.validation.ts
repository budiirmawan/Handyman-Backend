import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import type { AssignHandymanInspectionFieldInput } from '../handyman-requests';

/**
 * CR-HM-INSPECTION-01 PART A — request/DTO parsing for the pre-quotation
 * Field inspection assignment surface.
 *
 * Validation-only: the service remains the sole authority for the inspection
 * path, the target's user/permission/scope eligibility, the single-active
 * rule and the supersession chain.
 *
 * Authority rule: bodies expose ONLY caller-owned inputs (`assignedFieldUserId`
 * and, on reassignment, `reassignmentReason`). Smuggled keys — actor,
 * client/building/channel context, status, assignment or supersession ids —
 * are structurally IGNORED: the parser never spreads the source object.
 */

type Detail = { field: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(details: Detail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

/** Path parameter authority: the Handyman request id in the URL. */
export function parseInspectionHandymanRequestIdParam(value: unknown): string {
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    fail([
      {
        field: 'handymanRequestId',
        message: 'handymanRequestId must be a valid UUID.',
      },
    ]);
  }
  return (value as string).trim().toLowerCase();
}

export function parseInspectionAssignmentBody(
  body: unknown,
): Omit<AssignHandymanInspectionFieldInput, 'handymanRequestId'> {
  const source = isRecord(body) ? body : {};
  const details: Detail[] = [];

  const assignedFieldUserId =
    typeof source.assignedFieldUserId === 'string' &&
    isValidUuid(source.assignedFieldUserId.trim())
      ? source.assignedFieldUserId.trim().toLowerCase()
      : undefined;
  if (!assignedFieldUserId) {
    details.push({
      field: 'assignedFieldUserId',
      message: 'assignedFieldUserId is required and must be a valid UUID.',
    });
  }

  let reassignmentReason: string | undefined;
  if (source.reassignmentReason !== undefined) {
    if (typeof source.reassignmentReason !== 'string') {
      details.push({
        field: 'reassignmentReason',
        message: 'reassignmentReason must be a string.',
      });
    } else {
      const trimmed = source.reassignmentReason.trim();
      if (trimmed.length > 500) {
        details.push({
          field: 'reassignmentReason',
          message: 'reassignmentReason must be between 1 and 500 characters.',
        });
      } else if (trimmed.length > 0) {
        reassignmentReason = trimmed;
      }
    }
  }

  if (!assignedFieldUserId || details.length) fail(details);
  return { assignedFieldUserId, reassignmentReason };
}

/** Path parameter authority: the report id in the URL. */
export function parseInspectionReportIdParam(value: unknown): string {
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    fail([{ field: 'reportId', message: 'reportId must be a valid UUID.' }]);
  }
  return (value as string).trim().toLowerCase();
}

export function parseInspectionReportIdOnlyParam(value: unknown): string {
  return parseInspectionReportIdParam(value);
}

/**
 * Report submission body: technical scope only. `estimates` is a bounded
 * array of quantity lines; every other key (actor, client, building,
 * assignment, version, status, scopeClassification, price/currency) is
 * structurally ignored because the parser never spreads the source object.
 */
export function parseInspectionReportBody(body: unknown): {
  technicalFindings: string;
  proposedDiagnosis: string;
  disciplineId: string;
  recommendedServiceCatalogId?: string;
  estimates: Array<{
    lineType: 'LABOR' | 'MATERIAL';
    description: string;
    quantity: number;
    uomId: string;
  }>;
} {
  const source = isRecord(body) ? body : {};
  const details: Detail[] = [];

  const disciplineId =
    typeof source.disciplineId === 'string' &&
    isValidUuid(source.disciplineId.trim())
      ? source.disciplineId.trim().toLowerCase()
      : undefined;
  if (!disciplineId) {
    details.push({
      field: 'disciplineId',
      message: 'disciplineId is required and must be a valid UUID.',
    });
  }

  const technicalFindings =
    typeof source.technicalFindings === 'string'
      ? source.technicalFindings.trim()
      : '';
  if (technicalFindings.length < 1 || technicalFindings.length > 2000) {
    details.push({
      field: 'technicalFindings',
      message: 'technicalFindings must be between 1 and 2000 characters.',
    });
  }

  const proposedDiagnosis =
    typeof source.proposedDiagnosis === 'string'
      ? source.proposedDiagnosis.trim()
      : '';
  if (proposedDiagnosis.length < 1 || proposedDiagnosis.length > 1000) {
    details.push({
      field: 'proposedDiagnosis',
      message: 'proposedDiagnosis must be between 1 and 1000 characters.',
    });
  }

  let recommendedServiceCatalogId: string | undefined;
  if (source.recommendedServiceCatalogId !== undefined) {
    if (
      typeof source.recommendedServiceCatalogId !== 'string' ||
      !isValidUuid(source.recommendedServiceCatalogId.trim())
    ) {
      details.push({
        field: 'recommendedServiceCatalogId',
        message:
          'recommendedServiceCatalogId must be a valid UUID when present.',
      });
    } else {
      recommendedServiceCatalogId =
        source.recommendedServiceCatalogId.trim().toLowerCase();
    }
  }

  const estimates: Array<{
    lineType: 'LABOR' | 'MATERIAL';
    description: string;
    quantity: number;
    uomId: string;
  }> = [];
  if (source.estimates !== undefined) {
    if (!Array.isArray(source.estimates) || source.estimates.length > 50) {
      details.push({
        field: 'estimates',
        message: 'estimates must be an array of at most 50 lines.',
      });
    } else {
      source.estimates.forEach((raw, index) => {
        const line = isRecord(raw) ? raw : {};
        const lineType =
          line.lineType === 'LABOR' || line.lineType === 'MATERIAL'
            ? line.lineType
            : undefined;
        const description =
          typeof line.description === 'string' ? line.description.trim() : '';
        const quantity =
          typeof line.quantity === 'number'
            ? line.quantity
            : Number(line.quantity);
        const uomId =
          typeof line.uomId === 'string' && isValidUuid(line.uomId.trim())
            ? line.uomId.trim().toLowerCase()
            : undefined;
        if (
          !lineType ||
          description.length < 1 ||
          description.length > 500 ||
          !Number.isFinite(quantity) ||
          quantity <= 0 ||
          !uomId
        ) {
          details.push({
            field: `estimates[${index}]`,
            message:
              'each estimate line requires lineType (LABOR|MATERIAL), a ' +
              'description (1-500 characters), a positive quantity and a uomId UUID.',
          });
          return;
        }
        estimates.push({ lineType, description, quantity, uomId });
      });
    }
  }

  if (!disciplineId || details.length) fail(details);
  return {
    technicalFindings,
    proposedDiagnosis,
    disciplineId,
    ...(recommendedServiceCatalogId ? { recommendedServiceCatalogId } : {}),
    estimates,
  };
}

/** Review body: the decision and, for RETURNED, the correction reason. */
export function parseInspectionReviewBody(body: unknown): {
  decision: 'ACCEPTED' | 'RETURNED';
  returnReason?: string;
} {
  const source = isRecord(body) ? body : {};
  const details: Detail[] = [];

  const decision =
    source.decision === 'ACCEPTED' || source.decision === 'RETURNED'
      ? source.decision
      : undefined;
  if (!decision) {
    details.push({
      field: 'decision',
      message: 'decision must be one of: ACCEPTED, RETURNED.',
    });
  }

  let returnReason: string | undefined;
  if (source.returnReason !== undefined) {
    if (typeof source.returnReason !== 'string') {
      details.push({
        field: 'returnReason',
        message: 'returnReason must be a string.',
      });
    } else {
      const trimmed = source.returnReason.trim();
      if (trimmed.length > 1000) {
        details.push({
          field: 'returnReason',
          message: 'returnReason must be between 1 and 1000 characters.',
        });
      } else if (trimmed.length > 0) {
        returnReason = trimmed;
      }
    }
  }

  if (!decision || details.length) fail(details);
  return { decision, ...(returnReason ? { returnReason } : {}) };
}
