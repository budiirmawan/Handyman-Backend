import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  HANDYMAN_LEDGER_READ_MAX_LIMIT,
  type ReadHandymanLedgerClientBasisOptions,
} from '../handyman-customer-ledger-read';
import {
  isHandymanCustomerPaymentChannel,
  type HandymanCustomerPaymentChannel,
} from '../handyman-customer-payments';

const MONEY_PATTERN = /^\d{1,16}(\.\d{1,2})$/;
const FREE_TEXT_MAX = 200;
const ISO_MAX = 40;
const LIMIT_MIN = 1;

function fail(field: string, message: string): never {
  throw AppError.validation('Request validation failed.', [
    { field, message },
  ]);
}

function ensureObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    fail('body', 'Request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}

function ensureIdempotencyKey(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw.length === 0 || raw.length > FREE_TEXT_MAX) {
    fail(
      'idempotencyKey',
      'idempotencyKey is required and must be 1..200 characters.',
    );
  }
  return raw;
}

function ensureOptionalReference(
  value: unknown,
  field: string,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    fail(field, `${field} must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > FREE_TEXT_MAX) {
    fail(field, `${field} must be 1..200 characters.`);
  }
  return trimmed;
}

export function parseCustomerLedgerScopeParam(raw: string): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!isValidUuid(trimmed)) {
    fail('executionScopeId', 'executionScopeId must be a valid UUID.');
  }
  return trimmed;
}

export function parseCustomerPaymentIdParam(raw: string): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!isValidUuid(trimmed)) {
    fail('paymentId', 'paymentId must be a valid UUID.');
  }
  return trimmed;
}

function parseQueryString(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (Array.isArray(value)) {
    fail(field, `${field} must be a single string value.`);
  }
  if (typeof value !== 'string') {
    fail(field, `${field} must be a string.`);
  }
  return value.trim();
}

export function parseCustomerLedgerClientBasisQuery(
  query: Record<string, unknown>,
): {
  clientId: string;
  options: ReadHandymanLedgerClientBasisOptions;
} {
  const rawClientId = parseQueryString(query.clientId, 'clientId');
  if (!rawClientId || !isValidUuid(rawClientId)) {
    fail('clientId', 'clientId is required and must be a valid UUID.');
  }

  const rawFrom = parseQueryString(query.from, 'from');
  let from: string | null | undefined;
  if (rawFrom !== undefined) {
    if (
      rawFrom.length === 0
      || rawFrom.length > ISO_MAX
      || Number.isNaN(Date.parse(rawFrom))
    ) {
      fail('from', 'from must be a valid ISO-8601 timestamp.');
    }
    from = new Date(rawFrom).toISOString();
  }

  const rawTo = parseQueryString(query.to, 'to');
  let to: string | null | undefined;
  if (rawTo !== undefined) {
    if (
      rawTo.length === 0
      || rawTo.length > ISO_MAX
      || Number.isNaN(Date.parse(rawTo))
    ) {
      fail('to', 'to must be a valid ISO-8601 timestamp.');
    }
    to = new Date(rawTo).toISOString();
  }

  if (from && to && from >= to) {
    fail('window', 'from must be earlier than to.');
  }

  const rawLimit = parseQueryString(query.limit, 'limit');
  let limit: number | undefined;
  if (rawLimit !== undefined) {
    if (!/^\d+$/.test(rawLimit)) {
      fail(
        'limit',
        `limit must be an integer between ${LIMIT_MIN} and ${HANDYMAN_LEDGER_READ_MAX_LIMIT}.`,
      );
    }
    const parsedLimit = Number.parseInt(rawLimit, 10);
    if (
      !Number.isInteger(parsedLimit)
      || parsedLimit < LIMIT_MIN
      || parsedLimit > HANDYMAN_LEDGER_READ_MAX_LIMIT
    ) {
      fail(
        'limit',
        `limit must be an integer between ${LIMIT_MIN} and ${HANDYMAN_LEDGER_READ_MAX_LIMIT}.`,
      );
    }
    limit = parsedLimit;
  }

  return {
    clientId: rawClientId,
    options: {
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      ...(limit !== undefined ? { limit } : {}),
    },
  };
}

export type ParsedRecordCustomerPaymentBody = {
  amount: string;
  channel: HandymanCustomerPaymentChannel;
  providerName: string | null;
  providerReference: string | null;
  externalReference: string | null;
  idempotencyKey: string;
};

export function parseRecordCustomerPaymentBody(
  body: unknown,
): ParsedRecordCustomerPaymentBody {
  const obj = ensureObject(body);
  const idempotencyKey = ensureIdempotencyKey(obj.idempotencyKey);

  const rawAmount = typeof obj.amount === 'string' ? obj.amount.trim() : '';
  if (!MONEY_PATTERN.test(rawAmount) || Number(rawAmount) <= 0) {
    fail(
      'amount',
      'amount must be a positive canonical decimal string (e.g. "100.00").',
    );
  }

  const rawChannel = typeof obj.channel === 'string'
    ? obj.channel.trim()
    : '';
  if (!isHandymanCustomerPaymentChannel(rawChannel)) {
    fail(
      'channel',
      'channel must be one of CASH, BANK_TRANSFER, VIRTUAL_ACCOUNT, QRIS, CARD, OTHER.',
    );
  }

  return {
    amount: rawAmount,
    channel: rawChannel,
    providerName: ensureOptionalReference(obj.providerName, 'providerName'),
    providerReference: ensureOptionalReference(
      obj.providerReference,
      'providerReference',
    ),
    externalReference: ensureOptionalReference(
      obj.externalReference,
      'externalReference',
    ),
    idempotencyKey,
  };
}

export function parseConfirmCustomerPaymentBody(
  body: unknown,
): { idempotencyKey: string } {
  const obj = ensureObject(body);
  return {
    idempotencyKey: ensureIdempotencyKey(obj.idempotencyKey),
  };
}

export function parseRejectCustomerPaymentBody(
  body: unknown,
): { idempotencyKey: string; reason: string } {
  const obj = ensureObject(body);
  const idempotencyKey = ensureIdempotencyKey(obj.idempotencyKey);
  const reason = ensureOptionalReference(obj.reason, 'reason');
  if (reason === null) {
    fail('reason', 'reason is required and must be 1..200 characters.');
  }
  return {
    idempotencyKey,
    reason,
  };
}
