import { AppError } from '../../shared/errors';
import {
  ASSIGNMENT_RESPONSE_CLIENT_KEY_MAX_LENGTH,
  ASSIGNMENT_RESPONSE_CLIENT_KEY_MIN_LENGTH,
} from './assignment-response.guards';

/**
 * CR-HM-FIELD-OPS-ACK-01 PART 01 — bounded transport parser for the optional
 * concurrent-device key. The `Idempotency-Key` header is the preferred mobile
 * wire form; the existing `idempotencyKey` JSON body member remains supported
 * for backwards compatibility with the PART 02A/B/C clients.
 *
 * The key is NEVER an authority field: the actor, tenant, building, assignment
 * and decision continue to be derived exclusively server-side.
 */
export function parseAssignmentResponseIdempotencyKey(
  headerValue: unknown,
  body: unknown,
): string | undefined {
  const record =
    typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const candidate =
    typeof headerValue === 'string' && headerValue.trim().length > 0
      ? headerValue
      : record.idempotencyKey;

  if (candidate === undefined || candidate === null || candidate === '') {
    return undefined;
  }
  if (typeof candidate !== 'string') {
    throw AppError.validation('Request validation failed.', [
      { field: 'idempotencyKey', message: 'idempotencyKey must be a string.' },
    ]);
  }
  const key = candidate.trim();
  if (
    key.length < ASSIGNMENT_RESPONSE_CLIENT_KEY_MIN_LENGTH ||
    key.length > ASSIGNMENT_RESPONSE_CLIENT_KEY_MAX_LENGTH
  ) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'idempotencyKey',
        message: `idempotencyKey must be ${ASSIGNMENT_RESPONSE_CLIENT_KEY_MIN_LENGTH}-${ASSIGNMENT_RESPONSE_CLIENT_KEY_MAX_LENGTH} characters when supplied.`,
      },
    ]);
  }
  return key;
}
