import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import type { CreateSecureLinkInput } from './secure-link.types';

/**
 * BE-26J — Secure link validation.
 *
 * HTTP-level parsing only. `targetEntityType` and `action` are uppercase
 * codes; `expiresAt` must be in the future; `maxUses` is a positive integer
 * (default 1 = one-time).
 */

type ValidationDetail = { field: string; message: string };

const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(details: ValidationDetail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

function code(
  value: unknown,
  field: string,
  required: boolean,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined && !required) {
    return undefined;
  }
  if (typeof value !== 'string' || !CODE_PATTERN.test(value.trim().toUpperCase())) {
    details.push({
      field,
      message: `${field} must be an uppercase code (letters, digits, underscore).`,
    });
    return undefined;
  }
  return value.trim().toUpperCase();
}

function uuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || !isValidUuid(value.trim().toLowerCase())) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function futureTimestamp(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    details.push({ field: 'expiresAt', message: 'expiresAt must be a valid ISO timestamp.' });
    return undefined;
  }
  const at = new Date(value);
  if (at.getTime() <= Date.now()) {
    details.push({ field: 'expiresAt', message: 'expiresAt must be in the future.' });
    return undefined;
  }
  return at.toISOString();
}

function positiveInt(
  value: unknown,
  details: ValidationDetail[],
): number | undefined {
  if (value === undefined) {
    return 1;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    details.push({ field: 'maxUses', message: 'maxUses must be an integer >= 1.' });
    return undefined;
  }
  return value;
}

export function parseCreateSecureLinkBody(body: unknown): CreateSecureLinkInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const details: ValidationDetail[] = [];
  const clientId = uuid(body.clientId, 'clientId', details);
  const recipientUserId = uuid(body.recipientUserId, 'recipientUserId', details);
  const targetEntityType = code(body.targetEntityType, 'targetEntityType', true, details);
  const targetEntityId = uuid(body.targetEntityId, 'targetEntityId', details);
  const action = code(body.action, 'action', true, details);
  const expiresAt = futureTimestamp(body.expiresAt, details);
  const maxUses = positiveInt(body.maxUses, details);

  if (details.length > 0) {
    fail(details);
  }

  return {
    clientId: clientId as string,
    recipientUserId: recipientUserId as string,
    targetEntityType: targetEntityType as string,
    targetEntityId: targetEntityId as string,
    action: action as string,
    expiresAt: expiresAt as string,
    maxUses,
  };
}

export function parseResolveSecureLinkBody(
  body: unknown,
): { token: string } {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  if (typeof body.token !== 'string' || body.token.trim().length === 0) {
    fail([{ field: 'token', message: 'token is required.' }]);
  }
  return { token: body.token.trim() };
}

export function parseSecureLinkIdParam(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) {
    fail([
      {
        field: 'secureLinkId',
        message: 'secureLinkId must be a valid UUID.',
      },
    ]);
  }
  return value;
}
