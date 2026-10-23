import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  WORK_ORDER_TRADE_CATEGORY_CODE_PATTERN,
  WORK_ORDER_TRADE_CATEGORY_STATUSES,
  WORK_ORDER_TRADE_RISK_LEVELS,
  isWorkOrderTradeCategoryStatus,
  isWorkOrderTradeRiskLevel,
  type CreateWorkOrderTradeCategoryInput,
  type ListWorkOrderTradeCategoriesFilter,
  type UpdateWorkOrderTradeCategoryInput,
  type WorkOrderTradeRiskLevel,
} from './work-order-trade-category.types';

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 03B2A — trade registry + classification
 * input validation.
 *
 * Validation is strict about SHAPE (types, ranges, UUIDs) and permissive about
 * VOCABULARY: a trade code is any upper-snake token, never a member of an
 * application enum, because supporting a new trade must not require a deploy.
 */

export type ValidationDetail = { field: string; message: string };

function fail(details: ValidationDetail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalText(
  value: unknown,
  field: string,
  details: ValidationDetail[],
  max: number,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a string or null.` });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) {
    details.push({
      field,
      message: `${field} must be at most ${max} characters.`,
    });
    return undefined;
  }
  return trimmed;
}

export function parseTradeCategoryIdParam(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) {
    fail([{ field: 'tradeCategoryId', message: 'tradeCategoryId must be a valid UUID.' }]);
  }
  return value;
}

export function parseWorkOrderIdParam(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) {
    fail([{ field: 'workOrderId', message: 'workOrderId must be a valid UUID.' }]);
  }
  return value;
}

export function validateListTradeCategoriesFilter(
  query: Record<string, unknown>,
): ListWorkOrderTradeCategoriesFilter {
  const details: ValidationDetail[] = [];
  const filter: ListWorkOrderTradeCategoriesFilter = {};

  if (query.status !== undefined) {
    if (!isWorkOrderTradeCategoryStatus(query.status)) {
      details.push({
        field: 'status',
        message: `status must be one of: ${WORK_ORDER_TRADE_CATEGORY_STATUSES.join(', ')}.`,
      });
    } else {
      filter.status = query.status;
    }
  }
  if (query.riskLevel !== undefined) {
    if (!isWorkOrderTradeRiskLevel(query.riskLevel)) {
      details.push({
        field: 'riskLevel',
        message: `riskLevel must be one of: ${WORK_ORDER_TRADE_RISK_LEVELS.join(', ')}.`,
      });
    } else {
      filter.riskLevel = query.riskLevel;
    }
  }
  if (query.handymanDisciplineId !== undefined) {
    const value = String(query.handymanDisciplineId).trim().toLowerCase();
    if (!isValidUuid(value)) {
      details.push({
        field: 'handymanDisciplineId',
        message: 'handymanDisciplineId must be a valid UUID.',
      });
    } else {
      filter.handymanDisciplineId = value;
    }
  }

  if (details.length > 0) fail(details);
  return filter;
}

export function validateCreateTradeCategoryInput(
  body: unknown,
  createdByUserId: string,
): CreateWorkOrderTradeCategoryInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const details: ValidationDetail[] = [];

  const rawCode = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
  if (!rawCode) {
    details.push({ field: 'code', message: 'code is required.' });
  } else if (!WORK_ORDER_TRADE_CATEGORY_CODE_PATTERN.test(rawCode)) {
    details.push({
      field: 'code',
      message:
        'code must be 2-40 characters, start with a letter, and contain only ' +
        'A-Z, 0-9 and underscore.',
    });
  }

  const rawName = typeof body.name === 'string' ? body.name.trim() : '';
  if (!rawName) {
    details.push({ field: 'name', message: 'name is required.' });
  } else if (rawName.length > 120) {
    details.push({ field: 'name', message: 'name must be at most 120 characters.' });
  }

  let riskLevel: WorkOrderTradeRiskLevel = 'LOW';
  if (body.riskLevel !== undefined) {
    if (!isWorkOrderTradeRiskLevel(body.riskLevel)) {
      details.push({
        field: 'riskLevel',
        message: `riskLevel must be one of: ${WORK_ORDER_TRADE_RISK_LEVELS.join(', ')}.`,
      });
    } else {
      riskLevel = body.riskLevel;
    }
  }

  const description = optionalText(body.description, 'description', details, 500);

  let handymanDisciplineId: string | null = null;
  if (body.handymanDisciplineId !== undefined && body.handymanDisciplineId !== null) {
    if (
      typeof body.handymanDisciplineId !== 'string' ||
      !isValidUuid(body.handymanDisciplineId.trim())
    ) {
      details.push({
        field: 'handymanDisciplineId',
        message: 'handymanDisciplineId must be a valid UUID or null.',
      });
    } else {
      handymanDisciplineId = body.handymanDisciplineId.trim().toLowerCase();
    }
  }

  if (details.length > 0) fail(details);
  return {
    code: rawCode,
    name: rawName,
    description: description ?? null,
    riskLevel,
    handymanDisciplineId,
    createdByUserId,
  };
}

export function validateUpdateTradeCategoryInput(
  body: unknown,
): UpdateWorkOrderTradeCategoryInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  if (body.code !== undefined) {
    fail([
      {
        field: 'code',
        message:
          'code is immutable: historical assignment decisions quote it. ' +
          'Create a new trade category instead.',
      },
    ]);
  }
  const details: ValidationDetail[] = [];
  const changes: UpdateWorkOrderTradeCategoryInput = {};

  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      details.push({ field: 'name', message: 'name must be a non-empty string.' });
    } else if (name.length > 120) {
      details.push({ field: 'name', message: 'name must be at most 120 characters.' });
    } else {
      changes.name = name;
    }
  }
  if (body.riskLevel !== undefined) {
    if (!isWorkOrderTradeRiskLevel(body.riskLevel)) {
      details.push({
        field: 'riskLevel',
        message: `riskLevel must be one of: ${WORK_ORDER_TRADE_RISK_LEVELS.join(', ')}.`,
      });
    } else {
      changes.riskLevel = body.riskLevel;
    }
  }
  if (body.description !== undefined) {
    const description = optionalText(body.description, 'description', details, 500);
    if (description !== undefined) changes.description = description;
  }
  if (body.handymanDisciplineId !== undefined) {
    if (body.handymanDisciplineId === null) {
      changes.handymanDisciplineId = null;
    } else if (
      typeof body.handymanDisciplineId !== 'string' ||
      !isValidUuid(body.handymanDisciplineId.trim())
    ) {
      details.push({
        field: 'handymanDisciplineId',
        message: 'handymanDisciplineId must be a valid UUID or null.',
      });
    } else {
      changes.handymanDisciplineId = body.handymanDisciplineId.trim().toLowerCase();
    }
  }

  if (details.length > 0) fail(details);
  if (Object.keys(changes).length === 0) {
    fail([{ field: 'body', message: 'At least one field must be provided.' }]);
  }
  return changes;
}

export function validateClassificationInput(body: unknown): {
  tradeCategoryId: string | null;
  riskLevel?: WorkOrderTradeRiskLevel | null;
  notes?: string | null;
} {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const details: ValidationDetail[] = [];

  if (body.tradeCategoryId === undefined) {
    details.push({
      field: 'tradeCategoryId',
      message: 'tradeCategoryId is required (send null to clear the classification).',
    });
  }
  let tradeCategoryId: string | null = null;
  if (body.tradeCategoryId !== undefined && body.tradeCategoryId !== null) {
    if (
      typeof body.tradeCategoryId !== 'string' ||
      !isValidUuid(body.tradeCategoryId.trim())
    ) {
      details.push({
        field: 'tradeCategoryId',
        message: 'tradeCategoryId must be a valid UUID or null.',
      });
    } else {
      tradeCategoryId = body.tradeCategoryId.trim().toLowerCase();
    }
  }

  let riskLevel: WorkOrderTradeRiskLevel | null | undefined;
  if (body.riskLevel !== undefined) {
    if (body.riskLevel !== null && !isWorkOrderTradeRiskLevel(body.riskLevel)) {
      details.push({
        field: 'riskLevel',
        message: `riskLevel must be one of: ${WORK_ORDER_TRADE_RISK_LEVELS.join(', ')} or null.`,
      });
    } else {
      riskLevel = body.riskLevel as WorkOrderTradeRiskLevel | null;
    }
  }

  const notes = optionalText(body.notes, 'notes', details, 1000);

  if (details.length > 0) fail(details);
  return {
    tradeCategoryId,
    ...(riskLevel === undefined ? {} : { riskLevel }),
    ...(notes === undefined ? {} : { notes }),
  };
}
