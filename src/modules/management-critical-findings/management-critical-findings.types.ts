import type { FindingAssigneeType } from '../finding-assignments';
import type { FindingStatus } from '../findings';
import type {
  ManagementReadModelContract,
  ManagementReadScopeFilters,
} from '../management-read-scope';

/**
 * No global critical threshold exists in BE-09. PART 03B therefore uses the
 * highest ACTIVE configured severity rank independently for each Client.
 */
export const MANAGEMENT_CRITICAL_SEVERITY_RULE =
  'HIGHEST_ACTIVE_RANK_PER_CLIENT' as const;

export type ManagementCriticalFindingsQuery = {
  scope: ManagementReadScopeFilters;
  overdueAfterDays: number;
};

export type ManagementCriticalFindingsFilters = {
  overdueAfterDays: number;
  criticalSeverityRule: typeof MANAGEMENT_CRITICAL_SEVERITY_RULE;
};

export type ManagementCriticalFindingResponsibleParty = {
  type: FindingAssigneeType;
  workforceProfileId: string | null;
  teamId: string | null;
  vendorId: string | null;
};

export type ManagementCriticalFindingItem = {
  findingId: string;
  clientId: string;
  buildingId: string;
  findingReference: string;
  title: string;
  severity: {
    id: string;
    code: string;
    name: string;
    rank: number;
  };
  source: {
    type: string | null;
    id: string | null;
  };
  context: {
    type: 'ENGINEERING' | 'HOUSEKEEPING' | 'SECURITY' | 'GENERAL';
    id: string | null;
  };
  /** Exact BE-09 Finding status. */
  status: FindingStatus;
  responsibleParty: ManagementCriticalFindingResponsibleParty | null;
  reportedAt: string;
  /** Reporting age state; BE-09 has no due-date/SLA field. */
  overdue: boolean;
};

export type ManagementCriticalFindingsData = {
  criticalFindingCount: number;
  items: ManagementCriticalFindingItem[];
};

export type PublicManagementCriticalFindings = ManagementReadModelContract<
  ManagementCriticalFindingsData,
  ManagementCriticalFindingsFilters
>;
