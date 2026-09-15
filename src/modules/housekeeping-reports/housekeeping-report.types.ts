/**
 * BE-11M — Housekeeping Report Dataset domain types.
 *
 * Provides reporting-ready dataset read models projected from authoritative
 * Housekeeping and shared operational records (BE-11A–BE-11L).
 */

export type HousekeepingReportFilters = {
  buildingId: string;
  cleaningAreaId?: string;
  dateFrom?: string;
  dateTo?: string;
  status?: string;
  workforceId?: string;
  teamId?: string;
};

export type PublicHousekeepingSummary = {
  buildingId: string;
  dateRange: {
    dateFrom: string | null;
    dateTo: string | null;
  };
  cleaningAreasCount: number;
  dailyCleaning: {
    total: number;
    open: number;
    assigned: number;
    inProgress: number;
    completed: number;
    cancelled: number;
  };
  toiletInspections: {
    bindingsCount: number;
    executionsCount: number;
    completedCount: number;
  };
  publicAreaInspections: {
    bindingsCount: number;
    executionsCount: number;
    completedCount: number;
  };
  supervisorInspections: {
    total: number;
    pending: number;
    approved: number;
    rejected: number;
    reworkRequired: number;
  };
  findings: {
    total: number;
    open: number;
    inProgress: number;
    reworkRequired: number;
    verified: number;
    closed: number;
  };
  consumables: {
    requirementsCount: number;
    readyCount: number;
    lowCount: number;
    notReadyCount: number;
  };
  qualityAudits: {
    total: number;
    completed: number;
    passed: number;
    failed: number;
    reworkRequired: number;
    averageScore: number | null;
  };
  complaints: {
    totalBindings: number;
    activeBindings: number;
  };
};

export type PublicCleaningReportRow = {
  taskId: string;
  operationalDate: string;
  occurrenceAt: string;
  status: string;
  cleaningAreaId: string;
  cleaningAreaCode: string;
  cleaningAreaName: string;
  cleaningAreaType: string;
  scheduleCode: string;
  scheduleName: string;
  assigneeType: string | null;
  workforceProfileId: string | null;
  teamId: string | null;
  completedByUserId: string | null;
  completedAt: string | null;
};

export type PublicInspectionReportRow = {
  inspectionType: 'TOILET' | 'PUBLIC_AREA';
  bindingId: string;
  executionId: string | null;
  executionStatus: string | null;
  cleaningAreaId: string;
  cleaningAreaCode: string;
  cleaningAreaName: string;
  templateCode: string;
  templateName: string;
  roomCode: string | null;
  functionalLocationCode: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

export type PublicSupervisorInspectionReportRow = {
  inspectionId: string;
  targetType: string;
  targetId: string;
  cleaningAreaId: string;
  cleaningAreaCode: string;
  supervisorUserId: string;
  decision: string | null;
  status: string;
  inspectedAt: string | null;
  notes: string | null;
};

export type PublicFindingReportRow = {
  findingId: string;
  findingNumber: string;
  title: string;
  status: string;
  sourceType: string;
  sourceId: string;
  cleaningAreaId: string;
  cleaningAreaCode: string;
  reportedByUserId: string;
  reportedAt: string;
};

export type PublicConsumableReportRow = {
  requirementId: string;
  requirementCode: string;
  requirementName: string;
  unit: string;
  requiredQuantity: number;
  cleaningAreaId: string | null;
  cleaningAreaCode: string | null;
  readinessStatus: string | null;
  availableQuantity: number | null;
  checkedAt: string | null;
};

export type PublicQualityAuditReportRow = {
  auditId: string;
  sourceType: string;
  sourceId: string;
  cleaningAreaId: string | null;
  cleaningAreaCode: string | null;
  auditorUserId: string;
  score: number | null;
  result: string | null;
  status: string;
  auditedAt: string | null;
};

export type PublicComplaintReportRow = {
  bindingId: string;
  complaintReference: string;
  workRequestId: string | null;
  cleaningAreaId: string | null;
  cleaningAreaCode: string | null;
  housekeepingSourceType: string | null;
  housekeepingSourceId: string | null;
  findingId: string | null;
  status: string;
  createdAt: string;
};
