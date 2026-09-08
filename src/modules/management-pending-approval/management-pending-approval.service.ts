import type { ManagementReadPeriodRange } from '../management-read-scope';
import {
  createManagementReadModelContract,
  resolveManagementReadScope,
} from '../management-read-scope';
import {
  permitApprovalRepository,
  resolvePermitApprovalAvailableActions,
  type PermitApprovalRecord,
} from '../permit-approvals';
import {
  procurementApprovalRepository,
  resolveProcurementApprovalAvailableActions,
  type ProcurementApprovalRecord,
} from '../procurement-approvals';
import {
  resolveTenantApprovalAvailableActions,
  tenantApprovalRepository,
  type TenantApprovalRecord,
} from '../tenant-approvals';
import {
  managementPendingApprovalRepository,
} from './management-pending-approval.repository';
import type { PendingDocumentApprovalRow } from './management-pending-approval.repository';
import type {
  ManagementPendingApprovalItem,
  ManagementPendingApprovalQuery,
  PublicManagementPendingApproval,
} from './management-pending-approval.types';

type ItemWithoutActions = Omit<ManagementPendingApprovalItem, 'availableActions'>;

/**
 * BE-24 PART 03A — read-only composition over existing approval authorities.
 * No decision or workflow state is stored or derived here.
 */
export async function getManagementPendingApproval(
  query: ManagementPendingApprovalQuery,
  userId: string,
): Promise<PublicManagementPendingApproval> {
  const resolved = await resolveManagementReadScope(query.scope, userId);
  const { context, range } = resolved;
  const buildingIds = context.scope.buildingIds;

  if (buildingIds.length === 0) {
    return createManagementReadModelContract(context, {}, {
      pendingCount: 0,
      items: [],
    });
  }

  const includeClientLevelDocuments =
    context.scope.mode === 'ALL_ACCESSIBLE' || context.scope.mode === 'CLIENT';

  const [permit, procurement, tenant, documents] = await Promise.all([
    permitApprovalRepository.listPending({}, buildingIds),
    procurementApprovalRepository.listPending({}, buildingIds),
    tenantApprovalRepository.listPending({}, buildingIds),
    managementPendingApprovalRepository.listPendingDocumentApprovals(
      buildingIds,
      context.scope.clientIds,
      includeClientLevelDocuments,
      range.start,
      range.end,
    ),
  ]);

  const sourceItems: ItemWithoutActions[] = [
    ...permit
      .filter((record) => withinPeriod(record.createdAt, range))
      .map(mapPermit),
    ...procurement
      .filter((record) => withinPeriod(record.createdAt, range))
      .map(mapProcurement),
    ...tenant
      .filter((record) => withinPeriod(record.createdAt, range))
      .map(mapTenant),
    ...documents.map(mapDocument),
  ].sort(
    (left, right) =>
      left.submittedAt.localeCompare(right.submittedAt) ||
      left.approvalId.localeCompare(right.approvalId),
  );

  // Existing source services remain the sole available-actions authorities.
  const items: ManagementPendingApprovalItem[] = await Promise.all(
    sourceItems.map(async (item) => ({
      ...item,
      availableActions: await resolveAvailableActions(item, userId),
    })),
  );

  return createManagementReadModelContract(context, {}, {
    pendingCount: items.length,
    items,
  });
}

function mapPermit(record: PermitApprovalRecord): ItemWithoutActions {
  return {
    approvalId: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    source: 'PERMIT',
    approvalType: record.approvalType,
    resourceType: 'PERMIT_APPLICATION',
    resourceId: record.permitApplicationId,
    resourceReference: record.permitReference,
    submittedAt: record.createdAt.toISOString(),
    currentStatus: 'PENDING',
  };
}

function mapProcurement(record: ProcurementApprovalRecord): ItemWithoutActions {
  const resourceId =
    record.purchaseRequestId ??
    record.materialRequestId ??
    record.serviceRequestId!;
  return {
    approvalId: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    source: 'PROCUREMENT',
    approvalType: record.approvalType,
    resourceType: record.requestType,
    resourceId,
    resourceReference: resourceId,
    submittedAt: record.createdAt.toISOString(),
    currentStatus: 'PENDING',
  };
}

function mapTenant(record: TenantApprovalRecord): ItemWithoutActions {
  const resourceId =
    record.serviceRequestId ??
    record.complaintId ??
    record.utilityRequestId ??
    record.utilityCalculationId!;
  return {
    approvalId: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    source: 'TENANT',
    approvalType: record.approvalType,
    resourceType: record.requestType,
    resourceId,
    resourceReference: resourceId,
    submittedAt: record.createdAt.toISOString(),
    currentStatus: 'PENDING',
  };
}

function mapDocument(record: PendingDocumentApprovalRow): ItemWithoutActions {
  return {
    approvalId: record.approvalId,
    clientId: record.clientId,
    buildingId: record.buildingId,
    source: 'DOCUMENT',
    approvalType: record.approvalType,
    resourceType: record.resourceType,
    resourceId: record.resourceId,
    resourceReference: record.resourceReference,
    submittedAt: record.submittedAt.toISOString(),
    currentStatus: 'PENDING',
  };
}

async function resolveAvailableActions(
  item: ItemWithoutActions,
  userId: string,
): Promise<string[]> {
  switch (item.source) {
    case 'PERMIT':
      return (
        await resolvePermitApprovalAvailableActions(item.approvalId, userId)
      ).availableActions;
    case 'PROCUREMENT':
      return (
        await resolveProcurementApprovalAvailableActions(item.approvalId, userId)
      ).availableActions;
    case 'TENANT':
      return (
        await resolveTenantApprovalAvailableActions(item.approvalId, userId)
      ).availableActions;
    case 'DOCUMENT':
      // BE-22I exposes decision commands but no available-actions read model.
      // Do not invent one here.
      return [];
  }
}

function withinPeriod(date: Date, range: ManagementReadPeriodRange): boolean {
  if (range.start && date < range.start) return false;
  if (range.end && date >= range.end) return false;
  return true;
}

export const managementPendingApprovalService = {
  getManagementPendingApproval,
};
