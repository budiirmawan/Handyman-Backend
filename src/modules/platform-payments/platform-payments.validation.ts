/**
 * CR-BE-SAAS-01 PART 07 — Payment & Reconciliation validation (frozen §15).
 *
 * Validation intentionally rejects all fields that would let a caller
 * externally assert a payment is RECONCILED, an invoice is PAID, or a
 * subscription is ACTIVE — every commercial state transition belongs to a
 * server-owned command path (frozen D7: no auto-reactivation).
 */
import type {
  IngestSaasPaymentInput,
  ReconcileSaasPaymentInput,
  RejectSaasPaymentInput,
  SaasPaymentProviderType,
} from './platform-payments.types';

const SAAS_PAYMENT_PROVIDER_TYPES_SET: ReadonlySet<string> = new Set([
  'MANUAL_TRANSFER',
  'VIRTUAL_ACCOUNT',
  'QRIS',
  'CARD',
  'PAYMENT_GATEWAY',
  'OTHER',
]);

/** Canonical NUMERIC(18,2) amount pattern. Up to 16 integer digits, 2 fractional. */
const AMOUNT_PATTERN = /^-?\d{1,16}\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const ISO_8601_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

const FORBIDDEN_INGEST_KEYS: ReadonlySet<string> = new Set([
  // Caller MUST NOT assert the payment is already RECONCILED.
  'status',
  'reconciledAt',
  'reconciledByUserId',
  'rejectionReason',
  'version',
  // Caller MUST NOT mutate commercial state:
  'invoiceId',
  'paidAt',
  'paid',
]);

const FORBIDDEN_RECONCILE_KEYS: ReadonlySet<string> = new Set([
  'paymentId',
  'payment',
  'status',
  'reconciliationId',
  'version',
]);

export interface PaymentValidationFailure {
  field: string;
  message: string;
}

export interface PaymentValidationResult<T> {
  value?: T;
  failures: PaymentValidationFailure[];
}

function ensureString(
  obj: Record<string, unknown>,
  key: string,
  maxLen: number,
): string | null | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > maxLen) return undefined;
  return trimmed;
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function rejectForbiddenIngestKeys(
  body: unknown,
): PaymentValidationFailure[] {
  if (!isStringRecord(body)) {
    return [{ field: 'body', message: 'body must be a JSON object.' }];
  }
  const failures: PaymentValidationFailure[] = [];
  for (const k of FORBIDDEN_INGEST_KEYS) {
    if (Object.prototype.hasOwnProperty.call(body, k)) {
      failures.push({
        field: k,
        message: `Field "${k}" is not permitted on payment ingestion.`,
      });
    }
  }
  return failures;
}

export function rejectForbiddenReconcileKeys(
  body: unknown,
): PaymentValidationFailure[] {
  if (!isStringRecord(body)) {
    return [{ field: 'body', message: 'body must be a JSON object.' }];
  }
  const failures: PaymentValidationFailure[] = [];
  for (const k of FORBIDDEN_RECONCILE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(body, k)) {
      failures.push({
        field: k,
        message: `Field "${k}" is not permitted on the reconcile command.`,
      });
    }
  }
  return failures;
}

