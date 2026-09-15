import { AppError } from './errors';

/**
 * BE-25A — Mobile API contract stabilization: shared pagination contract.
 *
 * Convention (opt-in, Web compatible):
 *
 *   - List endpoints keep their existing unbounded behavior when NO
 *     pagination parameters are supplied (asentra-web compatibility).
 *   - Mobile consumers opt in with `page` (1-based) and `pageSize`
 *     (1..200, default 50). The response envelope `meta` then carries
 *
 *       meta: { page, pageSize, total, totalPages }
 *
 * Invalid values are rejected with 400 VALIDATION_ERROR and field details,
 * matching the shared error contract (never a silent clamp).
 */

export type PaginationParams = {
  page: number;
  pageSize: number;
  limit: number;
  offset: number;
};

export type PaginationMeta = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/** True when the client opted into pagination for this request. */
export function hasPaginationParams(query: Record<string, unknown>): boolean {
  return query.page !== undefined || query.pageSize !== undefined;
}

function parsePositiveInt(
  value: unknown,
): { value: number } | { value: null } {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    return { value: null };
  }
  return { value: Number(value) };
}

export function parsePagination(
  query: Record<string, unknown>,
): PaginationParams {
  const pageRaw = parsePositiveInt(query.page ?? '1');
  const pageSizeRaw = parsePositiveInt(query.pageSize ?? String(DEFAULT_PAGE_SIZE));

  const details: { field: string; message: string }[] = [];
  if (pageRaw.value === null || pageRaw.value < 1) {
    details.push({ field: 'page', message: 'page must be an integer >= 1.' });
  }
  if (
    pageSizeRaw.value === null ||
    pageSizeRaw.value < 1 ||
    pageSizeRaw.value > MAX_PAGE_SIZE
  ) {
    details.push({
      field: 'pageSize',
      message: `pageSize must be an integer between 1 and ${MAX_PAGE_SIZE}.`,
    });
  }
  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  const page = pageRaw.value as number;
  const pageSize = pageSizeRaw.value as number;
  return {
    page,
    pageSize,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  };
}

export function buildPaginationMeta(
  page: number,
  pageSize: number,
  total: number,
): PaginationMeta {
  return {
    page,
    pageSize,
    total,
    totalPages: pageSize > 0 ? Math.ceil(total / pageSize) : 0,
  };
}
