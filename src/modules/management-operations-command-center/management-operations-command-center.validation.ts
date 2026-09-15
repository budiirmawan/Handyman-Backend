import { parseManagementBuildingPerformanceQuery } from '../management-building-performance';
import { parseManagementDailyOperationsQuery } from '../management-daily-operations';
import type { ManagementOperationsCommandCenterQuery } from './management-operations-command-center.types';

/** Delegates every filter to the completed BE-24 component that owns it. */
export function parseManagementOperationsCommandCenterQuery(
  query: Record<string, unknown>,
  now = new Date(),
): ManagementOperationsCommandCenterQuery {
  const summary = parseManagementBuildingPerformanceQuery(query);
  const daily = parseManagementDailyOperationsQuery(query, now);

  return {
    ...summary,
    operationalDate: daily.operationalDate,
  };
}
