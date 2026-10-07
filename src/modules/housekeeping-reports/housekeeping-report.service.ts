import { buildingService } from '../buildings';
import { contextAccessService } from '../context-access';
import { housekeepingReportRepository } from './housekeeping-report.repository';
import type {
  HousekeepingReportFilters,
  PublicCleaningReportRow,
  PublicComplaintReportRow,
  PublicConsumableReportRow,
  PublicFindingReportRow,
  PublicHousekeepingSummary,
  PublicInspectionReportRow,
  PublicQualityAuditReportRow,
  PublicSupervisorInspectionReportRow,
} from './housekeeping-report.types';
import { reportRange } from './housekeeping-report.validation';

async function resolveBuildingScope(
  filters: HousekeepingReportFilters,
  userId: string,
): Promise<{ start: Date | null; end: Date | null }> {
  const building = await buildingService.getBuildingById(filters.buildingId);
  await contextAccessService.assertBuildingAccess(userId, building.id);
  return reportRange(filters);
}

export async function getHousekeepingSummary(
  filters: HousekeepingReportFilters,
  userId: string,
): Promise<PublicHousekeepingSummary> {
  const { start, end } = await resolveBuildingScope(filters, userId);
  return housekeepingReportRepository.getHousekeepingSummary(
    filters,
    start,
    end,
  );
}

export async function getCleaningDataset(
  filters: HousekeepingReportFilters,
  userId: string,
): Promise<PublicCleaningReportRow[]> {
  const { start, end } = await resolveBuildingScope(filters, userId);
  return housekeepingReportRepository.getCleaningDataset(filters, start, end);
}

export async function getInspectionDataset(
  filters: HousekeepingReportFilters,
  userId: string,
): Promise<PublicInspectionReportRow[]> {
  const { start, end } = await resolveBuildingScope(filters, userId);
  return housekeepingReportRepository.getInspectionDataset(
    filters,
    start,
    end,
  );
}

export async function getSupervisorInspectionDataset(
  filters: HousekeepingReportFilters,
  userId: string,
): Promise<PublicSupervisorInspectionReportRow[]> {
  const { start, end } = await resolveBuildingScope(filters, userId);
  return housekeepingReportRepository.getSupervisorInspectionDataset(
    filters,
    start,
    end,
  );
}

export async function getFindingDataset(
  filters: HousekeepingReportFilters,
  userId: string,
): Promise<PublicFindingReportRow[]> {
  const { start, end } = await resolveBuildingScope(filters, userId);
  return housekeepingReportRepository.getFindingDataset(filters, start, end);
}

export async function getConsumableDataset(
  filters: HousekeepingReportFilters,
  userId: string,
): Promise<PublicConsumableReportRow[]> {
  await resolveBuildingScope(filters, userId);
  return housekeepingReportRepository.getConsumableDataset(filters);
}

export async function getQualityAuditDataset(
  filters: HousekeepingReportFilters,
  userId: string,
): Promise<PublicQualityAuditReportRow[]> {
  const { start, end } = await resolveBuildingScope(filters, userId);
  return housekeepingReportRepository.getQualityAuditDataset(
    filters,
    start,
    end,
  );
}

export async function getComplaintDataset(
  filters: HousekeepingReportFilters,
  userId: string,
): Promise<PublicComplaintReportRow[]> {
  await resolveBuildingScope(filters, userId);
  return housekeepingReportRepository.getComplaintDataset(filters);
}

export const housekeepingReportService = {
  getCleaningDataset,
  getComplaintDataset,
  getConsumableDataset,
  getFindingDataset,
  getHousekeepingSummary,
  getInspectionDataset,
  getQualityAuditDataset,
  getSupervisorInspectionDataset,
};
