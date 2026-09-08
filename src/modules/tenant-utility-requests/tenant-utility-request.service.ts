import { buildingAccessDeniedError, contextAccessService, getAccessibleBuildingIds } from '../context-access';
import { permissionService } from '../permissions';
import { tenantBuildingContextRepository } from '../tenant-building-contexts';
import { tenantCompanyNotFoundError, tenantCompanyRepository } from '../tenant-companies';
import { tenantPicRepository } from '../tenant-pics';
import { tenantSpaceRepository } from '../tenant-spaces';
import { workOrderService } from '../work-orders';
import { workRequestRepository, workRequestService } from '../work-requests';
import {
  tenantUtilityRequestActionNotAllowedError,
  tenantUtilityRequestContextInvalidError,
  tenantUtilityRequestNotFoundError,
  tenantUtilityRequestNotOpenError,
  tenantUtilityRequestNumberExistsError,
  tenantUtilityRequestRequesterInvalidError,
  tenantUtilityRequestSpaceInvalidError,
  tenantUtilityRequestWorkOrderExistsError,
  tenantUtilityRequestWorkRequestExistsError,
} from './tenant-utility-request.errors';
import { tenantUtilityRequestRepository } from './tenant-utility-request.repository';
import {
  TENANT_UTILITY_REQUEST_ACTIONS,
  type CreateTenantUtilityRequestInput,
  type CreateUtilityRequestWorkOrderInput,
  type NewTenantUtilityRequest,
  type PublicTenantUtilityRequest,
  type TenantUtilityRequestAction,
  type TenantUtilityRequestAvailableActions,
  type TenantUtilityRequestFilters,
  type TenantUtilityRequestRecord,
  type UpdateTenantUtilityRequestInput,
} from './tenant-utility-request.types';

function toPublic(record: TenantUtilityRequestRecord): PublicTenantUtilityRequest {
  return {
    ...record,
    requestedAt: record.requestedAt.toISOString(),
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
async function loadAccessible(id: string, actorUserId: string): Promise<TenantUtilityRequestRecord> {
  const record = await tenantUtilityRequestRepository.findById(id);
  if (!record) throw tenantUtilityRequestNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, record.buildingId);
  return record;
}
function operationalTitle(record: Pick<TenantUtilityRequestRecord, 'utilityType'>): string {
  return `Utility request: ${record.utilityType}`;
}
function operationalDescription(
  record: Pick<TenantUtilityRequestRecord, 'requestDetails' | 'notes'>,
): string {
  return record.notes
    ? `${record.requestDetails}\n\nNotes: ${record.notes}`
    : record.requestDetails;
}

export async function createTenantUtilityRequest(
  input: CreateTenantUtilityRequestInput,
  actorUserId: string,
): Promise<PublicTenantUtilityRequest> {
  const company = await tenantCompanyRepository.findById(input.tenantCompanyId);
  if (!company) throw tenantCompanyNotFoundError();
  await assertClientAccess(actorUserId, company.clientId);
  await contextAccessService.assertBuildingAccess(actorUserId, input.buildingId);
  const context = await tenantBuildingContextRepository.findActive(
    input.tenantCompanyId,
    input.buildingId,
  );
  if (!context || !isEffectiveNow(context) || company.status !== 'ACTIVE') {
    throw tenantUtilityRequestContextInvalidError();
  }
  const requester = await tenantPicRepository.findById(input.tenantPicId);
  if (
    !requester ||
    requester.tenantCompanyId !== input.tenantCompanyId ||
    requester.status !== 'ACTIVE'
  ) {
    throw tenantUtilityRequestRequesterInvalidError();
  }
  const space = await tenantSpaceRepository.findActiveByTenantBuildingAndSpace(
    input.tenantCompanyId,
    input.buildingId,
    input.spaceId,
  );
  if (!space || !isEffectiveNow(space)) throw tenantUtilityRequestSpaceInvalidError();
  if (await tenantUtilityRequestRepository.findByNumber(company.clientId, input.requestNumber)) {
    throw tenantUtilityRequestNumberExistsError();
  }

  const record: NewTenantUtilityRequest = {
    clientId: company.clientId,
    tenantCompanyId: input.tenantCompanyId,
    tenantPicId: input.tenantPicId,
    buildingId: input.buildingId,
    spaceId: input.spaceId,
    utilityType: input.utilityType,
    requestNumber: input.requestNumber,
    requestDetails: input.requestDetails,
    notes: input.notes ?? null,
  };
  try {
    return toPublic(await tenantUtilityRequestRepository.create(record));
  } catch (error) {
    if (isUniqueViolation(error, 'tenant_utility_requests_number_unique')) {
      throw tenantUtilityRequestNumberExistsError();
    }
    throw error;
  }
}

export async function getTenantUtilityRequest(
  id: string,
  actorUserId: string,
): Promise<PublicTenantUtilityRequest> {
  return toPublic(await loadAccessible(id, actorUserId));
}

export async function listTenantUtilityRequests(
  tenantCompanyId: string,
  filters: TenantUtilityRequestFilters,
  actorUserId: string,
): Promise<PublicTenantUtilityRequest[]> {
  const company = await tenantCompanyRepository.findById(tenantCompanyId);
  if (!company) throw tenantCompanyNotFoundError();
  await assertClientAccess(actorUserId, company.clientId);
  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(actorUserId, filters.buildingId);
  }
  const buildingIds = await getAccessibleBuildingIds(actorUserId);
  return (await tenantUtilityRequestRepository.list(
    { ...filters, tenantCompanyId },
    buildingIds,
  )).map(toPublic);
}

