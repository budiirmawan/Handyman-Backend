import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  isOperationalCommitmentStatus,
  OPERATIONAL_COMMITMENT_ORIGINS,
  OPERATIONAL_COMMITMENT_STATUSES,
  type AdjustOperationalCommitmentInput,
  type CloseOperationalCommitmentInput,
  type CreateOperationalCommitmentInput,
  type CreatePoLineCommitmentInput,
  type OperationalCommitmentFilters,
  type OperationalCommitmentOrigin,
} from './operational-commitment.types';
import {
  isOperationalBudgetCurrency,
  isOperationalBudgetOverspendPolicy,
  OPERATIONAL_BUDGET_CURRENCIES,
  OPERATIONAL_BUDGET_OVERSPEND_POLICIES,
  type OperationalBudgetOverspendPolicy,
} from './operational-finance.types';

/**
 * CR-BE-COMM-VAR-01 PART 02 — Operational Commitment request validation.
 *
 * Derived scope (client/building/budget/currency source, status, amounts held
 * on the header) is never accepted from the caller. Money is validated as a
 * finite positive number with at most two decimals so no unrepresentable
 * amount can reach the ledger.
 */

type ValidationDetail = { field: string; message: string };
const MAX_TITLE_LENGTH = 160;
const MAX_REASON_LENGTH = 500;
const MAX_IDEMPOTENCY_KEY_LENGTH = 120;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,119}$/;

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

export const parseOperationalCommitmentIdParam = (raw: string): string =>
  parseId(raw, 'commitmentId');

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

function readMoney(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    details.push({ field, message: `${field} must be a finite positive number.` });
    return undefined;
  }
  if (Math.round(value * 100) !== Number((value * 100).toFixed(4))) {
    details.push({ field, message: `${field} must have at most two decimals.` });
    return undefined;
  }
  return value;
}

function readText(
  value: unknown,
  field: string,
  maxLength: number,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    details.push({ field, message: `${field} is required.` });
    return undefined;
  }
  const text = value.trim();
  if (text.length > maxLength) {
    details.push({
      field,
      message: `${field} must be at most ${maxLength} characters.`,
    });
    return undefined;
  }
  return text;
}

function readIdempotencyKey(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value.trim())) {
    details.push({
      field: 'idempotencyKey',
      message:
        `idempotencyKey must be 8-${MAX_IDEMPOTENCY_KEY_LENGTH} characters of letters, digits, dot, colon, dash or underscore.`,
    });
    return undefined;
  }
  return value.trim();
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

function readOptionalUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return readUuid(value, field, details) ?? undefined;
}

export function parseCreateOperationalCommitmentBody(
  body: unknown,
): CreateOperationalCommitmentInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const details: ValidationDetail[] = [];
  rejectDerivedFields(body, details, [
    'id',
    'clientId',
    'buildingId',
    'budgetId',
    'origin',
    'sourceType',
    'purchaseOrderId',
    'purchaseOrderLineId',
    'status',
    'actualizedAmount',
    'releasedAmount',
    'openAmount',
    'committedAmount',
    'createdAt',
    'updatedAt',
  ]);

  const budgetCategoryId = readUuid(
    body.budgetCategoryId,
    'budgetCategoryId',
    details,
  );
  const title = readText(body.title, 'title', MAX_TITLE_LENGTH, details);
  const amount = readMoney(body.amount, 'amount', details);
  const reason = readText(body.reason, 'reason', MAX_REASON_LENGTH, details);
  const idempotencyKey = readIdempotencyKey(body.idempotencyKey, details);

  let currency: CreateOperationalCommitmentInput['currency'] | undefined;
  if (
    typeof body.currency !== 'string' ||
    !isOperationalBudgetCurrency(body.currency.trim().toUpperCase())
  ) {
    details.push({
      field: 'currency',
      message: `currency must be one of: ${OPERATIONAL_BUDGET_CURRENCIES.join(', ')}.`,
    });
  } else {
    currency = body.currency.trim().toUpperCase() as
      CreateOperationalCommitmentInput['currency'];
  }

  const workOrderId = readOptionalUuid(body.workOrderId, 'workOrderId', details);
  const vendorId = readOptionalUuid(body.vendorId, 'vendorId', details);
  const materialRequestId = readOptionalUuid(
    body.materialRequestId,
    'materialRequestId',
    details,
  );
  const overspendOverrideReason =
    body.overspendOverrideReason === undefined ||
    body.overspendOverrideReason === null
      ? undefined
      : readText(
          body.overspendOverrideReason,
          'overspendOverrideReason',
          MAX_REASON_LENGTH,
          details,
        );

  if (
    !budgetCategoryId ||
    !title ||
    amount === undefined ||
    !reason ||
    !idempotencyKey ||
    !currency ||
    details.length
  ) {
    fail(details);
  }

  return {
    budgetCategoryId,
    title,
    amount,
    currency,
    reason,
    idempotencyKey,
    ...(workOrderId === undefined ? {} : { workOrderId }),
    ...(vendorId === undefined ? {} : { vendorId }),
    ...(materialRequestId === undefined ? {} : { materialRequestId }),
    ...(overspendOverrideReason === undefined
      ? {}
      : { overspendOverrideReason }),
  };
}

