import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { HANDYMAN_BAST_PART02_EVENT_TYPES } from '../handyman-bast';
import type { HandymanBastPart02EventType } from '../handyman-bast';

function fail(
  field: string,
  message: string,
): never {
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

export function parseBastScopeParam(raw: string): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!isValidUuid(trimmed)) {
    fail('executionScopeId', 'executionScopeId must be a valid UUID.');
  }
  return trimmed;
}

export function parseBastIdParam(raw: string): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!isValidUuid(trimmed)) {
    fail('bastId', 'bastId must be a valid UUID.');
  }
  return trimmed;
}

export type ParsedBastSignOffBody = {
  idempotencyKey: string;
  signatureDigest: string;
  evidenceRecordId: string | null;
  rejectReason: string | null;
};

export function parseBastSignOffBody(body: unknown): ParsedBastSignOffBody {
  const obj = ensureObject(body);
  const rawKey = typeof obj.idempotencyKey === 'string'
    ? obj.idempotencyKey.trim()
    : '';
  if (rawKey.length === 0 || rawKey.length > 200) {
    fail(
      'idempotencyKey',
      'idempotencyKey is required and must be 1..200 characters.',
    );
  }

  let signatureDigest = '';
  if (obj.signatureDigest !== undefined && obj.signatureDigest !== null) {
    if (typeof obj.signatureDigest !== 'string') {
      fail('signatureDigest', 'signatureDigest must be a string.');
    }
    signatureDigest = obj.signatureDigest.trim();
    if (signatureDigest.length > 512) {
      fail(
        'signatureDigest',
        'signatureDigest must not exceed 512 characters.',
      );
    }
  }

  let evidenceRecordId: string | null = null;
  if (
    obj.evidenceRecordId !== undefined
    && obj.evidenceRecordId !== null
    && obj.evidenceRecordId !== ''
  ) {
    if (
      typeof obj.evidenceRecordId !== 'string'
      || !isValidUuid(obj.evidenceRecordId.trim())
    ) {
      fail('evidenceRecordId', 'evidenceRecordId must be a valid UUID.');
    }
    evidenceRecordId = obj.evidenceRecordId.trim();
  }

  let rejectReason: string | null = null;
  if (obj.rejectReason !== undefined && obj.rejectReason !== null) {
    if (typeof obj.rejectReason !== 'string') {
      fail('rejectReason', 'rejectReason must be a string.');
    }
    const trimmedReason = obj.rejectReason.trim();
    if (trimmedReason.length > 2000) {
      fail(
        'rejectReason',
        'rejectReason must not exceed 2000 characters.',
      );
    }
    rejectReason = trimmedReason.length > 0 ? trimmedReason : null;
  }

  return {
    idempotencyKey: rawKey,
    signatureDigest,
    evidenceRecordId,
    rejectReason,
  };
}

export function parseBastDecisionSignOffBody(
  body: unknown,
): ParsedBastSignOffBody & { decision: HandymanBastPart02EventType } {
  const obj = ensureObject(body);
  const rawDecision = typeof obj.decision === 'string'
    ? obj.decision.trim()
    : '';
  if (
    !(HANDYMAN_BAST_PART02_EVENT_TYPES as readonly string[])
      .includes(rawDecision)
  ) {
    fail('decision', 'decision must be ACCEPT or REJECT.');
  }
  const parsed = parseBastSignOffBody(obj);
  return {
    ...parsed,
    decision: rawDecision as HandymanBastPart02EventType,
  };
}
