import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  isOperationalBudgetCurrency,
  isOperationalBudgetOverspendPolicy,
  isOperationalBudgetStatus,
  isOperationalFinanceSourceType,
  OPERATIONAL_BUDGET_CURRENCIES,
  OPERATIONAL_BUDGET_OVERSPEND_POLICIES,
  OPERATIONAL_BUDGET_STATUSES,
  OPERATIONAL_FINANCE_SOURCE_TYPES,
  type CreateOperationalBudgetCategoryInput,
  type CreateOperationalBudgetSourceBindingInput,
  type CreateOperationalBudgetInput,
  type OperationalBudgetFilters,
  type OperationalBudgetPeriod,
  type UpdateOperationalBudgetCategoryInput,
  type UpdateOperationalBudgetInput,
} from './operational-finance.types';

type ValidationDetail = { field: string; message: string };
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_NAME_LENGTH = 160;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(details: ValidationDetail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

function parseId(raw: string, field: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) {
    fail([{ field, message: `${field} must be a valid UUID.` }]);
  }
  return value;
}

export const parseOperationalBudgetIdParam = (raw: string): string =>
  parseId(raw, 'budgetId');

export const parseOperationalBudgetCategoryIdParam = (raw: string): string =>
  parseId(raw, 'categoryId');

export const parseOperationalBudgetBuildingIdParam = (raw: string): string =>
  parseId(raw, 'buildingId');

export const parseOperationalBudgetSourceBindingIdParam = (raw: string): string =>
  parseId(raw, 'bindingId');

export function parseCreateOperationalBudgetBody(
  body: unknown,
): CreateOperationalBudgetInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const details: ValidationDetail[] = [];
  const budgetName = body.budgetName === undefined
    ? undefined
    : readName(body.budgetName, details, 'budgetName');
  const budgetPeriod = readBudgetPeriod(body.budgetPeriod, details);
  const currency = readCurrency(body.currency, details);
  const plannedAmount = readMoney(body.plannedAmount, 'plannedAmount', details);
  const overspendPolicy = body.overspendPolicy === undefined
    ? undefined
    : readOverspendPolicy(body.overspendPolicy, details);

  rejectDerivedFields(body, details, ['clientId', 'buildingId', 'status']);

  if (!budgetPeriod || !currency || plannedAmount === undefined || details.length) {
    fail(details);
  }

  return {
    ...(budgetName === undefined ? {} : { budgetName }),
    budgetPeriod,
    currency,
    plannedAmount,
    ...(overspendPolicy === undefined ? {} : { overspendPolicy }),
  };
}

export function parseUpdateOperationalBudgetBody(
  body: unknown,
): UpdateOperationalBudgetInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const details: ValidationDetail[] = [];
  rejectDerivedFields(
    body,
    details,
    ['id', 'clientId', 'buildingId', 'status', 'createdAt', 'updatedAt'],
  );

  const budgetName = body.budgetName === undefined
    ? undefined
    : readName(body.budgetName, details, 'budgetName');

  const budgetPeriod = body.budgetPeriod === undefined
    ? undefined
    : readBudgetPeriod(body.budgetPeriod, details);
  const currency = body.currency === undefined
    ? undefined
    : readCurrency(body.currency, details);
  const plannedAmount = body.plannedAmount === undefined
    ? undefined
    : readMoney(body.plannedAmount, 'plannedAmount', details);
  const overspendPolicy = body.overspendPolicy === undefined
    ? undefined
    : readOverspendPolicy(body.overspendPolicy, details);

  if (
    budgetName === undefined &&
    budgetPeriod === undefined &&
    currency === undefined &&
    plannedAmount === undefined &&
    overspendPolicy === undefined &&
    details.length === 0
  ) {
    details.push({
      field: 'body',
      message: 'At least one draft budget field is required.',
    });
  }
  if (details.length) fail(details);

  return {
    ...(budgetName === undefined ? {} : { budgetName }),
    ...(budgetPeriod === undefined ? {} : { budgetPeriod }),
    ...(currency === undefined ? {} : { currency }),
    ...(plannedAmount === undefined ? {} : { plannedAmount }),
    ...(overspendPolicy === undefined ? {} : { overspendPolicy }),
  };
}

