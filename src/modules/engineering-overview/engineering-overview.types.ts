import type {
  DailyOperationsSummary,
  PublicShiftContext,
} from '../engineering-daily-operations/engineering-daily-operations.types';
import type { HandoverItem } from '../shift-handovers/shift-handover.types';

/**
 * BE-10K — Engineering Aggregation API domain types.
 *
 * A concise read model composed from the authoritative BE-10A daily
 * operations, BE-10I-style aggregates, and BE-10J handover dataset. No
 * duplicated operational data and no analytics engine — every section is
 * derived from the source services/tables.
 */

export type OverviewWorkOrderRef = {
  id: string;
  workOrderNumber: string;
  title: string;
  status: string;
};

export type OverviewFindingCounts = {
  /** OPEN family incl. REWORK_REQUIRED (BE-09 authoritative statuses). */
  open: number;
  rework: number;
  verified: number;
  closed: number;
};

export type OverviewWorkOrderCounts = {
  active: number;
  completedInWindow: number;
};

export type PublicEngineeringOverview = {
  buildingId: string;
  date: string;
  shift: PublicShiftContext | null;
  summary: {
    scheduledOperations: number;
    inProgressOperations: number;
    completedOperations: number;
    activeWorkOrders: number;
    openFindings: number;
    pendingHandoverItems: number;
  };
  operations: DailyOperationsSummary;
  findings: OverviewFindingCounts;
  workOrders: {
    active: OverviewWorkOrderRef[];
    completedInWindow: number;
  };
  handover: {
    drafts: number;
    ready: number;
    acknowledged: number;
    pendingItems: HandoverItem[];
  };
};
