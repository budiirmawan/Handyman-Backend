import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  HANDYMAN_LEDGER_READ_MAX_LIMIT,
  type ReadHandymanLedgerClientBasisOptions,
} from '../handyman-customer-ledger-read';
import {
  isHandymanCustomerPaymentChannel,
  isHandymanCustomerPaymentObligationStage,
  type HandymanCustomerPaymentChannel,
  type HandymanCustomerPaymentObligationStage,
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

  const rawBuildingId = parseQueryString(query.buildingId, 'buildingId');
  let buildingId: string | null | undefined;
  if (rawBuildingId !== undefined) {
    if (!isValidUuid(rawBuildingId)) {
      fail('buildingId', 'buildingId must be a valid UUID.');
    }
    buildingId = rawBuildingId;
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
      ...(buildingId !== undefined ? { buildingId } : {}),
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      ...(limit !== undefined ? { limit } : {}),
    },
  };
}

export type ParsedRecordCustomerPaymentBody = {
  amount: string;
  channel: HandymanCustomerPaymentChannel;
  obligationStage: HandymanCustomerPaymentObligationStage;
  providerName: string | null;
  providerReference: string | null;
  externalReference: string | null;
  idempotencyKey: string;
};

function parseOptionalObligationStage(
  value: unknown,
): HandymanCustomerPaymentObligationStage {
  if (value === undefined || value === null) return 'PELUNASAN';
  if (typeof value !== 'string') {
    fail('obligationStage', 'obligationStage must be one of DP, TERMIN, PELUNASAN.');
  }
  const normalized = value.trim().toUpperCase();
  if (normalized === 'DOWN_PAYMENT') return 'DP';
  if (normalized === 'INSTALLMENT') return 'TERMIN';
  if (normalized === 'FINAL_BALANCE') return 'PELUNASAN';
  if (!isHandymanCustomerPaymentObligationStage(normalized)) {
    fail('obligationStage', 'obligationStage must be one of DP, TERMIN, PELUNASAN.');
  }
  return normalized;
}

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

  const obligationStage = parseOptionalObligationStage(
    obj.obligationStage ?? obj.paymentStage ?? obj.paymentType,
  );

  return {
    amount: rawAmount,
    channel: rawChannel,
    obligationStage,
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
): {
  idempotencyKey: string;
  bankReceiptAttestation?: {
    destinationBankAccountId: string;
    bankTransactionId: string;
    amountCredited: string;
    bankCreditedAt: string;
    bankStatementEvidenceRef?: string | null;
  } | null;
} {
  const obj = ensureObject(body);
  const idempotencyKey = ensureIdempotencyKey(obj.idempotencyKey);

  // CR-HM-FINANCE-BANK-RECEIPT-ATTESTATION-01 — optional at validation layer,
  // required at service layer (to allow legacy callers to receive 400 with
  // domain code instead of generic validation, and to keep replay idempotency deterministic).
  // We parse it here if present, returning null if absent so service can enforce.
  let bankReceiptAttestation: {
    destinationBankAccountId: string;
    bankTransactionId: string;
    amountCredited: string;
    bankCreditedAt: string;
    bankStatementEvidenceRef?: string | null;
  } | null = null;

  const rawAtt =
    (obj.bankReceiptAttestation as Record<string, unknown> | undefined) ??
    (obj.bankReceipt as Record<string, unknown> | undefined) ??
    (obj.attestation as Record<string, unknown> | undefined);

  // Also support flat top-level fields for convenience
  const flatCandidate =
    obj.destinationBankAccountId !== undefined ||
    obj.bankTransactionId !== undefined ||
    obj.bankReferenceId !== undefined;

  const src: Record<string, unknown> | null = rawAtt
    ? (rawAtt as Record<string, unknown>)
    : flatCandidate
      ? obj
      : null;

  if (src) {
    // We strictly validate structure if the caller attempted to provide attestation
    const destIdRaw = typeof src.destinationBankAccountId === 'string' ? src.destinationBankAccountId.trim() : '';
    const bankTxRaw =
      typeof src.bankTransactionId === 'string'
        ? src.bankTransactionId.trim()
        : typeof src.bankReferenceId === 'string'
          ? src.bankReferenceId.trim()
          : '';
    const amountRaw =
      typeof src.amountCredited === 'string'
        ? src.amountCredited.trim()
        : typeof src.amount === 'string'
          ? src.amount.trim()
          : '';
    const creditedAtRaw =
      typeof src.bankCreditedAt === 'string'
        ? src.bankCreditedAt.trim()
        : typeof src.bankCreditDate === 'string'
          ? src.bankCreditDate.trim()
          : '';

    // If any of the core fields are present, we treat it as an attestation attempt and validate fully
    const hasAny = destIdRaw || bankTxRaw || amountRaw || creditedAtRaw;
    if (hasAny) {
      if (!isValidUuid(destIdRaw)) {
        fail('destinationBankAccountId', 'destinationBankAccountId must be a valid UUID.');
      }
      if (bankTxRaw.length === 0 || bankTxRaw.length > FREE_TEXT_MAX) {
        fail('bankTransactionId', 'bankTransactionId must be 1..200 characters.');
      }
      if (!MONEY_PATTERN.test(amountRaw) || Number(amountRaw) <= 0) {
        fail('amountCredited', 'amountCredited must be a positive canonical decimal string (e.g. \"100.00\").');
      }
      if (!creditedAtRaw || Number.isNaN(Date.parse(creditedAtRaw))) {
        fail('bankCreditedAt', 'bankCreditedAt must be a valid ISO-8601 timestamp.');
      }
      // Evidence ref optional
      let evidenceRef: string | null = null;
      const evRaw = src.bankStatementEvidenceRef ?? src.evidenceRef ?? src.statementRef;
      if (evRaw !== undefined && evRaw !== null) {
        if (typeof evRaw !== 'string') fail('bankStatementEvidenceRef', 'bankStatementEvidenceRef must be a string.');
        const tr = (evRaw as string).trim();
        if (tr.length === 0 || tr.length > 500) fail('bankStatementEvidenceRef', 'bankStatementEvidenceRef must be 1..500 characters.');
        evidenceRef = tr;
      }

      bankReceiptAttestation = {
        destinationBankAccountId: destIdRaw,
        bankTransactionId: bankTxRaw,
        amountCredited: amountRaw,
        bankCreditedAt: new Date(creditedAtRaw).toISOString(),
        bankStatementEvidenceRef: evidenceRef,
      };
    }
  }

  return {
    idempotencyKey,
    bankReceiptAttestation,
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
