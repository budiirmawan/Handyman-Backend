import { parseManagementReadScopeQuery } from '../management-read-scope';
import type { ManagementFinancialSummaryQuery } from './management-financial-summary.types';

/** PART 01 owns Client/Building and BE-23-compatible period validation. */
export function parseManagementFinancialSummaryQuery(
  query: Record<string, unknown>,
): ManagementFinancialSummaryQuery {
  return { scope: parseManagementReadScopeQuery(query) };
}