export async function listBuildingUtilityRequests(
  buildingId: string,
  filters: TenantUtilityRequestFilters,
  actorUserId: string,
): Promise<PublicTenantUtilityRequest[]> {
  await contextAccessService.assertBuildingAccess(actorUserId, buildingId);
  return (await tenantUtilityRequestRepository.list(
    { ...filters, buildingId },
    [buildingId],
  )).map(toPublic);
}

export async function updateTenantUtilityRequest(
  id: string,
  input: UpdateTenantUtilityRequestInput,
  actorUserId: string,
): Promise<PublicTenantUtilityRequest> {
  const record = await loadAccessible(id, actorUserId);
  await assertActionAllowed(record, actorUserId, 'UPDATE');
  if (record.status !== 'OPEN') throw tenantUtilityRequestNotOpenError();
  const updated = await tenantUtilityRequestRepository.update(id, input);
  if (!updated) throw tenantUtilityRequestNotFoundError();
  return toPublic(updated);
}

export async function cancelTenantUtilityRequest(
  id: string,
  actorUserId: string,
): Promise<PublicTenantUtilityRequest> {
  const record = await loadAccessible(id, actorUserId);
  await assertActionAllowed(record, actorUserId, 'CANCEL');
  if (record.status !== 'OPEN') throw tenantUtilityRequestNotOpenError();
  const updated = await tenantUtilityRequestRepository.cancel(id);
  if (!updated) throw tenantUtilityRequestNotFoundError();
  return toPublic(updated);
}

export async function createWorkRequestForTenantUtilityRequest(
  id: string,
  actorUserId: string,
): Promise<PublicTenantUtilityRequest> {
  const record = await loadAccessible(id, actorUserId);
  if (record.workRequestId) throw tenantUtilityRequestWorkRequestExistsError();
  await assertActionAllowed(record, actorUserId, 'CREATE_WORK_REQUEST');
  const pic = await tenantPicRepository.findById(record.tenantPicId);
  const workRequest = await workRequestService.createWorkRequest({
    clientId: record.clientId,
    buildingId: record.buildingId,
    requestNumber: record.requestNumber,
    title: operationalTitle(record),
    description: operationalDescription(record),
    requestType: record.utilityType,
    requestedByUserId: pic?.userId ?? actorUserId,
  });
  const updated = await tenantUtilityRequestRepository.bindWorkRequest(id, workRequest.id);
  if (!updated) throw tenantUtilityRequestNotFoundError();
  return toPublic(updated);
}

export async function createWorkOrderForTenantUtilityRequest(
  id: string,
  input: CreateUtilityRequestWorkOrderInput,
  actorUserId: string,
): Promise<PublicTenantUtilityRequest> {
  const record = await loadAccessible(id, actorUserId);
  if (!record.workRequestId) throw tenantUtilityRequestActionNotAllowedError('CREATE_WORK_ORDER');
  if (record.workOrderId) throw tenantUtilityRequestWorkOrderExistsError();
  await assertActionAllowed(record, actorUserId, 'CREATE_WORK_ORDER');
  const workOrder = await workOrderService.createWorkOrderFromRequest({
    workRequestId: record.workRequestId,
    workOrderNumber: input.workOrderNumber,
    title: operationalTitle(record),
    description: operationalDescription(record),
    workType: record.utilityType,
    createdByUserId: actorUserId,
  });
  const updated = await tenantUtilityRequestRepository.bindWorkOrder(id, workOrder.id);
  if (!updated) throw tenantUtilityRequestNotFoundError();
  return toPublic(updated);
}

export async function resolveTenantUtilityRequestAvailableActions(
  id: string,
  actorUserId: string,
): Promise<TenantUtilityRequestAvailableActions> {
  const record = await loadAccessible(id, actorUserId);
  const allowed = await resolveAllowedActions(record, actorUserId);
  return {
    utilityRequestId: record.id,
    state: record.status,
    availableActions: TENANT_UTILITY_REQUEST_ACTIONS.filter((action) => allowed.has(action)),
  };
}

async function resolveAllowedActions(
  record: TenantUtilityRequestRecord,
  actorUserId: string,
): Promise<Set<TenantUtilityRequestAction>> {
  const permissions = new Set(await permissionService.resolvePermissionsForUser(actorUserId));
  const actions = new Set<TenantUtilityRequestAction>();
  if (!permissions.has('tenant_company.read')) return actions;
  if (record.status === 'OPEN' && permissions.has('tenant_company.manage')) {
    actions.add('UPDATE');
    actions.add('CANCEL');
    if (permissions.has('work_request.manage')) actions.add('CREATE_WORK_REQUEST');
  }
  if (
    record.status === 'CONVERTED' && record.workRequestId && !record.workOrderId &&
    permissions.has('tenant_company.manage') &&
    permissions.has('work_request.manage') &&
    permissions.has('work_order.manage')
  ) {
    const workRequest = await workRequestRepository.findById(record.workRequestId);
    if (workRequest?.status === 'OPEN') actions.add('CREATE_WORK_ORDER');
  }
  return actions;
}

async function assertActionAllowed(
  record: TenantUtilityRequestRecord,
  actorUserId: string,
  action: TenantUtilityRequestAction,
): Promise<void> {
  if (!(await resolveAllowedActions(record, actorUserId)).has(action)) {
    throw tenantUtilityRequestActionNotAllowedError(action);
  }
}
function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23505' && candidate.constraint === constraint;
}

export const tenantUtilityRequestService = {
  cancelTenantUtilityRequest,
  createTenantUtilityRequest,
  createWorkOrderForTenantUtilityRequest,
  createWorkRequestForTenantUtilityRequest,
  getTenantUtilityRequest,
  listBuildingUtilityRequests,
  listTenantUtilityRequests,
  resolveTenantUtilityRequestAvailableActions,
  updateTenantUtilityRequest,
};
