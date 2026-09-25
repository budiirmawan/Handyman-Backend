import { buildingAccessDeniedError, contextAccessService, getAccessibleBuildingIds } from '../context-access';
import { findingRepository, findingService, resolveAvailableActions } from '../findings';
import { permissionService } from '../permissions';
import { tenantBuildingContextRepository } from '../tenant-building-contexts';
import { tenantCompanyNotFoundError, tenantCompanyRepository } from '../tenant-companies';
import { tenantPicRepository } from '../tenant-pics';
import { tenantSpaceRepository } from '../tenant-spaces';
import { workOrderService } from '../work-orders';
import {
  tenantComplaintActionNotAllowedError,
  tenantComplaintComplainantInvalidError,
  tenantComplaintContextInvalidError,
  tenantComplaintFindingExistsError,
  tenantComplaintNotFoundError,
  tenantComplaintNotOpenError,
  tenantComplaintNumberExistsError,
  tenantComplaintSpaceMismatchError,
  tenantComplaintWorkOrderExistsError,
} from './tenant-complaint.errors';
import { tenantComplaintRepository } from './tenant-complaint.repository';
import {
  TENANT_COMPLAINT_INTAKE_ACTIONS,
  type CreateComplaintWorkOrderInput,
  type CreateTenantComplaintInput,
  type NewTenantComplaint,
  type PublicTenantComplaint,
  type TenantComplaintAction,
  type TenantComplaintAvailableActions,
  type TenantComplaintFilters,
  type TenantComplaintIntakeAction,
  type TenantComplaintRecord,
  type UpdateTenantComplaintInput,
} from './tenant-complaint.types';

function toPublic(record: TenantComplaintRecord): PublicTenantComplaint {
  return {
    ...record,
    reportedAt: record.reportedAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function isEffectiveNow(record: { effectiveFrom: Date | null; effectiveUntil: Date | null }): boolean {
  const now = Date.now();
  return (record.effectiveFrom === null || record.effectiveFrom.getTime() <= now) &&
    (record.effectiveUntil === null || record.effectiveUntil.getTime() >= now);
}

async function assertClientAccess(userId: string, clientId: string): Promise<void> {
  if (!(await contextAccessService.canAccessClient(userId, clientId))) {
    throw buildingAccessDeniedError();
  }
}

async function loadAccessible(id: string, actorUserId: string): Promise<TenantComplaintRecord> {
  const record = await tenantComplaintRepository.findById(id);
  if (!record) throw tenantComplaintNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, record.buildingId);
  return record;
}

export async function createTenantComplaint(
  input: CreateTenantComplaintInput,
  actorUserId: string,
  createdByUserId?: string,
): Promise<PublicTenantComplaint> {
  const company = await tenantCompanyRepository.findById(input.tenantCompanyId);
  if (!company) throw tenantCompanyNotFoundError();
  await assertClientAccess(actorUserId, company.clientId);
  await contextAccessService.assertBuildingAccess(actorUserId, input.buildingId);

  const context = await tenantBuildingContextRepository.findActive(
    input.tenantCompanyId,
    input.buildingId,
  );
  if (!context || !isEffectiveNow(context) || company.status !== 'ACTIVE') {
    throw tenantComplaintContextInvalidError();
  }

  const complainant = await tenantPicRepository.findById(input.tenantPicId);
  if (
    !complainant ||
    complainant.tenantCompanyId !== input.tenantCompanyId ||
    complainant.status !== 'ACTIVE'
  ) {
    throw tenantComplaintComplainantInvalidError();
  }

  if (input.spaceId) {
    const relationship = await tenantSpaceRepository.findActiveByTenantBuildingAndSpace(
      input.tenantCompanyId,
      input.buildingId,
      input.spaceId,
    );
    if (!relationship || !isEffectiveNow(relationship)) {
      throw tenantComplaintSpaceMismatchError();
    }
  }

  if (await tenantComplaintRepository.findByNumber(company.clientId, input.complaintNumber)) {
    throw tenantComplaintNumberExistsError();
  }

  const record: NewTenantComplaint = {
    clientId: company.clientId,
    tenantCompanyId: input.tenantCompanyId,
    tenantPicId: input.tenantPicId,
    buildingId: input.buildingId,
    spaceId: input.spaceId ?? null,
    intakeChannel: input.intakeChannel ?? null,
    createdByUserId: createdByUserId ?? actorUserId,
    reporterName: input.reporterName ?? null,
    reporterPhone: input.reporterPhone ?? null,
    reporterEmail: input.reporterEmail ?? null,
    complaintNumber: input.complaintNumber,
    complaintType: input.complaintType,
    title: input.title,
    description: input.description ?? null,
    severity: input.severity ?? 'MEDIUM',
  };
  try {
    return toPublic(await tenantComplaintRepository.create(record));
  } catch (error) {
    if (isUniqueViolation(error, 'tenant_complaints_number_unique')) {
      throw tenantComplaintNumberExistsError();
    }
    throw error;
  }
}

export async function getTenantComplaint(id: string, actorUserId: string): Promise<PublicTenantComplaint> {
  return toPublic(await loadAccessible(id, actorUserId));
}

export async function listTenantComplaints(
  tenantCompanyId: string,
  filters: TenantComplaintFilters,
  actorUserId: string,
): Promise<PublicTenantComplaint[]> {
  const company = await tenantCompanyRepository.findById(tenantCompanyId);
  if (!company) throw tenantCompanyNotFoundError();
  await assertClientAccess(actorUserId, company.clientId);
  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(actorUserId, filters.buildingId);
  }
  const buildingIds = await getAccessibleBuildingIds(actorUserId);
  return (await tenantComplaintRepository.list(
    { ...filters, tenantCompanyId },
    buildingIds,
  )).map(toPublic);
}