/**
 * CR-BE-COMM-VAR-01 PART 03 — PO-line commitment. Amount, currency, scope,
 * vendor and Material Request lineage are derived from the authoritative
 * ISSUED Purchase Order line and must never be supplied by the caller.
 */
export function parseCreatePoLineCommitmentBody(
  body: unknown,
): CreatePoLineCommitmentInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const details: ValidationDetail[] = [];
  rejectDerivedFields(body, details, [
    'amount',
    'committedAmount',
    'currency',
    'vendorId',
    'materialRequestId',
    'origin',
    'sourceType',
    'status',
    'clientId',
    'buildingId',
    'budgetId',
  ]);

  const purchaseOrderLineId = readUuid(
    body.purchaseOrderLineId,
    'purchaseOrderLineId',
    details,
  );
  const budgetCategoryId = readUuid(
    body.budgetCategoryId,
    'budgetCategoryId',
    details,
  );
  const idempotencyKey = readIdempotencyKey(body.idempotencyKey, details);
  const overspendOverrideReason =
    body.overspendOverrideReason === undefined ||
    body.overspendOverrideReason === null
      ? undefined
      : readText(
          body.overspendOverrideReason,
          'overspendOverrideReason',
          MAX_REASON_LENGTH,
          details,
        );

  if (!purchaseOrderLineId || !budgetCategoryId || !idempotencyKey || details.length) {
    fail(details);
  }

  return {
    purchaseOrderLineId,
    budgetCategoryId,
    idempotencyKey,
    ...(overspendOverrideReason === undefined
      ? {}
      : { overspendOverrideReason }),
  };
}

export function parseAdjustOperationalCommitmentBody(
  body: unknown,
): AdjustOperationalCommitmentInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const details: ValidationDetail[] = [];
  rejectDerivedFields(body, details, [
    'committedAmount',
    'actualizedAmount',
    'releasedAmount',
    'openAmount',
    'status',
    'budgetCategoryId',
    'currency',
  ]);

  let amount: number | undefined;
  if (
    typeof body.amount !== 'number' ||
    !Number.isFinite(body.amount) ||
    body.amount === 0
  ) {
    details.push({
      field: 'amount',
      message:
        'amount must be a finite non-zero number; positive increases and negative decreases the commitment.',
    });
  } else if (
    Math.round(Math.abs(body.amount) * 100) !==
    Number((Math.abs(body.amount) * 100).toFixed(4))
  ) {
    details.push({ field: 'amount', message: 'amount must have at most two decimals.' });
  } else {
    amount = body.amount;
  }

  const reason = readText(body.reason, 'reason', MAX_REASON_LENGTH, details);
  const idempotencyKey = readIdempotencyKey(body.idempotencyKey, details);
  const overspendOverrideReason =
    body.overspendOverrideReason === undefined ||
    body.overspendOverrideReason === null
      ? undefined
      : readText(
          body.overspendOverrideReason,
          'overspendOverrideReason',
          MAX_REASON_LENGTH,
          details,
        );

  if (amount === undefined || !reason || !idempotencyKey || details.length) {
    fail(details);
  }

  return {
    amount,
    reason,
    idempotencyKey,
    ...(overspendOverrideReason === undefined
      ? {}
      : { overspendOverrideReason }),
  };
}

