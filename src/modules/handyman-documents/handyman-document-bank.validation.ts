/**
 * CR-HM-DOCUMENT-PROFILE-01 PART 01B — bank account input validation.
 *
 * Strict and structural, mirroring migration 0491 one rule at a time: what this
 * file accepts the database stores, and what the database would refuse is
 * already explained by a field-level detail. Two things are deliberately absent
 * from the writable vocabulary:
 *
 *   - STATUS, DEFAULT, VERIFICATION and any identity field. A caller cannot ask
 *     to be ACTIVE, cannot set `isDefault`, cannot stamp `verifiedAt`, and
 *     cannot name another provider: those are lifecycle facts produced only by
 *     the activation contract below, so no write path can escalate itself into
 *     being a payment destination;
 *   - any echo of a rejected value. Details name the FIELD only, so a malformed
 *     account number never lands in a response body or a log line.
 */
import { parseClientIdParam } from './handyman-document-issuer.validation';
import type { FieldIssue } from './handyman-document-issuer.validation';
import { handymanDocumentBankAccountValidationError } from './handyman-document-bank.errors';
import {
  HANDYMAN_DOCUMENT_BANK_ACCOUNT_CONTENT_FIELDS,
  HANDYMAN_DOCUMENT_BANK_ACCOUNT_STATUSES,
  type ActivateHandymanDocumentBankAccountInput,
  type CreateHandymanDocumentBankAccountInput,
  type DeactivateHandymanDocumentBankAccountInput,
  type HandymanDocumentBankAccountContentField,
  type HandymanDocumentBankAccountStatus,
  type UpdateHandymanDocumentBankAccountInput,
} from './handyman-document-bank.types';

export { parseClientIdParam };
export type HandymanDocumentBankAccountListFilter = {
  currency: string | null;
  status: HandymanDocumentBankAccountStatus | null;
  limit: number;
};

export const HANDYMAN_DOCUMENT_BANK_ACCOUNT_LIST_DEFAULT_LIMIT = 50;
export const HANDYMAN_DOCUMENT_BANK_ACCOUNT_LIST_MAX_LIMIT = 100;

const LIMITS: Record<HandymanDocumentBankAccountContentField | 'verificationReference', number> = {
  bankCode: 16,
  bankName: 200,
  accountNumber: 34,
  accountHolderName: 200,
  currency: 3,
  verificationReference: 300,
};

const PATTERNS: Partial<Record<HandymanDocumentBankAccountContentField, RegExp>> = {
  bankCode: /^[A-Z][A-Z0-9]{1,15}$/,
  accountNumber: /^[A-Za-z0-9-]{4,34}$/,
  currency: /^[A-Z]{3}$/,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Collapses whitespace runs; it never rewrites the text itself. */
function normalizeText(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Grouped digits are input formatting, not data: `1370-0001-23456` and
 * `1370000123456` are the same account. Dashes that the bank itself uses are
 * kept, and nothing else is stripped or re-ordered.
 */
function normalizeAccountNumber(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, '');
}

function isPlainBody(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function rejectUnknownKeys(
  body: Record<string, unknown>,
  allowed: readonly string[],
  issues: FieldIssue[],
): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      issues.push({
        field: key,
        message: 'Unsupported field for the Handyman document bank account.',
      });
    }
  }
}

function readContent(
  body: Record<string, unknown>,
  issues: FieldIssue[],
): Record<HandymanDocumentBankAccountContentField, string> | null {
  const values = {} as Record<HandymanDocumentBankAccountContentField, string>;
  for (const field of HANDYMAN_DOCUMENT_BANK_ACCOUNT_CONTENT_FIELDS) {
    const raw = body[field];
    if (typeof raw !== 'string') {
      issues.push({
        field,
        message: raw === undefined ? `${field} is required.` : `${field} must be a string.`,
      });
      continue;
    }
    const value =
      field === 'accountNumber'
        ? normalizeAccountNumber(raw)
        : // bankCode and currency are closed vocabularies, not free text: an
          // internal space is a malformed code, never something to silently
          // delete on the way in.
          field === 'bankCode' || field === 'currency'
          ? normalizeText(raw).toUpperCase()
          : normalizeText(raw);
    if (value === '') {
      issues.push({ field, message: `${field} cannot be blank.` });
      continue;
    }
    if (value.length > LIMITS[field]) {
      issues.push({ field, message: `${field} must not exceed ${LIMITS[field]} characters.` });
      continue;
    }
    const pattern = PATTERNS[field];
    if (pattern && !pattern.test(value)) {
      issues.push({ field, message: `${field} is not in an accepted format.` });
      continue;
    }
    if (field === 'accountNumber' && !/[0-9]/.test(value)) {
      issues.push({ field, message: 'accountNumber must contain digits.' });
      continue;
    }
    if ((field === 'bankName' || field === 'accountHolderName') && !/[A-Za-z0-9]/.test(value)) {
      issues.push({ field, message: `${field} must contain letters or digits.` });
      continue;
    }
    values[field] = value;
  }
  return Object.keys(values).length === HANDYMAN_DOCUMENT_BANK_ACCOUNT_CONTENT_FIELDS.length
    ? values
    : null;
}

