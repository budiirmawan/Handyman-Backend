import { AppError } from '../../shared/errors';
import { buildingNotFoundError, buildingRepository } from '../buildings';
import { isValidUuid } from '../clients';
import { contextAccessService } from '../context-access';
import { checklistExecutionDetailRepository } from '../checklist-execution-detail/checklist-execution-detail.repository';
import { formExecutionDetailRepository } from '../form-execution-detail/form-execution-detail.repository';
import {
  isOperationalDetailEngine,
  type OperationalDetailEngine,
  type OperationalDetailFilters,
  type OperationalDetailPagination,
  type OperationalDetailQuery,
  type PublicOperationalDetail,
  type PublicOperationalDetailRow,
} from './operational-detail-reporting.types';

/**
 * R07 PART 02C — Shared Neutral Detail Adapter + Shared Access
 *
 * Composes already-closed physical repositories:
 *   checklist-execution-detail.repository.ts (PART 01A)
 *   form-execution-detail.repository.ts (PART 02B)
 * No giant UNION SQL, physical adapters remain separate.
 *
 * Shared access authority reused from PART 01B / R04:
 *   - buildingRepository.findById + buildingNotFoundError
 *   - contextAccessService.assertBuildingAccess
 *   - contextAccessService.getAccessibleBuildingIds
 *   - empty scope returns empty safely
 *   - executionId/formInstanceId does NOT bypass building scope (repository filters building_id ANY)
 *
 * No role hardcoding, no alternate permission, no unrestricted fallback, no display-name joins, no executor, no evidence/finding/rework, no export, no route.
 *
 * Neutral row contract:
 *   engine discriminator CHECKLIST_EXECUTION | FORM_INSTANCE
 *   Common fields: executionId, definitionItemId, responseId, clientId, buildingId, templateId, status, startedAt, completedAt, createdAt, updatedAt, label, type, displayOrder, required, uomId, min/max/precision, value, responseCreatedAt/UpdatedAt, lastRespondedBy, completedBy, assignment snapshot, verification
 *   Form-specific nullable: occurrenceId, occurrenceIndex, sectionId, sectionCode, sectionTitle, sectionDisplayOrder, repeatableGroupId, formTemplateVersionId — NULL for checklist
 *   Checklist-specific nullable: result, notes, isNa, naNotes, optionCode, optionLabel, isNaAllowed, naRequiresNote — NULL for form, with isNa NULL meaning concept unsupported (not false)
 *
 * Historical authority:
 *   checklist definition LIVE, form definition VERSION_SNAPSHOT, measurement LIVE for both
 *
 * Unanswered: responseId NULL => unanswered for both
 * Form null-value: responseId != NULL + value NULL => response exists with null value, not unanswered
 * Checklist explicit N/A: responseId != NULL + isNa TRUE => explicit N/A
 *
 * Pagination: PART 02C requires explicit engine to keep pagination honest (delegates limit/offset directly to one physical repo). If engine omitted, throws validation requiring engine (defer cross-engine combined pagination).
 */

export type ValidationDetail = {
  field: string;
  message: string;
};