export function parseIngestSaasPaymentInput(
  body: unknown,
): PaymentValidationResult<IngestSaasPaymentInput> {
  if (!isStringRecord(body)) {
    return { failures: [{ field: 'body', message: 'body must be a JSON object.' }] };
  }
  const failures: PaymentValidationFailure[] = [];

  const billingAccountId = ensureString(body, 'billingAccountId', 64);
  if (!billingAccountId) {
    failures.push({
      field: 'billingAccountId',
      message: 'billingAccountId is required.',
    });
  }

  const customerId = ensureString(body, 'customerId', 64);
  if (!customerId) {
    failures.push({
      field: 'customerId',
      message: 'customerId is required.',
    });
  }

  const providerTypeRaw = body.providerType;
  if (
    typeof providerTypeRaw !== 'string' ||
    !SAAS_PAYMENT_PROVIDER_TYPES_SET.has(providerTypeRaw)
  ) {
    failures.push({
      field: 'providerType',
      message:
        'providerType must be one of MANUAL_TRANSFER | VIRTUAL_ACCOUNT | QRIS | CARD | PAYMENT_GATEWAY | OTHER.',
    });
  }
  const providerType = providerTypeRaw as SaasPaymentProviderType;

  const providerName = ensureString(body, 'providerName', 200) ?? null;
  const providerReference = ensureString(body, 'providerReference', 200) ?? null;
  if (
    providerReference &&
    /\s/.test(providerReference) &&
    !providerReference.startsWith('ref-')
  ) {
    failures.push({
      field: 'providerReference',
      message: 'providerReference must not contain whitespace.',
    });
  }

  const amountRaw = body.amount;
  let amount: string | null = null;
  if (typeof amountRaw !== 'string' || !AMOUNT_PATTERN.test(amountRaw.trim())) {
    failures.push({
      field: 'amount',
      message:
        'amount must be a NUMERIC(18,2) string (e.g. "0.00" or "1234567890123456.78").',
    });
  } else {
    amount = amountRaw.trim();
    // PART 07 invariant: payment amount > 0 (DB CHECK enforces too).
    if (amount === '0.00' || amount === '-0.00') {
      failures.push({
        field: 'amount',
        message: 'amount must be greater than 0.',
      });
    }
  }

  const currencyCodeRaw = body.currencyCode;
  if (
    typeof currencyCodeRaw !== 'string' ||
    !CURRENCY_PATTERN.test(currencyCodeRaw.trim())
  ) {
    failures.push({
      field: 'currencyCode',
      message: 'currencyCode must be an ISO-4217 3-letter uppercase code.',
    });
  }
  const currencyCode =
    typeof currencyCodeRaw === 'string' ? currencyCodeRaw.trim() : '';

  const receivedAtRaw = body.receivedAt;
  let receivedAt: string | null = null;
  if (receivedAtRaw === undefined) {
    receivedAt = null;
  } else if (
    typeof receivedAtRaw !== 'string' ||
    !ISO_8601_PATTERN.test(receivedAtRaw.trim())
  ) {
    failures.push({
      field: 'receivedAt',
      message: 'receivedAt must be an ISO 8601 timestamp when supplied.',
    });
  } else {
    receivedAt = receivedAtRaw.trim();
  }

  const externalReference = ensureString(body, 'externalReference', 200) ?? null;
  const reason = ensureString(body, 'reason', 500) ?? null;

  let expectedVersion = 1;
  const expectedVersionRaw = body.expectedVersion;
  if (
    expectedVersionRaw !== undefined &&
    expectedVersionRaw !== null &&
    typeof expectedVersionRaw === 'number' &&
    Number.isInteger(expectedVersionRaw) &&
    expectedVersionRaw >= 1
  ) {
    expectedVersion = expectedVersionRaw;
  } else if (expectedVersionRaw !== undefined && expectedVersionRaw !== null) {
    failures.push({
      field: 'expectedVersion',
      message: 'expectedVersion must be an integer ≥ 1 when supplied.',
    });
  }

  if (failures.length > 0) return { failures };

  return {
    value: {
      billingAccountId: billingAccountId!,
      customerId: customerId!,
      providerType,
      providerName,
      providerReference,
      amount: amount!,
      currencyCode,
      ...(receivedAt !== null ? { receivedAt } : {}),
      externalReference,
      reason,
      expectedVersion,
    },
    failures,
  };
}

