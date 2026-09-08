import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  BREAKDOWN_BINDING_STATUSES,
  isBreakdownBindingStatus,
  type CreateBreakdownInput,
  type LinkCorrectiveWorkOrderInput,
} from './breakdown-binding.types';

export type ValidationDetail = {
  field: string;
  message: string;
};

export function parseAssetIdParam(raw: string): string {
  return parseUuidParam(raw, 'assetId', 'Asset id');
}

export function parseBuildingIdParam(raw: string): string {
  return parseUuidParam(raw, 'buildingId', 'Building id');
}

export function parseBreakdownIdParam(raw: string): string {
  return parseUuidParam(raw, 'id', 'Breakdown id');
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

export function parseCreateBreakdownBody(
  body: Record<string, unknown>,
): Pick<
  CreateBreakdownInput,
  'category' | 'description' | 'functionalLocationId' | 'reportedAt'
> {
  const details: ValidationDetail[] = [];

  const category = readRequiredText(body.category, 'category', 64, details);
  const description = readRequiredText(body.description, 'description', 2048, details);

  const functionalLocationId = readOptionalNullableUuid(
    body.functionalLocationId,
    'functionalLocationId',
    'Functional location id',
    details,
  );

  let reportedAt: string | undefined;
  const rawReportedAt = readSingleParam(body.reportedAt);
  if (rawReportedAt !== undefined && rawReportedAt !== '') {
    const parsed = new Date(rawReportedAt);
    if (Number.isNaN(parsed.getTime())) {
      details.push({
        field: 'reportedAt',
        message: 'reportedAt must be a valid ISO-8601 datetime.',
      });
    } else {
      reportedAt = parsed.toISOString();
    }
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    category: (category as string).toUpperCase(),
    description: description as string,
    ...(functionalLocationId === undefined ? {} : { functionalLocationId }),
    ...(reportedAt === undefined ? {} : { reportedAt }),
  };
}

export function parseLinkWorkOrderBody(
  body: Record<string, unknown>,
): LinkCorrectiveWorkOrderInput {
  const details: ValidationDetail[] = [];

  const workOrderId = readOptionalUuid(body.workOrderId, 'workOrderId', 'Work order id', details);
  let title: string | undefined;
  const rawTitle = readSingleParam(body.title);
  if (rawTitle !== undefined && rawTitle !== '') {
    if (rawTitle.length > 160) {
      details.push({ field: 'title', message: 'title must be at most 160 characters.' });
    } else {
      title = rawTitle;
    }
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(workOrderId === undefined ? {} : { workOrderId }),
    ...(title === undefined ? {} : { title }),
  };
}

export function parseCloseBreakdownBody(
  body: Record<string, unknown>,
): { status: 'CLOSED' } {
  const raw = readSingleParam(body.status);
  if (raw === undefined || raw === '') {
    throw AppError.validation('Request validation failed.', [
      { field: 'status', message: 'status is required.' },
    ]);
  }
  const normalized = raw.trim().toUpperCase();
  if (!isBreakdownBindingStatus(normalized) || normalized !== 'CLOSED') {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'status',
        message: `status must be one of: ${BREAKDOWN_BINDING_STATUSES.join(', ')}.`,
      },
    ]);
  }
  return { status: normalized };
}

function readRequiredText(
  value: unknown,
  field: string,
  max: number,
  details: ValidationDetail[],
): string | undefined {
  const raw = readSingleParam(value);
  if (raw === undefined || raw.trim() === '') {
    details.push({ field, message: `${field} is required.` });
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

function readOptionalNullableUuid(
  value: unknown,
  field: string,
  label: string,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === null) {
    return null;
  }
  return readOptionalUuid(value, field, label, details);
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