export async function listBuildingComplaints(
  buildingId: string,
  filters: TenantComplaintFilters,
  actorUserId: string,
): Promise<PublicTenantComplaint[]> {
  await contextAccessService.assertBuildingAccess(actorUserId, buildingId);
  return (await tenantComplaintRepository.list(
    { ...filters, buildingId },
    [buildingId],
  )).map(toPublic);
}

export async function updateTenantComplaint(
  id: string,
  input: UpdateTenantComplaintInput,
  actorUserId: string,
): Promise<PublicTenantComplaint> {
  const record = await loadAccessible(id, actorUserId);
  await assertIntakeActionAllowed(record, actorUserId, 'UPDATE');
  if (record.status !== 'OPEN') throw tenantComplaintNotOpenError();
  const updated = await tenantComplaintRepository.update(id, input);
  if (!updated) throw tenantComplaintNotFoundError();
  return toPublic(updated);
}

export async function cancelTenantComplaint(
  id: string,
  actorUserId: string,
): Promise<PublicTenantComplaint> {
  const record = await loadAccessible(id, actorUserId);
  await assertIntakeActionAllowed(record, actorUserId, 'CANCEL');
  if (record.status !== 'OPEN') throw tenantComplaintNotOpenError();
  const updated = await tenantComplaintRepository.cancel(id);
  if (!updated) throw tenantComplaintNotFoundError();
  return toPublic(updated);
}

export async function createFindingForTenantComplaint(
  id: string,
  actorUserId: string,
): Promise<PublicTenantComplaint> {
  const record = await loadAccessible(id, actorUserId);
  if (record.findingId) throw tenantComplaintFindingExistsError();
  await assertIntakeActionAllowed(record, actorUserId, 'CREATE_FINDING');
  const pic = await tenantPicRepository.findById(record.tenantPicId);
  const finding = await findingService.createFinding({
    clientId: record.clientId,
    buildingId: record.buildingId,
    findingNumber: record.complaintNumber,
    title: record.title,
    ...(record.description ? { description: record.description } : {}),
    reportedByUserId: pic?.userId ?? actorUserId,
  });
  const updated = await tenantComplaintRepository.bindFinding(id, finding.id);
  if (!updated) throw tenantComplaintNotFoundError();
  return toPublic(updated);
}

