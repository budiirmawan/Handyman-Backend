import { AppError } from '../../shared/errors';
import {
  AUDIT_EVENT_TYPES,
  AUDIT_OUTCOMES,
  isAuditEventType,
  isAuditOutcome,
} from './audit.types';
import type { AuditListFilters } from './audit.repository';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

type Detail = { field: string; message: string };

function readSingleParam(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return typeof value[0] === 'string' ? value[0] : undefined;
  }

  return typeof value === 'string' ? value : undefined;
}

export function parseAuditQuery(query: Record<string, unknown>): AuditListFilters {
  const details: Detail[] = [];

  const eventTypeRaw = readSingleParam(query.eventType);
  let eventType: AuditListFilters['eventType'];
  if (eventTypeRaw !== undefined && eventTypeRaw !== '') {
    if (!isAuditEventType(eventTypeRaw)) {
      details.push({
        field: 'eventType',
        message: `eventType must be one of: ${AUDIT_EVENT_TYPES.join(', ')}.`,
      });
    } else {
      eventType = eventTypeRaw;
    }
  }

  const outcomeRaw = readSingleParam(query.outcome);
  let outcome: AuditListFilters['outcome'];
  if (outcomeRaw !== undefined && outcomeRaw !== '') {
    if (!isAuditOutcome(outcomeRaw)) {
      details.push({
        field: 'outcome',
        message: `outcome must be one of: ${AUDIT_OUTCOMES.join(', ')}.`,
      });
    } else {
      outcome = outcomeRaw;
    }
  }

  const userIdRaw = readSingleParam(query.userId);
  let userId: string | undefined;
  if (userIdRaw !== undefined && userIdRaw !== '') {
    if (!UUID_PATTERN.test(userIdRaw)) {
      details.push({ field: 'userId', message: 'userId must be a valid UUID.' });
    } else {
      userId = userIdRaw;
    }
  }

  const from = readDate(query.from, 'from', details);
  const to = readDate(query.to, 'to', details);

  const limit = readInt(query.limit, 'limit', DEFAULT_LIMIT, 1, MAX_LIMIT, details);
  const offset = readInt(query.offset, 'offset', 0, 0, Number.MAX_SAFE_INTEGER, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(eventType === undefined ? {} : { eventType }),
    ...(userId === undefined ? {} : { userId }),
    ...(outcome === undefined ? {} : { outcome }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    limit,
    offset,
  };
}

function readDate(
  value: unknown,
  field: string,
  details: Detail[],
): Date | undefined {
  const raw = readSingleParam(value);
  if (raw === undefined || raw === '') {
    return undefined;
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    details.push({ field, message: `${field} must be a valid ISO date.` });
    return undefined;
  }

  return parsed;
}

function readInt(
  value: unknown,
  field: string,
  fallback: number,
  min: number,
  max: number,
  details: Detail[],
): number {
  const raw = readSingleParam(value);
  if (raw === undefined || raw === '') {
    return fallback;
  }

  if (!/^\d+$/.test(raw)) {
    details.push({ field, message: `${field} must be an integer.` });
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (parsed < min || parsed > max) {
    details.push({
      field,
      message: `${field} must be between ${min} and ${max}.`,
    });
    return fallback;
  }

  return parsed;
}
