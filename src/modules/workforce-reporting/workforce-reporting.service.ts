import { AppError } from '../../shared/errors';
import { workforceProfileNotFoundError } from '../workforce';
import { workforceReportingRepository } from './workforce-reporting.repository';
import type {
  WorkforceReportingPage,
  WorkforceReportingRecord,
  WorkforceReportingScope,
} from './workforce-reporting.types';

/**
 * BE-03I1 — Workforce Reporting read service.
 *
 * This service is deliberately read-only. It assembles reporting projections
 * from existing BE-03 source tables/repositories via SQL joins, but never
 * creates or mutates workforce records. Every call must include an explicit
 * Client boundary or BE-02G accessible-building boundary; no global workforce
 * read is allowed.
 */
function assertScoped(scope: WorkforceReportingScope): void {
  const hasBuildingScope =
    scope.accessibleBuildingIds !== undefined &&
    scope.accessibleBuildingIds.length > 0;

  if (!scope.clientId && !hasBuildingScope) {
    throw AppError.badRequest(
      'Workforce reporting requires a client or accessible-building scope.',
    );
  }
}

export async function listWorkforceReporting(
  scope: WorkforceReportingScope = {},
): Promise<WorkforceReportingRecord[]> {
  assertScoped(scope);
  return workforceReportingRepository.listWorkforceReporting(scope);
}

/**
 * BE-03I2 — paginated reporting query.
 */
export async function listWorkforceReportingPage(
  scope: WorkforceReportingScope,
  page: number,
  limit: number,
): Promise<WorkforceReportingPage> {
  assertScoped(scope);
  return workforceReportingRepository.listWorkforceReportingPage(
    scope,
    page,
    limit,
  );
}

export async function getWorkforceReporting(
  workforceProfileId: string,
  scope: WorkforceReportingScope = {},
): Promise<WorkforceReportingRecord | null> {
  assertScoped(scope);
  return workforceReportingRepository.findWorkforceReportingById(
    workforceProfileId,
    scope,
  );
}

export async function getRequiredWorkforceReporting(
  workforceProfileId: string,
  scope: WorkforceReportingScope = {},
): Promise<WorkforceReportingRecord> {
  const record = await getWorkforceReporting(workforceProfileId, scope);
  if (!record) {
    throw workforceProfileNotFoundError();
  }
  return record;
}

export const workforceReportingService = {
  getRequiredWorkforceReporting,
  getWorkforceReporting,
  listWorkforceReporting,
  listWorkforceReportingPage,
};