export function parseCloseOperationalCommitmentBody(
  body: unknown,
): CloseOperationalCommitmentInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const details: ValidationDetail[] = [];
  rejectDerivedFields(body, details, ['amount', 'status', 'openAmount']);
  const reason = readText(body.reason, 'reason', MAX_REASON_LENGTH, details);
  const idempotencyKey = readIdempotencyKey(body.idempotencyKey, details);
  if (!reason || !idempotencyKey || details.length) fail(details);

  return { reason, idempotencyKey };
}

export function parseOperationalCommitmentFilters(
  query: unknown,
): OperationalCommitmentFilters {
  if (!isRecord(query)) return {};

  const details: ValidationDetail[] = [];
  const budgetCategoryId =
    query.budgetCategoryId === undefined
      ? undefined
      : readUuid(query.budgetCategoryId, 'budgetCategoryId', details);

  let status: OperationalCommitmentFilters['status'];
  if (query.status !== undefined) {
    if (!isOperationalCommitmentStatus(query.status)) {
      details.push({
        field: 'status',
        message: `status must be one of: ${OPERATIONAL_COMMITMENT_STATUSES.join(', ')}.`,
      });
    } else {
      status = query.status;
    }
  }

  let origin: OperationalCommitmentOrigin | undefined;
  if (query.origin !== undefined) {
    if (
      typeof query.origin !== 'string' ||
      !(OPERATIONAL_COMMITMENT_ORIGINS as readonly string[]).includes(query.origin)
    ) {
      details.push({
        field: 'origin',
        message: `origin must be one of: ${OPERATIONAL_COMMITMENT_ORIGINS.join(', ')}.`,
      });
    } else {
      origin = query.origin as OperationalCommitmentOrigin;
    }
  }

  const workOrderId =
    query.workOrderId === undefined
      ? undefined
      : readUuid(query.workOrderId, 'workOrderId', details);
  const vendorId =
    query.vendorId === undefined
      ? undefined
      : readUuid(query.vendorId, 'vendorId', details);

  if (details.length) fail(details);

  return {
    ...(budgetCategoryId === undefined ? {} : { budgetCategoryId }),
    ...(status === undefined ? {} : { status }),
    ...(origin === undefined ? {} : { origin }),
    ...(workOrderId === undefined ? {} : { workOrderId }),
    ...(vendorId === undefined ? {} : { vendorId }),
  };
}

export function parseOperationalBudgetOverspendPolicyBody(body: unknown): {
  overspendPolicy: OperationalBudgetOverspendPolicy;
  reason: string;
} {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const details: ValidationDetail[] = [];
  rejectDerivedFields(body, details, ['status', 'plannedAmount', 'currency']);

  let overspendPolicy: OperationalBudgetOverspendPolicy | undefined;
  if (!isOperationalBudgetOverspendPolicy(body.overspendPolicy)) {
    details.push({
      field: 'overspendPolicy',
      message: `overspendPolicy must be one of: ${OPERATIONAL_BUDGET_OVERSPEND_POLICIES.join(', ')}.`,
    });
  } else {
    overspendPolicy = body.overspendPolicy;
  }

  const reason = readText(body.reason, 'reason', MAX_REASON_LENGTH, details);
  if (!overspendPolicy || !reason || details.length) fail(details);

  return { overspendPolicy, reason };
}