export function parseOperationalBudgetFilters(
  query: unknown,
): OperationalBudgetFilters {
  if (!isRecord(query)) return {};

  const details: ValidationDetail[] = [];
  const buildingId = query.buildingId === undefined
    ? undefined
    : readUuid(query.buildingId, 'buildingId', details);
  const status = query.status === undefined
    ? undefined
    : readStatus(query.status, details);
  const periodFrom = query.periodFrom === undefined
    ? undefined
    : readDate(query.periodFrom, 'periodFrom', details);
  const periodTo = query.periodTo === undefined
    ? undefined
    : readDate(query.periodTo, 'periodTo', details);

  if (periodFrom && periodTo && periodTo < periodFrom) {
    details.push({
      field: 'periodTo',
      message: 'periodTo must be the same as or after periodFrom.',
    });
  }
  if (details.length) fail(details);

  return {
    ...(buildingId === undefined ? {} : { buildingId }),
    ...(status === undefined ? {} : { status }),
    ...(periodFrom === undefined ? {} : { periodFrom }),
    ...(periodTo === undefined ? {} : { periodTo }),
  };
}

export function parseCreateOperationalBudgetCategoryBody(
  body: unknown,
): CreateOperationalBudgetCategoryInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const details: ValidationDetail[] = [];
  const code = readCode(body.code, 'code', details);
  const name = readName(body.name, details);
  const plannedAmount = readMoney(body.plannedAmount, 'plannedAmount', details);
  rejectDerivedFields(body, details, [
    'budgetId',
    'clientId',
    'buildingId',
    'currency',
  ]);

  if (!code || !name || plannedAmount === undefined || details.length) {
    fail(details);
  }

  return { code, name, plannedAmount };
}

export function parseUpdateOperationalBudgetCategoryBody(
  body: unknown,
): UpdateOperationalBudgetCategoryInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const details: ValidationDetail[] = [];
  rejectDerivedFields(
    body,
    details,
    [
      'id',
      'budgetId',
      'clientId',
      'buildingId',
      'code',
      'currency',
      'createdAt',
      'updatedAt',
    ],
  );
  const name = body.name === undefined ? undefined : readName(body.name, details);
  const plannedAmount = body.plannedAmount === undefined
    ? undefined
    : readMoney(body.plannedAmount, 'plannedAmount', details);

  if (name === undefined && plannedAmount === undefined && details.length === 0) {
    details.push({
      field: 'body',
      message: 'At least one draft category field is required.',
    });
  }
  if (details.length) fail(details);

  return {
    ...(name === undefined ? {} : { name }),
    ...(plannedAmount === undefined ? {} : { plannedAmount }),
  };
}

export function parseCreateOperationalBudgetSourceBindingBody(
  body: unknown,
): CreateOperationalBudgetSourceBindingInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const details: ValidationDetail[] = [];
  const sourceType = readSourceType(body.sourceType, details);
  const budgetCategoryId = readUuid(
    body.budgetCategoryId,
    'budgetCategoryId',
    details,
  );
  const references = {
    basicExpenseId: readOptionalUuid(body.basicExpenseId, 'basicExpenseId', details),
    vendorServiceCostId: readOptionalUuid(
      body.vendorServiceCostId,
      'vendorServiceCostId',
      details,
    ),
    vendorInvoiceId: readOptionalUuid(
      body.vendorInvoiceId,
      'vendorInvoiceId',
      details,
    ),
    purchaseOrderId: readOptionalUuid(body.purchaseOrderId, 'purchaseOrderId', details),
    purchaseOrderLineId: readOptionalUuid(
      body.purchaseOrderLineId,
      'purchaseOrderLineId',
      details,
    ),
    workOrderMaterialUsageId: readOptionalUuid(
      body.workOrderMaterialUsageId,
      'workOrderMaterialUsageId',
      details,
    ),
  };

  rejectDerivedFields(body, details, [
    'budgetId',
    'clientId',
    'buildingId',
    'currency',
    'currencyStatus',
    'status',
    'createdAt',
    'updatedAt',
  ]);

  const populated = Object.entries(references).filter(([, value]) => value !== undefined);
  if (populated.length !== 1) {
    details.push({
      field: 'sourceReference',
      message: 'Exactly one typed operational source reference is required.',
    });
  } else if (sourceType) {
    const expected = expectedSourceReference(sourceType);
    if (populated[0][0] !== expected) {
      details.push({
        field: populated[0][0],
        message: `source reference must be ${expected} for sourceType ${sourceType}.`,
      });
    }
  }

  if (!sourceType || !budgetCategoryId || details.length) fail(details);
  return {
    budgetCategoryId,
    sourceType,
    basicExpenseId: references.basicExpenseId ?? null,
    vendorServiceCostId: references.vendorServiceCostId ?? null,
    vendorInvoiceId: references.vendorInvoiceId ?? null,
    purchaseOrderId: references.purchaseOrderId ?? null,
    purchaseOrderLineId: references.purchaseOrderLineId ?? null,
    workOrderMaterialUsageId: references.workOrderMaterialUsageId ?? null,
  };
}

