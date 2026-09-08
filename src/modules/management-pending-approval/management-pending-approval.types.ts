import type {
  ManagementReadModelContract,
  ManagementReadScopeFilters,
} from '../management-read-scope';

/** BE-24 PART 03A — unified read projection over existing approval engines. */

export const MANAGEMENT_APPROVAL_SOURCES = [
  'PERMIT',
  'PROCUREMENT',
  'TENANT',
  'DOCUMENT',
] as const;
export type ManagementApprovalSource =
  (typeof MANAGEMENT_APPROVAL_SOURCES)[number];

export type ManagementPendingApprovalQuery = {
  scope: ManagementReadScopeFilters;
};

export type ManagementPendingApprovalItem = {
  approvalId: string;
  clientId: string;
  buildingId: string | null;
  source: ManagementApprovalSource;
  approvalType: string;
  resourceType: string;
  resourceId: string;
  /** Human reference when the source exposes one; otherwise the stable id. */
  resourceReference: string;
  submittedAt: string;
  currentStatus: 'PENDING';
  /** Delegated to the source authority; never inferred by this read model. */
  availableActions: string[];
};

export type ManagementPendingApprovalData = {
  pendingCount: number;
  items: ManagementPendingApprovalItem[];
};

export type PublicManagementPendingApproval = ManagementReadModelContract<
  ManagementPendingApprovalData
>;