const MAX_RANGE_DAYS = 366;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const EXECUTION_STATUSES = new Set<string>(['DRAFT', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']);
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

function isExecutionStatus(value: unknown): boolean {
  return typeof value === 'string' && EXECUTION_STATUSES.has(value);
}

export function parseOperationalDetailQuery(
  query: Record<string, unknown>,
): OperationalDetailQuery {
  const details: ValidationDetail[] = [];

  const engineRaw = readSingleParam(query.engine);
  let engine: OperationalDetailEngine | undefined;
  if (engineRaw !== undefined && engineRaw !== '') {
    const normalized = engineRaw.trim().toUpperCase();
    if (!isOperationalDetailEngine(normalized)) {
      details.push({
        field: 'engine',
        message: `engine must be one of: ${['CHECKLIST_EXECUTION', 'FORM_INSTANCE'].join(', ')}.`,
      });
    } else {
      engine = normalized as OperationalDetailEngine;
    }
  }

  const buildingId = readOptionalUuid(query.buildingId, 'buildingId', details);
  const executionId = readOptionalUuid(query.executionId, 'executionId', details);
  const templateId = readOptionalUuid(query.templateId, 'templateId', details);

  const status = readOptionalEnum(
    query.status,
    'status',
    isExecutionStatus,
    'status must be a valid execution status (DRAFT/IN_PROGRESS/COMPLETED/CANCELLED).',
    details,
  );

  const dateFromRaw = readSingleParam(query.dateFrom);
  const dateToRaw = readSingleParam(query.dateTo);
  const dateFrom = dateFromRaw ? readOptionalDate(dateFromRaw, 'dateFrom', details) : undefined;
  const dateTo = dateToRaw ? readOptionalDate(dateToRaw, 'dateTo', details) : undefined;

  if (dateFrom && dateTo && dateFrom > dateTo) {
    details.push({ field: 'dateFrom', message: 'dateFrom must not exceed dateTo.' });
  }
  if (dateFrom && dateTo && (dateTo.getTime() - dateFrom.getTime()) / 86400000 > MAX_RANGE_DAYS) {
    details.push({
      field: 'dateTo',
      message: `Report date range must not exceed ${MAX_RANGE_DAYS} days.`,
    });
  }

  const limit = readOptionalLimit(query.limit, details);
  const offset = readOptionalOffset(query.offset, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(engine === undefined ? {} : { engine }),
    ...(buildingId === undefined ? {} : { buildingId }),
    ...(executionId === undefined ? {} : { executionId }),
    ...(templateId === undefined ? {} : { templateId }),
    ...(status === undefined ? {} : { status }),
    ...(dateFromRaw ? { dateFrom: dateFromRaw.trim() } : {}),
    ...(dateToRaw ? { dateTo: dateToRaw.trim() } : {}),
    ...(limit === undefined ? {} : { limit }),
    ...(offset === undefined ? {} : { offset }),
  };
}

export function operationalDetailRange(filters: OperationalDetailFilters): {
  start: Date | null;
  end: Date | null;
} {
  const start = filters.dateFrom ? new Date(filters.dateFrom) : null;
  let end: Date | null = null;
  if (filters.dateTo) {
    const to = new Date(filters.dateTo);
    end = DATE_ONLY.test(filters.dateTo) ? new Date(to.getTime() + 86400000) : to;
  }
  return { start, end };
}

async function resolveScope(
  filters: OperationalDetailFilters,
  userId: string,
): Promise<{ start: Date | null; end: Date | null; buildingIds: string[] }> {
  const range = operationalDetailRange(filters);
  if (filters.buildingId) {
    const building = await buildingRepository.findById(filters.buildingId);
    if (!building) {
      throw buildingNotFoundError();
    }
    await contextAccessService.assertBuildingAccess(userId, filters.buildingId);
    return {
      start: range.start,
      end: range.end,
      buildingIds: [filters.buildingId],
    };
  }
  const buildingIds = await contextAccessService.getAccessibleBuildingIds(userId);
  return { start: range.start, end: range.end, buildingIds };
}

function mapChecklistRowToNeutral(
  row: import('../checklist-execution-detail/checklist-execution-detail.types').PublicChecklistExecutionDetailRow,
): PublicOperationalDetailRow {
  return {
    engine: 'CHECKLIST_EXECUTION',
    executionId: row.executionId,
    definitionItemId: row.checklistItemId,
    responseId: row.responseId,
    clientId: row.clientId,
    buildingId: row.buildingId,
    templateId: row.templateId,
    status: row.status,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    // R09 PART 01C — propagated verbatim (checklist authority: current master facts)
    definitionCode: row.definitionCode,
    templateCode: row.templateCode,
    templateName: row.templateName,
    label: row.itemLabel,
    type: row.itemType,
    displayOrder: row.displayOrder,
    required: row.required,
    uomId: row.uomId,
    // R09 PART 02A3 — propagated verbatim (CURRENT LIVE FACT; physical fail-closed NULL preserved)
    uomName: row.uomName,
    uomSymbol: row.uomSymbol,
    minimumValue: row.minimumValue,
    maximumValue: row.maximumValue,
    decimalPrecision: row.decimalPrecision,
    value: row.value,
    responseCreatedAt: row.responseCreatedAt,
    responseUpdatedAt: row.responseUpdatedAt,
    lastRespondedByUserId: row.lastRespondedByUserId,
    lastRespondedByName: row.lastRespondedByName,
    completedByUserId: row.completedByUserId,
    completedByName: row.completedByName,
    assigneeType: row.assigneeType,
    assignedWorkforceProfileId: row.assignedWorkforceProfileId,
    assignedWorkforceName: row.assignedWorkforceName,
    assignedTeamId: row.assignedTeamId,
    assignedTeamName: row.assignedTeamName,
    assignmentSnapshotAt: row.assignmentSnapshotAt,
    verificationReviewId: row.verificationReviewId,
    verificationStatus: row.verificationStatus,
    verificationDecision: row.verificationDecision,
    verificationReviewerUserId: row.verificationReviewerUserId,
    verificationReviewerName: row.verificationReviewerName,
    verificationReviewedAt: row.verificationReviewedAt,
    // Form-specific NULL
    occurrenceId: null,
    occurrenceIndex: null,
    sectionId: null,
    sectionCode: null,
    sectionTitle: null,
    sectionDisplayOrder: null,
    repeatableGroupId: null,
    formTemplateVersionId: null,
    // Checklist-specific
    result: row.result,
    notes: row.notes,
    isNa: row.isNa, // true explicit N/A, false not N/A, for unanswered repo returns false but responseId NULL indicates unanswered
    naNotes: row.naNotes,
    optionCode: row.optionCode,
    optionLabel: row.optionLabel,
    isNaAllowed: row.isNaAllowed,
    naRequiresNote: row.naRequiresNote,
    definitionMetadataAuthority: 'LIVE',
    measurementMetadataAuthority: 'LIVE',
  };
}

function mapFormRowToNeutral(
  row: import('../form-execution-detail/form-execution-detail.types').PublicFormExecutionDetailRow,
): PublicOperationalDetailRow {
  return {
    engine: 'FORM_INSTANCE',
    executionId: row.formInstanceId,
    definitionItemId: row.versionFieldId,
    responseId: row.responseId,
    clientId: row.clientId,
    buildingId: row.buildingId,
    templateId: row.formTemplateId,
    status: row.status,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    // R09 PART 01C — propagated verbatim (form authority: definitionCode is a
    // STABLE VERSION SNAPSHOT; templateCode/templateName are current master)
    definitionCode: row.definitionCode,
    templateCode: row.templateCode,
    templateName: row.templateName,
    label: row.fieldLabel,
    type: row.fieldType,
    displayOrder: row.displayOrder,
    required: row.required,
    uomId: row.uomId,
    // R09 PART 02A3 — propagated verbatim (CURRENT LIVE FACT; physical fail-closed NULL preserved)
    uomName: row.uomName,
    uomSymbol: row.uomSymbol,
    minimumValue: row.minimumValue,
    maximumValue: row.maximumValue,
    decimalPrecision: row.decimalPrecision,
    value: row.value,
    responseCreatedAt: row.responseCreatedAt,
    responseUpdatedAt: row.responseUpdatedAt,
    lastRespondedByUserId: row.lastRespondedByUserId,
    lastRespondedByName: row.lastRespondedByName,
    completedByUserId: row.completedByUserId,
    completedByName: row.completedByName,
    assigneeType: row.assigneeType,
    assignedWorkforceProfileId: row.assignedWorkforceProfileId,
    assignedWorkforceName: row.assignedWorkforceName,
    assignedTeamId: row.assignedTeamId,
    assignedTeamName: row.assignedTeamName,
    assignmentSnapshotAt: row.assignmentSnapshotAt,
    verificationReviewId: row.verificationReviewId,
    verificationStatus: row.verificationStatus,
    verificationDecision: row.verificationDecision,
    verificationReviewerUserId: row.verificationReviewerUserId,
    verificationReviewerName: row.verificationReviewerName,
    verificationReviewedAt: row.verificationReviewedAt,
    // Form-specific
    occurrenceId: row.occurrenceId,
    occurrenceIndex: row.occurrenceIndex,
    sectionId: row.sectionId,
    sectionCode: row.sectionCode,
    sectionTitle: row.sectionTitle,
    sectionDisplayOrder: row.sectionDisplayOrder,
    repeatableGroupId: row.repeatableGroupId,
    formTemplateVersionId: row.formTemplateVersionId,
    // Checklist-specific NULL with semantic note: concept unsupported
    result: null, // form has no result
    notes: null, // form has no notes
    isNa: null, // form has no explicit N/A authority, NULL means unsupported not false
    naNotes: null,
    optionCode: null, // form SELECT has no option authority table
    optionLabel: null,
    isNaAllowed: null,
    naRequiresNote: null,
    definitionMetadataAuthority: 'VERSION_SNAPSHOT',
    measurementMetadataAuthority: 'LIVE',
  };
}

export async function getOperationalDetail(
  filters: OperationalDetailQuery,
  userId: string,
): Promise<PublicOperationalDetail> {
  const { start, end, buildingIds } = await resolveScope(filters, userId);
  const asOf = new Date();

  const base = {
    buildingId: filters.buildingId ?? null,
    buildingScope: buildingIds,
    dateFrom: filters.dateFrom ?? null,
    dateTo: filters.dateTo ?? null,
    asOf: asOf.toISOString(),
    engine: filters.engine ?? null,
  };

  if (buildingIds.length === 0) {
    return { ...base, rows: [] };
  }

  // PART 02C smallest honest behavior: require explicit engine to keep pagination honest
  if (!filters.engine) {
    throw AppError.validation('Request validation failed.', [
      { field: 'engine', message: 'engine is required in PART 02C (CHECKLIST_EXECUTION | FORM_INSTANCE). Cross-engine combined pagination deferred.' },
    ]);
  }

  const pagination: OperationalDetailPagination = {
    limit: filters.limit ?? DEFAULT_LIMIT,
    offset: filters.offset ?? 0,
  };
  if (pagination.limit !== undefined && pagination.limit > MAX_LIMIT) {
    pagination.limit = MAX_LIMIT;
  }

  if (filters.engine === 'CHECKLIST_EXECUTION') {
    const rows = await checklistExecutionDetailRepository.getChecklistExecutionDetailRows(
      buildingIds,
      {
        buildingId: filters.buildingId,
        executionId: filters.executionId,
        templateId: filters.templateId,
        status: filters.status,
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
      },
      start,
      end,
      pagination,
    );
    return {
      ...base,
      rows: rows.map(mapChecklistRowToNeutral),
    };
  }

  // FORM_INSTANCE
  const rows = await formExecutionDetailRepository.getFormExecutionDetailRows(
    buildingIds,
    {
      formInstanceId: filters.executionId,
      formTemplateId: filters.templateId,
      status: filters.status,
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
    },
    start,
    end,
    pagination,
  );
  return {
    ...base,
    rows: rows.map(mapFormRowToNeutral),
  };
}

function readOptionalDate(
  raw: string,
  field: string,
  details: ValidationDetail[],
): Date | undefined {
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    details.push({ field, message: `${field} must be a valid ISO-8601 date or datetime.` });
    return undefined;
  }
  return parsed;
}

function readOptionalUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  const raw = readSingleParam(value);
  if (raw === undefined || raw === '') return undefined;
  if (!isValidUuid(raw.trim())) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return raw.trim().toLowerCase();
}

