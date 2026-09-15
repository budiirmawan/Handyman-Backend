import { parseManagementBuildingPerformanceQuery } from '../management-building-performance';
import type { ManagementPortfolioOverviewQuery } from './management-portfolio-overview.types';

/** Portfolio uses exactly the same scope/component filters as PART 08A. */
export function parseManagementPortfolioOverviewQuery(
  query: Record<string, unknown>,
): ManagementPortfolioOverviewQuery {
  return parseManagementBuildingPerformanceQuery(query);
}