export function parseReconcileSaasPaymentInput(
  body: unknown,
): PaymentValidationResult<ReconcileSaasPaymentInput> {
  if (!isStringRecord(body)) {
    return { failures: [{ field: 'body', message: 'body must be a JSON object.' }] };
  }
  const failures: PaymentValidationFailure[] = [];

  let expectedVersion = 1;
  const expectedVersionRaw = body.expectedVersion;
  if (
    expectedVersionRaw !== undefined &&
    expectedVersionRaw !== null &&
    typeof expectedVersionRaw === 'number' &&
    Number.isInteger(expectedVersionRaw) &&
    expectedVersionRaw >= 1
  ) {
    expectedVersion = expectedVersionRaw;
  } else {
    failures.push({
      field: 'expectedVersion',
      message: 'expectedVersion is required and must be an integer ≥ 1.',
    });
  }

  if (!Array.isArray(body.allocations) || body.allocations.length === 0) {
    failures.push({
      field: 'allocations',
      message: 'allocations must be a non-empty array.',
    });
    return { failures };
  }

  const allocations: ReconcileSaasPaymentInput['allocations'] = [];
  for (let i = 0; i < body.allocations.length; i += 1) {
    const item = body.allocations[i];
    if (!isStringRecord(item)) {
      failures.push({
        field: `allocations[${i}]`,
        message: 'allocation must be a JSON object.',
      });
      continue;
    }
    const invoiceId = ensureString(item, 'invoiceId', 64);
    if (!invoiceId) {
      failures.push({
        field: `allocations[${i}].invoiceId`,
        message: 'invoiceId is required.',
      });
    }
    const amountRaw = item.amount;
    let amount: string | null = null;
    if (typeof amountRaw !== 'string' || !AMOUNT_PATTERN.test(amountRaw.trim())) {
      failures.push({
        field: `allocations[${i}].amount`,
        message:
          'amount must be a NUMERIC(18,2) string strictly greater than 0.',
      });
    } else {
      amount = amountRaw.trim();
      if (amount === '0.00' || amount === '-0.00') {
        failures.push({
          field: `allocations[${i}].amount`,
          message: 'amount must be greater than 0.',
        });
      }
    }
    let allocationExpected = 1;
    const allocationExpectedRaw = item.expectedVersion;
    if (
      allocationExpectedRaw === undefined ||
      allocationExpectedRaw === null ||
      typeof allocationExpectedRaw !== 'number' ||
      !Number.isInteger(allocationExpectedRaw) ||
      allocationExpectedRaw < 1
    ) {
      failures.push({
        field: `allocations[${i}].expectedVersion`,
        message:
          'allocation.expectedVersion is required and must be an integer ≥ 1.',
      });
    } else {
      allocationExpected = allocationExpectedRaw;
    }
    if (invoiceId && amount && allocationExpected >= 1) {
      allocations.push({
        invoiceId,
        amount,
        expectedVersion: allocationExpected,
      });
    }
  }

  if (failures.length > 0) return { failures };

  const reason = ensureString(body, 'reason', 500) ?? null;
  return {
    value: {
      allocations,
      reason,
      expectedVersion,
    },
    failures,
  };
}

export function parseRejectSaasPaymentInput(
  body: unknown,
): PaymentValidationResult<RejectSaasPaymentInput> {
  if (!isStringRecord(body)) {
    return { failures: [{ field: 'body', message: 'body must be a JSON object.' }] };
  }
  const failures: PaymentValidationFailure[] = [];

  const rejectionReason = ensureString(body, 'rejectionReason', 500);
  if (!rejectionReason) {
    failures.push({
      field: 'rejectionReason',
      message: 'rejectionReason is required (frozen §22 / §15.3 reject semantics).',
    });
  }

  let expectedVersion = 1;
  const expectedVersionRaw = body.expectedVersion;
  if (
    expectedVersionRaw !== undefined &&
    expectedVersionRaw !== null &&
    typeof expectedVersionRaw === 'number' &&
    Number.isInteger(expectedVersionRaw) &&
    expectedVersionRaw >= 1
  ) {
    expectedVersion = expectedVersionRaw;
  } else {
    failures.push({
      field: 'expectedVersion',
      message: 'expectedVersion is required and must be an integer ≥ 1.',
    });
  }

  if (failures.length > 0) return { failures };
  return {
    value: {
      rejectionReason: rejectionReason!,
      expectedVersion,
    },
    failures,
  };
}

export function isValidPaymentId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
