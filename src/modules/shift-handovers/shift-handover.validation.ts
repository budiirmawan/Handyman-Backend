import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import type {
  CreateShiftHandoverInput,
  UpdateShiftHandoverInput,
} from './shift-handover.types';

export type ValidationDetail = {
  field: string;
  message: string;
};

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseBuildingIdParam(raw: string): string {
  return parseUuidParam(raw, 'buildingId', 'Building id');
}

export function parseHandoverIdParam(raw: string): string {
  return parseUuidParam(raw, 'id', 'Shift handover id');
}

function parseUuidParam(raw: string, field: string, label: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${label} must be a valid UUID.` },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreateShiftHandoverBody(
  body: Record<string, unknown>,
): Pick<
  CreateShiftHandoverInput,
  'outgoingShiftId' | 'incomingShiftId' | 'handoverDate' | 'summary'
> {
  const details: ValidationDetail[] = [];

  const outgoingShiftId = readOptionalUuid(
    body.outgoingShiftId,
    'outgoingShiftId',
    'Outgoing shift id',
    details,
  );
  if (outgoingShiftId === undefined) {
    details.push({
      field: 'outgoingShiftId',
      message: 'outgoingShiftId is required and must be a valid UUID.',
    });
  }

  const incomingShiftId = readOptionalUuid(
    body.incomingShiftId,
    'incomingShiftId',
    'Incoming shift id',
    details,
  );
  if (incomingShiftId === undefined) {
    details.push({
      field: 'incomingShiftId',
      message: 'incomingShiftId is required and must be a valid UUID.',
    });
  }

  if (
    outgoingShiftId !== undefined &&
    incomingShiftId !== undefined &&
    outgoingShiftId === incomingShiftId
  ) {
    details.push({
      field: 'incomingShiftId',
      message: 'Outgoing and incoming shifts must be different.',
    });
  }

  let handoverDate: string | undefined;
  const rawDate = readSingleParam(body.handoverDate);
  if (rawDate === undefined || rawDate === '') {
    details.push({
      field: 'handoverDate',
      message: 'handoverDate is required and must be a valid YYYY-MM-DD date.',
    });
  } else if (!isValidCalendarDate(rawDate.trim())) {
    details.push({
      field: 'handoverDate',
      message: 'handoverDate must be a valid YYYY-MM-DD date.',
    });
  } else {
    handoverDate = rawDate.trim();
  }

  const summary = readOptionalText(body.summary, 'summary', 4096, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    outgoingShiftId: outgoingShiftId as string,
    incomingShiftId: incomingShiftId as string,
    handoverDate: handoverDate as string,
    ...(summary === undefined ? {} : { summary }),
  };
}

export function parseUpdateShiftHandoverBody(
  body: Record<string, unknown>,
): UpdateShiftHandoverInput {
  const details: ValidationDetail[] = [];
  const summary = readOptionalText(body.summary, 'summary', 4096, details);
  if (summary === undefined) {
    details.push({ field: 'summary', message: 'summary is required.' });
  }
  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }
  return { summary: summary as string };
}

/** Optional `?date=YYYY-MM-DD` list filter. */
export function parseHandoverListQuery(
  query: Record<string, unknown>,
): { date?: string } {
  const details: ValidationDetail[] = [];
  let date: string | undefined;
  const rawDate = readSingleParam(query.date);
  if (rawDate !== undefined && rawDate !== '') {
    if (!isValidCalendarDate(rawDate.trim())) {
      details.push({
        field: 'date',
        message: 'date must be a valid YYYY-MM-DD date.',
      });
    } else {
      date = rawDate.trim();
    }
  }
  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }
  return date === undefined ? {} : { date };
}

function isValidCalendarDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function readOptionalText(
  value: unknown,
  field: string,
  max: number,
  details: ValidationDetail[],
): string | undefined {
  const raw = readSingleParam(value);
  if (raw === undefined || raw === '') {
    return undefined;
  }
  const text = raw.trim();
  if (text.length > max) {
    details.push({ field, message: `${field} must be at most ${max} characters.` });
    return undefined;
  }
  return text;
}

function readOptionalUuid(
  value: unknown,
  field: string,
  label: string,
  details: ValidationDetail[],
): string | undefined {
  const raw = readSingleParam(value);
  if (raw === undefined || raw === '') {
    return undefined;
  }
  if (!isValidUuid(raw.trim())) {
    details.push({ field, message: `${label} must be a valid UUID.` });
    return undefined;
  }
  return raw.trim().toLowerCase();
}

function readSingleParam(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return undefined;
  }
  return String(value);
}