function readOptionalEnum(
  value: unknown,
  field: string,
  isValid: (candidate: unknown) => boolean,
  message: string,
  details: ValidationDetail[],
): string | undefined {
  const raw = readSingleParam(value);
  if (raw === undefined || raw === '') return undefined;
  const normalized = raw.trim().toUpperCase();
  if (!isValid(normalized)) {
    details.push({ field, message });
    return undefined;
  }
  return normalized;
}

function readOptionalLimit(value: unknown, details: ValidationDetail[]): number | undefined {
  const raw = readSingleParam(value);
  if (raw === undefined || raw === '') return undefined;
  const num = Number(raw);
  if (!Number.isInteger(num) || num <= 0) {
    details.push({ field: 'limit', message: 'limit must be a positive integer.' });
    return undefined;
  }
  return num;
}

function readOptionalOffset(value: unknown, details: ValidationDetail[]): number | undefined {
  const raw = readSingleParam(value);
  if (raw === undefined || raw === '') return undefined;
  const num = Number(raw);
  if (!Number.isInteger(num) || num < 0) {
    details.push({ field: 'offset', message: 'offset must be a non-negative integer.' });
    return undefined;
  }
  return num;
}

function readSingleParam(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return undefined;
  return String(value);
}

export const operationalDetailReportingService = {
  getOperationalDetail,
  parseOperationalDetailQuery,
  operationalDetailRange,
};
