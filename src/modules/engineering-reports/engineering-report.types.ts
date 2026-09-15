/**
 * BE-10I — Technical Report Dataset domain types.
 *
 * Read-only reporting projections over the authoritative BE-10 and shared
 * operational records. No ETL, no warehouse, no duplicated operational
 * tables — every dataset is a direct query over the source records.
 */

export type ReportFilters = {
  buildingId: string;
  assetId?: string;
  /** ISO date/datetime; day windows are UTC, matching BE-07 conventions. */
  dateFrom?: string;
  dateTo?: string;
  status?: string;
  sourceType?: string;
  uomId?: string;
  workforceId?: string;
  vendorId?: string;
};

export type PublicTechnicalSummary = {
  buildingId: string;
  dateFrom: string | null;
  dateTo: string | null;
  operations: {
    scheduled: number;
    inProgress: number;
    completed: number;
    openWorkOrders: number;
    openFindings: number;
  };
  inspections: {
    bindingCount: number;
    executionCount: number;
  };
  meterReadings: {
    bindingCount: number;
    readingCount: number;
  };
  equipmentLogs: {
    bindingCount: number;
    executionCount: number;
  };
  checklists: {
    bindingCount: number;
    executionCount: number;
  };
  breakdowns: {
    open: number;
    closed: number;
  };
  maintenance: {
    activeBindings: number;
    linkedWorkOrders: number;
  };
  findings: {
    open: number;
    verified: number;
    closed: number;
  };
};

export type PublicInspectionDatasetRow = {
  bindingId: string;
  assetId: string;
  assetCode: string;
  assetName: string;
  templateId: string;
  templateCode: string;
  functionalLocationCode: string | null;
  status: string;
  executionCount: number;
  lastExecutionAt: string | null;
};

export type PublicMeterReadingDatasetRow = {
  bindingId: string;
  assetId: string;
  assetCode: string;
  assetName: string;
  fieldCode: string | null;
  uomId: string;
  uomCode: string;
  uomSymbol: string;
  minimumValue: number | null;
  maximumValue: number | null;
  status: string;
  readingCount: number;
  lastReadAt: string | null;
};

export type PublicEquipmentLogDatasetRow = {
  bindingId: string;
  assetId: string;
  assetCode: string;
  assetName: string;
  templateId: string;
  templateCode: string;
  status: string;
  executionCount: number;
  lastExecutionAt: string | null;
};

export type PublicChecklistDatasetRow = {
  bindingId: string;
  templateId: string;
  templateCode: string;
  assetId: string | null;
  assetCode: string | null;
  functionalLocationCode: string | null;
  bindingStatus: string;
  executionCount: number;
  lastExecutionAt: string | null;
};

export type PublicBreakdownDatasetRow = {
  breakdownId: string;
  assetId: string;
  assetCode: string;
  assetName: string;
  category: string;
  description: string;
  reportedByUserId: string;
  reportedAt: string;
  status: string;
  workOrderId: string | null;
  workOrderNumber: string | null;
  workOrderStatus: string | null;
};

export type PublicMaintenanceDatasetRow = {
  bindingId: string;
  assetId: string;
  assetCode: string;
  assetName: string;
  name: string;
  maintenanceType: string;
  status: string;
  scheduleCode: string | null;
  scheduleStatus: string | null;
  workOrderNumber: string | null;
  workOrderStatus: string | null;
  taskCount: number;
};

export type PublicFindingDatasetRow = {
  linkId: string;
  findingId: string;
  findingNumber: string;
  title: string;
  status: string;
  operationType: string;
  sourceType: string | null;
  sourceId: string | null;
  assetId: string | null;
  assetCode: string | null;
  classificationName: string | null;
  severityName: string | null;
  reportedAt: string;
};
