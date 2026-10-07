import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { isUtilityType } from '../utility-meters';
import {
  UTILITY_EXCEPTION_SEVERITIES,
  UTILITY_EXCEPTION_STATUSES,
  UTILITY_EXCEPTION_TYPES,
  type CreateUtilityOperationalExceptionInput,
  type UtilityExceptionFilters,
} from './utility-operational-exception.types';
type Detail = { field: string; message: string };
const fail = (details: Detail[]): never => { throw AppError.validation('Request validation failed.', details); };
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
export function parseUtilityExceptionId(raw: string, field = 'id') {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) fail([{ field, message: `${field} must be a valid UUID.` }]);
  return value;
}
export function parseCreateUtilityException(body: unknown): CreateUtilityOperationalExceptionInput {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const source = body as Record<string, unknown>;
  const details: Detail[] = [];
  const ids = ['meterId', 'meterReadingId', 'readingDueId', 'consumptionId',
    'abnormalConsumptionId', 'ocrCandidateId', 'reconciliationId'] as const;
  const references: Record<string, string> = {};
  for (const field of ids) {
    if (source[field] !== undefined) {
      if (typeof source[field] !== 'string' || !isValidUuid(source[field])) {
        details.push({ field, message: `${field} must be a valid UUID.` });
      } else references[field] = source[field].toLowerCase() as string;
    }
  }
  if (!Object.keys(references).length) details.push({ field: 'references', message: 'At least one authoritative Utility reference is required.' });
  const exceptionType = typeof source.exceptionType === 'string' &&
    (UTILITY_EXCEPTION_TYPES as readonly string[]).includes(source.exceptionType)
    ? source.exceptionType as CreateUtilityOperationalExceptionInput['exceptionType'] : undefined;
  if (!exceptionType) details.push({ field: 'exceptionType', message: `exceptionType must be one of: ${UTILITY_EXCEPTION_TYPES.join(', ')}.` });
  const severity = typeof source.severity === 'string' &&
    (UTILITY_EXCEPTION_SEVERITIES as readonly string[]).includes(source.severity)
    ? source.severity as CreateUtilityOperationalExceptionInput['severity'] : undefined;
  if (!severity) details.push({ field: 'severity', message: `severity must be one of: ${UTILITY_EXCEPTION_SEVERITIES.join(', ')}.` });
  const summary = text(source.summary, 'summary', 300, true, details);
  const detailText = text(source.details, 'details', 2000, false, details);
  if (!exceptionType || !severity || !summary || details.length) fail(details);
  return { ...references, exceptionType, severity, summary, ...(detailText === undefined ? {} : { details: detailText }) } as CreateUtilityOperationalExceptionInput;
}
export function parseUtilityExceptionFilters(query: unknown): UtilityExceptionFilters {
  if (!isRecord(query)) return {};
  const details: Detail[] = [];
  const result: UtilityExceptionFilters = {};
  for (const field of ['clientId', 'buildingId', 'reconciliationId'] as const) {
    if (query[field] !== undefined) {
      if (typeof query[field] !== 'string' || !isValidUuid(query[field])) details.push({ field, message: `${field} must be a valid UUID.` });
      else result[field] = query[field].toLowerCase();
    }
  }
  if (query.utilityType !== undefined) {
    if (!isUtilityType(query.utilityType)) details.push({ field: 'utilityType', message: 'utilityType is invalid.' });
    else result.utilityType = query.utilityType;
  }
  for (const [field, values] of [
    ['exceptionType', UTILITY_EXCEPTION_TYPES], ['severity', UTILITY_EXCEPTION_SEVERITIES],
    ['status', UTILITY_EXCEPTION_STATUSES],
  ] as const) {
    const value = query[field];
    if (value !== undefined) {
      if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) details.push({ field, message: `${field} is invalid.` });
      else (result as Record<string, unknown>)[field] = value;
    }
  }
  if (details.length) fail(details);
  return result;
}
export function parseReviewNotes(body: unknown) {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const source = body as Record<string, unknown>;
  const details: Detail[] = [];
  const reviewNotes = text(source.reviewNotes, 'reviewNotes', 2000, false, details);
  if (details.length) fail(details);
  return { reviewNotes: reviewNotes ?? null };
}
export function parseRequiredLifecycleNotes(body: unknown, field: 'resolutionNotes' | 'reason') {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const source = body as Record<string, unknown>;
  const details: Detail[] = [];
  const value = text(source[field], field, 2000, true, details);
  if (!value || details.length) fail(details);
  return value!;
}
function text(value: unknown, field: string, max: number, required: boolean, details: Detail[]) {
  if ((value === undefined || value === null || value === '') && !required) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    details.push({ field, message: `${field} is required.` }); return undefined;
  }
  const result = value.trim();
  if (result.length > max) { details.push({ field, message: `${field} must be at most ${max} characters.` }); return undefined; }
  return result;
}
