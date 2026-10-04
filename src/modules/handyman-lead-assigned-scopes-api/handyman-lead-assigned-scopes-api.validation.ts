import type { Request } from 'express';
import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;

function invalid(field: string, message: string): never {
  throw AppError.validation('Request validation failed.', [
    { field, message },
  ]);
}

/** Challenge issuance derives its only target from the path. */
export function parseHandymanLeadArrivalChallengeBody(
  body: unknown,
): void {
  if (body === undefined) return;
  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).length > 0
  ) {
    invalid('body', 'Arrival challenge issuance does not accept a request body.');
  }
}

function positiveInteger(
  value: unknown,
  field: 'page' | 'pageSize',
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    return invalid(field, `${field} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return invalid(field, `${field} must be a safe positive integer.`);
  }
  if (field === 'pageSize' && parsed > MAX_PAGE_SIZE) {
    return invalid(field, `pageSize must not exceed ${MAX_PAGE_SIZE}.`);
  }
  return parsed;
}

/** The frozen list route accepts pagination only; no browse/search filters. */
export function parseHandymanLeadAssignedScopesPagination(
  query: Request['query'],
): { page: number; pageSize: number } {
  const source = query as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (key !== 'page' && key !== 'pageSize') {
      invalid(key, `${key} is not an accepted Lead assigned-scope filter.`);
    }
  }
  const page = positiveInteger(source.page, 'page', 1);
  const pageSize = positiveInteger(
    source.pageSize,
    'pageSize',
    DEFAULT_PAGE_SIZE,
  );
  if (!Number.isSafeInteger((page - 1) * pageSize)) {
    invalid('page', 'page and pageSize produce an unsafe pagination offset.');
  }
  return { page, pageSize };
}

export function parseHandymanLeadExecutionScopeId(
  value: string | string[] | undefined,
): string {
  const raw = (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
  if (!isValidUuid(raw)) {
    invalid('executionScopeId', 'executionScopeId must be a valid UUID.');
  }
  return raw.toLowerCase();
}