function readExpectedVersion(
  body: Record<string, unknown>,
  issues: FieldIssue[],
  { required }: { required: boolean },
): number | null {
  const raw = body.expectedVersion;
  if (raw === undefined) {
    if (required) {
      issues.push({
        field: 'expectedVersion',
        message: 'expectedVersion is required: send the version you read.',
      });
    }
    return null;
  }
  if (!Number.isInteger(raw) || (raw as number) < 1) {
    issues.push({ field: 'expectedVersion', message: 'expectedVersion must be a positive integer.' });
    return null;
  }
  return raw as number;
}

function readBoolean(
  body: Record<string, unknown>,
  field: string,
  fallback: boolean,
  issues: FieldIssue[],
): boolean {
  const raw = body[field];
  if (raw === undefined) return fallback;
  if (typeof raw !== 'boolean') {
    issues.push({ field, message: `${field} must be a boolean.` });
    return fallback;
  }
  return raw;
}

export function parseBankAccountIdParam(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || !UUID.test(raw)) {
    throw handymanDocumentBankAccountValidationError([
      { field: 'bankAccountId', message: 'bankAccountId must be a valid UUID.' },
    ]);
  }
  return raw.toLowerCase();
}

export function parseBankAccountCreate(
  body: unknown,
  clientId: string,
): CreateHandymanDocumentBankAccountInput {
  const issues: FieldIssue[] = [];
  if (!isPlainBody(body)) {
    throw handymanDocumentBankAccountValidationError([
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }
  rejectUnknownKeys(body, [...HANDYMAN_DOCUMENT_BANK_ACCOUNT_CONTENT_FIELDS], issues);
  const content = readContent(body, issues);
  if (issues.length > 0 || !content) {
    throw handymanDocumentBankAccountValidationError(
      issues.length > 0
        ? issues
        : [{ field: 'body', message: 'A complete account must be supplied.' }],
    );
  }
  return { clientId, ...content };
}

export function parseBankAccountUpdate(
  body: unknown,
  clientId: string,
  bankAccountId: string,
): UpdateHandymanDocumentBankAccountInput {
  const issues: FieldIssue[] = [];
  if (!isPlainBody(body)) {
    throw handymanDocumentBankAccountValidationError([
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }
  rejectUnknownKeys(body, [...HANDYMAN_DOCUMENT_BANK_ACCOUNT_CONTENT_FIELDS, 'expectedVersion'], issues);
  const expectedVersion = readExpectedVersion(body, issues, { required: true });
  const content = readContent(body, issues);
  if (issues.length > 0 || !content || expectedVersion === null) {
    throw handymanDocumentBankAccountValidationError(
      issues.length > 0
        ? issues
        : [{ field: 'body', message: 'A complete replacement account must be supplied.' }],
    );
  }
  return { clientId, bankAccountId, expectedVersion, ...content };
}

export function parseBankAccountActivation(
  body: unknown,
  clientId: string,
  bankAccountId: string,
): ActivateHandymanDocumentBankAccountInput {
  const issues: FieldIssue[] = [];
  const allowed = [
    'expectedVersion',
    'confirmAccountNumber',
    'verificationReference',
    'asDefault',
    'authorizeReplacement',
  ];
  if (!isPlainBody(body)) {
    throw handymanDocumentBankAccountValidationError([
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }
  rejectUnknownKeys(body, allowed, issues);
  const expectedVersion = readExpectedVersion(body, issues, { required: true });
  const confirmRaw = body.confirmAccountNumber;
  if (typeof confirmRaw !== 'string' || confirmRaw.trim() === '') {
    issues.push({
      field: 'confirmAccountNumber',
      message:
        'confirmAccountNumber is required: retype the stored account number to confirm this verification.',
    });
  }
  const referenceRaw = body.verificationReference;
  const verificationReference = typeof referenceRaw === 'string' ? normalizeText(referenceRaw) : '';
  if (verificationReference === '') {
    issues.push({
      field: 'verificationReference',
      message:
        'verificationReference is required: name the evidence checked (bank letter, teller print, verified document).',
    });
  } else if (verificationReference.length > LIMITS.verificationReference) {
    issues.push({
      field: 'verificationReference',
      message: `verificationReference must not exceed ${LIMITS.verificationReference} characters.`,
    });
  }
  const asDefault = readBoolean(body, 'asDefault', true, issues);
  const authorizeReplacement = readBoolean(body, 'authorizeReplacement', false, issues);
  if (issues.length > 0 || expectedVersion === null) {
    throw handymanDocumentBankAccountValidationError(issues);
  }
  return {
    clientId,
    bankAccountId,
    expectedVersion,
    confirmAccountNumber: normalizeAccountNumber(confirmRaw),
    verificationReference,
    asDefault,
    authorizeReplacement,
  };
}

export function parseBankAccountDeactivation(
  body: unknown,
  clientId: string,
  bankAccountId: string,
): DeactivateHandymanDocumentBankAccountInput {
  const issues: FieldIssue[] = [];
  if (!isPlainBody(body)) {
    throw handymanDocumentBankAccountValidationError([
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }
  rejectUnknownKeys(body, ['expectedVersion', 'reason', 'confirmLossOfDefault'], issues);
  const expectedVersion = readExpectedVersion(body, issues, { required: true });
  const reasonRaw = body.reason;
  const reason = typeof reasonRaw === 'string' ? normalizeText(reasonRaw) : '';
  if (reason.length < 3) {
    issues.push({
      field: 'reason',
      message: 'reason is required: a receiving account is retired with a stated reason.',
    });
  } else if (reason.length > LIMITS.verificationReference) {
    issues.push({
      field: 'reason',
      message: `reason must not exceed ${LIMITS.verificationReference} characters.`,
    });
  }
  const confirmLossOfDefault = readBoolean(body, 'confirmLossOfDefault', false, issues);
  if (issues.length > 0 || expectedVersion === null) {
    throw handymanDocumentBankAccountValidationError(issues);
  }
  return { clientId, bankAccountId, expectedVersion, reason, confirmLossOfDefault };
}

export function parseBankAccountListQuery(
  query: Record<string, unknown>,
): HandymanDocumentBankAccountListFilter {
  const issues: FieldIssue[] = [];
  for (const key of Object.keys(query)) {
    if (!['currency', 'status', 'limit'].includes(key)) {
      issues.push({ field: 'query', message: `Unsupported query parameter "${key}".` });
    }
  }
  const single = (name: string): string | null => {
    const raw = Array.isArray(query[name]) ? (query[name] as unknown[])[0] : query[name];
    return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
  };
  const currencyRaw = single('currency');
  const currency = currencyRaw === null ? null : currencyRaw.toUpperCase();
  if (currency !== null && !/^[A-Z]{3}$/.test(currency)) {
    issues.push({ field: 'currency', message: 'currency must be an ISO-4217 3-letter code.' });
  }
  const status = single('status');
  if (status !== null && !(HANDYMAN_DOCUMENT_BANK_ACCOUNT_STATUSES as readonly string[]).includes(status)) {
    issues.push({
      field: 'status',
      message: `status must be one of: ${HANDYMAN_DOCUMENT_BANK_ACCOUNT_STATUSES.join(', ')}.`,
    });
  }
  let limit = HANDYMAN_DOCUMENT_BANK_ACCOUNT_LIST_DEFAULT_LIMIT;
  const limitRaw = single('limit');
  if (limitRaw !== null) {
    const parsed = Number(limitRaw);
    if (
      !Number.isInteger(parsed)
      || parsed < 1
      || parsed > HANDYMAN_DOCUMENT_BANK_ACCOUNT_LIST_MAX_LIMIT
    ) {
      issues.push({
        field: 'limit',
        message: `limit must be an integer between 1 and ${HANDYMAN_DOCUMENT_BANK_ACCOUNT_LIST_MAX_LIMIT}.`,
      });
    } else {
      limit = parsed;
    }
  }
  if (issues.length > 0) throw handymanDocumentBankAccountValidationError(issues);
  return {
    currency,
    status: status === null ? null : (status as HandymanDocumentBankAccountStatus),
    limit,
  };
}

/** History listing reuses the issuer profile's bounded `limit` contract. */
export { parseHistoryQuery as parseBankAccountHistoryQuery } from './handyman-document-issuer.validation';
