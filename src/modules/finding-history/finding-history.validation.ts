import { AppError } from '../../shared/errors';
import type { FindingHistoryFilters } from './finding-history.types';

type Detail = { field: string; message: string };
export function parseFindingHistoryFilters(query: unknown): FindingHistoryFilters {
  if (typeof query !== 'object' || query === null) return {};
  const value = query as Record<string, unknown>;
  const details: Detail[] = [];
  const eventType = text(value.eventType, 'eventType', details);
  const from = date(value.from, 'from', details);
  const to = date(value.to, 'to', details);
  if (details.length) throw AppError.validation('Request validation failed.', details);
  return {
    ...(eventType ? { eventType } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  };
}
function text(value: unknown, field: string, details: Detail[]): string | undefined {
  if (value === undefined) return;
  if (Array.isArray(value) || typeof value !== 'string' || !value.trim()) {
    details.push({ field, message: `${field} must be a non-empty string.` });
    return;
  }
  const result = value.trim();
  if (result.length > 100) {
    details.push({ field, message: `${field} must be at most 100 characters.` });
    return;
  }
  return result;
}
function date(value: unknown, field: string, details: Detail[]): string | undefined {
  if (value === undefined) return;
  if (Array.isArray(value) || typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    details.push({ field, message: `${field} must be a valid date.` });
    return;
  }
  return new Date(value).toISOString();
}
