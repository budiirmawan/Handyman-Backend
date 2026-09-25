import type {
  IncidentLocationType,
  IncidentPriority,
  IncidentSeverity,
  IncidentStatus,
} from '../incidents';
import type { OperationalIncidentStatus } from '../operational-incidents';

export const SAFETY_REPORT_TYPES = ['HAZARD', 'NEAR_MISS'] as const;
export type SafetyReportType = (typeof SAFETY_REPORT_TYPES)[number];

export function isSafetyReportType(value: unknown): value is SafetyReportType {
  return (
    typeof value === 'string' &&
    (SAFETY_REPORT_TYPES as readonly string[]).includes(value)
  );
}

export type CreateSafetyFieldReportInput = {
  reportType: SafetyReportType;
  buildingId: string;
  incidentNumber: string;
  title: string;
  description?: string | null;
  occurredAt: Date;
  severity?: IncidentSeverity;
  priority?: IncidentPriority;
  notes?: string | null;
  locationType?: IncidentLocationType | null;
  locationId?: string | null;
};

export type PublicSafetyFieldReport = {
  id: string;
  operationalIncidentId: string;
  clientId: string;
  buildingId: string;
  incidentNumber: string;
  reportType: SafetyReportType;
  title: string;
  description: string | null;
  severity: IncidentSeverity;
  priority: IncidentPriority;
  incidentStatus: IncidentStatus;
  operationalStatus: OperationalIncidentStatus;
  occurredAt: string;
  reportedAt: string;
  locationType: string | null;
  locationId: string | null;
  notes: string | null;
  reportedByUserId: string;
  reportedShiftAssignmentId: string;
  createdAt: string;
  updatedAt: string;
};
