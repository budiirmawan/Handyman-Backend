import { AppError } from '../../shared/errors';

/**
 * CR-BE-SAAS-01 PART 11B — Support session HTTP request validation
 * (frozen §22 / §19.1 / §19.2).
 *
 * Frozen body shape for `POST /platform/support-sessions`:
 *   {
 *     customerId: string (UUID, required),
 *     buildingId?: string (UUID, optional narrowing),
 *     reason: string (required, non-empty),
 *     durationMinutes: integer (required, positive, ≤ max)
 *   }
 *
 * Non-frozen fields MUST be rejected at the door:
 *   - actorUserId, supportActorUserId, expiresAt, startedAt,
 *     endedAt, status — all server-derived.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export interface OpenSupportSessionBody {
  customerId: string;
  buildingId?: string;
  reason: string;
  durationMinutes: number;
}

function fieldErrors(body: unknown): { field: string; message: string }[] {
  const errors: { field: string; message: string }[] = [];
  if (body === null || typeof body !== 'object') {
    errors.push({ field: 'body', message: 'body must be a JSON object.' });
    return errors;
  }
  const b = body as Record<string, unknown>;

  // customerId
  if (!isUuid(b['customerId'])) {
    errors.push({ field: 'customerId', message: 'customerId must be a UUID.' });
  }

  // buildingId (optional, but if present must be a UUID)
  const buildingId = b['buildingId'];
  if (buildingId !== undefined && buildingId !== null && !isUuid(buildingId)) {
    errors.push({ field: 'buildingId', message: 'buildingId must be a UUID.' });
  }

  // reason
  if (typeof b['reason'] !== 'string' || b['reason'].trim().length === 0) {
    errors.push({ field: 'reason', message: 'reason is mandatory.' });
  } else if (b['reason'].length > 500) {
    errors.push({
      field: 'reason',
      message: 'reason must be at most 500 characters.',
    });
  }

  // durationMinutes
  const dur = b['durationMinutes'];
  if (
    typeof dur !== 'number' ||
    !Number.isInteger(dur) ||
    !Number.isFinite(dur) ||
    dur <= 0
  ) {
    errors.push({
      field: 'durationMinutes',
      message: 'durationMinutes must be a positive integer.',
    });
  }

  // Non-frozen fields — silently ignored at the door if sent. The
  // part 11A service will treat only the schema-allowed fields as
  // authoritative. This list mirrors §19.2 — nothing else is permitted
  // by the contract.
  const forbidden = [
    'actorUserId',
    'supportActorUserId',
    'expiresAt',
    'startedAt',
    'endedAt',
    'endedByUserId',
    'status',
    'idempotencyKey',
  ];
  for (const f of forbidden) {
    if (f in b) {
      errors.push({
        field: f,
        message: `${f} is server-derived; client-supplied values are not accepted.`,
      });
    }
  }

  return errors;
}

export function parseOpenSupportSessionBody(body: unknown): OpenSupportSessionBody {
  const errors = fieldErrors(body);
  if (errors.length > 0) {
    throw AppError.validation('Request validation failed.', errors);
  }
  const b = body as Record<string, unknown>;
  return {
    customerId: (b['customerId'] as string).toLowerCase(),
    buildingId:
      b['buildingId'] === undefined || b['buildingId'] === null
        ? undefined
        : (b['buildingId'] as string).toLowerCase(),
    reason: (b['reason'] as string).trim(),
    durationMinutes: b['durationMinutes'] as number,
  };
}
