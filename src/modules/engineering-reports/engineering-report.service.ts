import { buildingService } from '../buildings';
import { contextAccessService } from '../context-access';
import { engineeringReportRepository } from './engineering-report.repository';
import type {
  PublicBreakdownDatasetRow,
  PublicChecklistDatasetRow,
  PublicEquipmentLogDatasetRow,
  PublicFindingDatasetRow,
  PublicInspectionDatasetRow,
  PublicMaintenanceDatasetRow,
  PublicMeterReadingDatasetRow,
  PublicTechnicalSummary,
  ReportFilters,
} from './engineering-report.types';
import { reportRange } from './engineering-report.validation';

/**
 * BE-10I — Technical Report Dataset service.
 *
 * A read-only reporting query layer over the authoritative BE-10 and shared
 * operational records. Building access is asserted per request; every
 * dataset query is scoped to that single Building, so cross-Building and
 * cross-Client leakage is impossible. No ETL / BI / warehouse logic exists
 * here.
 */
async function resolveBuildingScope(
  filters: ReportFilters,
  userId: string,
): Promise<{ start: Date | null; end: Date | null }> {
  const building = await buildingService.getBuildingById(filters.buildingId);
  await contextAccessService.assertBuildingAccess(userId, building.id);
  return reportRange(filters);
}

export async function getTechnicalSummary(
  filters: ReportFilters,
  userId: string,
): Promise<PublicTechnicalSummary> {
  const { start, end } = await resolveBuildingScope(filters, userId);
  const row = await engineeringReportRepository.getTechnicalSummary(
    filters,
    start,
    end,
  );
  return engineeringReportRepository.toPublicTechnicalSummary(filters, row);
}

export async function getInspectionDataset(
  filters: ReportFilters,
  userId: string,
): Promise<PublicInspectionDatasetRow[]> {
  await resolveBuildingScope(filters, userId);
  return engineeringReportRepository.getInspectionDataset(filters);
}

export async function getMeterReadingDataset(
  filters: ReportFilters,
  userId: string,
): Promise<PublicMeterReadingDatasetRow[]> {
  const { start, end } = await resolveBuildingScope(filters, userId);
  return engineeringReportRepository.getMeterReadingDataset(filters, start, end);
}

export async function getEquipmentLogDataset(
  filters: ReportFilters,
  userId: string,
): Promise<PublicEquipmentLogDatasetRow[]> {
  const { start, end } = await resolveBuildingScope(filters, userId);
  return engineeringReportRepository.getEquipmentLogDataset(filters, start, end);
}

export async function getChecklistDataset(
  filters: ReportFilters,
  userId: string,
): Promise<PublicChecklistDatasetRow[]> {
  const { start, end } = await resolveBuildingScope(filters, userId);
  return engineeringReportRepository.getChecklistDataset(filters, start, end);
}

export async function getBreakdownDataset(
  filters: ReportFilters,
  userId: string,
): Promise<PublicBreakdownDatasetRow[]> {
  const { start, end } = await resolveBuildingScope(filters, userId);
  return engineeringReportRepository.getBreakdownDataset(filters, start, end);
}

export async function getMaintenanceDataset(
  filters: ReportFilters,
  userId: string,
): Promise<PublicMaintenanceDatasetRow[]> {
  const { start, end } = await resolveBuildingScope(filters, userId);
  return engineeringReportRepository.getMaintenanceDataset(filters, start, end);
}

export async function getFindingDataset(
  filters: ReportFilters,
  userId: string,
): Promise<PublicFindingDatasetRow[]> {
  const { start, end } = await resolveBuildingScope(filters, userId);
  return engineeringReportRepository.getFindingDataset(filters, start, end);
}

export const engineeringReportService = {
  getBreakdownDataset,
  getChecklistDataset,
  getEquipmentLogDataset,
  getFindingDataset,
  getInspectionDataset,
  getMaintenanceDataset,
  getMeterReadingDataset,
  getTechnicalSummary,
};