export async function createWorkOrderForTenantComplaint(
  id: string,
  input: CreateComplaintWorkOrderInput,
  actorUserId: string,
): Promise<PublicTenantComplaint> {
  const record = await loadAccessible(id, actorUserId);
  if (!record.findingId) throw tenantComplaintActionNotAllowedError('CREATE_WORK_ORDER');
  if (record.workOrderId) throw tenantComplaintWorkOrderExistsError();
  const actions = await resolveAllowedActions(record, actorUserId);
  if (!actions.includes('CREATE_WORK_ORDER')) {
    throw tenantComplaintActionNotAllowedError('CREATE_WORK_ORDER');
  }
  const workOrder = await workOrderService.createWorkOrder({
    clientId: record.clientId,
    buildingId: record.buildingId,
    workOrderNumber: input.workOrderNumber,
    title: record.title,
    ...(record.description ? { description: record.description } : {}),
    workType: record.complaintType,
    createdByUserId: actorUserId,
  });
  if (workOrder.priority !== record.severity) {
    await workOrderService.updateWorkOrderPriority(workOrder.id, {
      priority: record.severity,
    });
  }
  const updated = await tenantComplaintRepository.bindWorkOrder(id, workOrder.id);
  if (!updated) throw tenantComplaintNotFoundError();
  return toPublic(updated);
}

export async function resolveTenantComplaintAvailableActions(
  id: string,
  actorUserId: string,
): Promise<TenantComplaintAvailableActions> {
  const record = await loadAccessible(id, actorUserId);
  return {
    complaintId: record.id,
    state: record.status,
    findingId: record.findingId,
    availableActions: await resolveAllowedActions(record, actorUserId),
  };
}

async function resolveAllowedActions(
  record: TenantComplaintRecord,
  actorUserId: string,
): Promise<TenantComplaintAction[]> {
  const permissions = new Set(await permissionService.resolvePermissionsForUser(actorUserId));
  if (!permissions.has('tenant_company.read')) return [];
  if (record.status === 'OPEN') {
    if (!permissions.has('tenant_company.manage')) return [];
    return TENANT_COMPLAINT_INTAKE_ACTIONS.filter((action) =>
      action !== 'CREATE_FINDING' || permissions.has('finding.manage')
    );
  }
  if (record.status !== 'ESCALATED' || !record.findingId) return [];

  const findingActions = (
    await resolveAvailableActions(record.findingId, { userId: actorUserId })
  ).availableActions;
  const actions: TenantComplaintAction[] = [...findingActions];
  if (
    !record.workOrderId &&
    permissions.has('tenant_company.manage') &&
    permissions.has('finding.read') &&
    permissions.has('work_order.manage')
  ) {
    const finding = await findingRepository.findById(record.findingId);
    if (finding && finding.status !== 'CANCELLED' && finding.status !== 'CLOSED') {
      actions.push('CREATE_WORK_ORDER');
    }
  }
  return actions;
}

async function assertIntakeActionAllowed(
  record: TenantComplaintRecord,
  actorUserId: string,
  action: TenantComplaintIntakeAction,
): Promise<void> {
  if (!(await resolveAllowedActions(record, actorUserId)).includes(action)) {
    throw tenantComplaintActionNotAllowedError(action);
  }
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23505' && candidate.constraint === constraint;
}

export const tenantComplaintService = {
  cancelTenantComplaint,
  createFindingForTenantComplaint,
  createTenantComplaint,
  createWorkOrderForTenantComplaint,
  getTenantComplaint,
  listBuildingComplaints,
  listTenantComplaints,
  resolveTenantComplaintAvailableActions,
  updateTenantComplaint,
};