function readSourceType(
  value: unknown,
  details: ValidationDetail[],
) {
  if (!isOperationalFinanceSourceType(value)) {
    details.push({
      field: 'sourceType',
      message: `sourceType must be one of: ${OPERATIONAL_FINANCE_SOURCE_TYPES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

function expectedSourceReference(sourceType: CreateOperationalBudgetSourceBindingInput['sourceType']): string {
  switch (sourceType) {
    case 'BASIC_EXPENSE':
      return 'basicExpenseId';
    case 'VENDOR_SERVICE_COST':
      return 'vendorServiceCostId';
    case 'VENDOR_INVOICE':
      return 'vendorInvoiceId';
    case 'PURCHASE_ORDER':
      return 'purchaseOrderId';
    case 'PO_LINE':
      return 'purchaseOrderLineId';
    case 'WORK_ORDER_MATERIAL':
      return 'workOrderMaterialUsageId';
  }
}

function readOptionalUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return readUuid(value, field, details);
}

function rejectDerivedFields(
  body: Record<string, unknown>,
  details: ValidationDetail[],
  fields: readonly string[],
): void {
  const field = fields.find((candidate) => body[candidate] !== undefined);
  if (field) {
    details.push({
      field,
      message: 'This field is backend-derived or immutable and must not be supplied.',
    });
  }
}

function readBudgetPeriod(
  value: unknown,
  details: ValidationDetail[],
): OperationalBudgetPeriod | undefined {
  if (!isRecord(value)) {
    details.push({
      field: 'budgetPeriod',
      message: 'budgetPeriod must contain start and end dates.',
    });
    return undefined;
  }
  const start = readDate(value.start, 'budgetPeriod.start', details);
  const end = readDate(value.end, 'budgetPeriod.end', details);
  if (start && end && end < start) {
    details.push({
      field: 'budgetPeriod.end',
      message: 'budgetPeriod.end must be the same as or after budgetPeriod.start.',
    });
  }
  if (!start || !end) return undefined;
  return { start, end };
}

function readCurrency(
  value: unknown,
  details: ValidationDetail[],
) {
  if (typeof value !== 'string' || !isOperationalBudgetCurrency(value.trim().toUpperCase())) {
    details.push({
      field: 'currency',
      message: `currency must be one of: ${OPERATIONAL_BUDGET_CURRENCIES.join(', ')}.`,
    });
    return undefined;
  }
  return value.trim().toUpperCase() as CreateOperationalBudgetInput['currency'];
}

/**
 * CR-BE-COMM-VAR-01 PART 01 — governed overspend vocabulary. The value is
 * matched exactly (no case coercion) so an unrecognised policy can never be
 * silently normalised into a control decision.
 */
function readOverspendPolicy(
  value: unknown,
  details: ValidationDetail[],
) {
  if (!isOperationalBudgetOverspendPolicy(value)) {
    details.push({
      field: 'overspendPolicy',
      message: `overspendPolicy must be one of: ${OPERATIONAL_BUDGET_OVERSPEND_POLICIES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
) {
  if (!isOperationalBudgetStatus(value)) {
    details.push({
      field: 'status',
      message: `status must be one of: ${OPERATIONAL_BUDGET_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

function readUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readCode(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || !CODE_PATTERN.test(value.trim().toUpperCase())) {
    details.push({ field, message: `${field} must be a valid data-driven code.` });
    return undefined;
  }
  return value.trim().toUpperCase();
}

function readName(
  value: unknown,
  details: ValidationDetail[],
  field = 'name',
): string | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    details.push({ field, message: `${field} is required.` });
    return undefined;
  }
  const name = value.trim();
  if (name.length > MAX_NAME_LENGTH) {
    details.push({ field, message: `${field} must be at most ${MAX_NAME_LENGTH} characters.` });
    return undefined;
  }
  return name;
}

function readMoney(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    details.push({ field, message: `${field} must be a finite non-negative number.` });
    return undefined;
  }
  return value;
}

function readDate(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value) || !isCalendarDate(value)) {
    details.push({ field, message: `${field} must be a valid YYYY-MM-DD date.` });
    return undefined;
  }
  return value;
}

function isCalendarDate(value: string): boolean {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}
