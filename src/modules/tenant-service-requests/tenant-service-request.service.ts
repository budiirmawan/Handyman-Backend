import { buildingAccessDeniedError, contextAccessService, getAccessibleBuildingIds } from '../context-access';
import { permissionService } from '../permissions';
import { tenantBuildingContextRepository } from '../tenant-building-contexts';
import { tenantCompanyNotFoundError, tenantCompanyRepository } from '../tenant-companies';
import { tenantPicRepository } from '../tenant-pics';
import { tenantSpaceRepository } from '../tenant-spaces';
import { workOrderService } from '../work-orders';
import { workRequestRepository, workRequestService } from '../work-requests';
import {
  tenantServiceRequestActionNotAllowedError,
  tenantServiceRequestContextInvalidError,
  tenantServiceRequestNotFoundError,
  tenantServiceRequestNotOpenError,
  tenantServiceRequestNumberExistsError,
  tenantServiceRequestRequesterInvalidError,
  tenantServiceRequestSpaceMismatchError,
  tenantServiceRequestWorkOrderExistsError,
  tenantServiceRequestWorkRequestExistsError,
} from './tenant-service-request.errors';
import { tenantServiceRequestRepository } from './tenant-service-request.repository';
import {
  TENANT_SERVICE_REQUEST_ACTIONS,
  type CreateServiceRequestWorkOrderInput,
  type CreateTenantServiceRequestInput,
  type NewTenantServiceRequest,
  type PublicTenantServiceRequest,
  type TenantServiceRequestAction,
  type TenantServiceRequestAvailableActions,
  type TenantServiceRequestFilters,
  type TenantServiceRequestRecord,
  type UpdateTenantServiceRequestInput,
} from './tenant-service-request.types';

function toPublic(record: TenantServiceRequestRecord): PublicTenantServiceRequest {
  return {
    ...record,
    requestedAt: record.requestedAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function isEffectiveNow(record: {
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
}): boolean {
  const now = Date.now();
  return (record.effectiveFrom === null || record.effectiveFrom.getTime() <= now) &&
    (record.effectiveUntil === null || record.effectiveUntil.getTime() >= now);
}

async function assertClientAccess(userId: string, clientId: string): Promise<void> {
  if (!(await contextAccessService.canAccessClient(userId, clientId))) {
    throw buildingAccessDeniedError();
  }
}

async function loadAccessible(
  id: string,
  actorUserId: string,
): Promise<TenantServiceRequestRecord> {
  const record = await tenantServiceRequestRepository.findById(id);
  if (!record) throw tenantServiceRequestNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, record.buildingId);
  return record;
}

export async function createTenantServiceRequest(
  input: CreateTenantServiceRequestInput,
  actorUserId: string,
  createdByUserId?: string,
): Promise<PublicTenantServiceRequest> {
  const company = await tenantCompanyRepository.findById(input.tenantCompanyId);
  if (!company) throw tenantCompanyNotFoundError();
  await assertClientAccess(actorUserId, company.clientId);
  await contextAccessService.assertBuildingAccess(actorUserId, input.buildingId);

  const context = await tenantBuildingContextRepository.findActive(
    input.tenantCompanyId,
    input.buildingId,
  );
  if (!context || !isEffectiveNow(context) || company.status !== 'ACTIVE') {
    throw tenantServiceRequestContextInvalidError();
  }

  const requester = await tenantPicRepository.findById(input.tenantPicId);
  if (
    !requester ||
    requester.tenantCompanyId !== input.tenantCompanyId ||
    requester.status !== 'ACTIVE'
  ) {
    throw tenantServiceRequestRequesterInvalidError();
  }

  if (input.spaceId) {
    const relationship =
      await tenantSpaceRepository.findActiveByTenantBuildingAndSpace(
        input.tenantCompanyId,
        input.buildingId,
        input.spaceId,
      );
    if (!relationship || !isEffectiveNow(relationship)) {
      throw tenantServiceRequestSpaceMismatchError();
    }
  }

  if (
    await tenantServiceRequestRepository.findByNumber(
      company.clientId,
      input.requestNumber,
    )
  ) {
    throw tenantServiceRequestNumberExistsError();
  }

  const record: NewTenantServiceRequest = {
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
    requestNumber: input.requestNumber,
    requestType: input.requestType,
    title: input.title,
    description: input.description ?? null,
    priority: input.priority ?? 'MEDIUM',
  };
  try {
    return toPublic(await tenantServiceRequestRepository.create(record));
  } catch (error) {
    if (isUniqueViolation(error, 'tenant_service_requests_number_unique')) {
      throw tenantServiceRequestNumberExistsError();
    }
    throw error;
  }
}

export async function getTenantServiceRequest(
  id: string,
  actorUserId: string,
): Promise<PublicTenantServiceRequest> {
  return toPublic(await loadAccessible(id, actorUserId));
}

export async function listTenantServiceRequests(
  tenantCompanyId: string,
  filters: TenantServiceRequestFilters,
  actorUserId: string,
): Promise<PublicTenantServiceRequest[]> {
  const company = await tenantCompanyRepository.findById(tenantCompanyId);
  if (!company) throw tenantCompanyNotFoundError();
  await assertClientAccess(actorUserId, company.clientId);
  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(actorUserId, filters.buildingId);
  }
  const buildingIds = await getAccessibleBuildingIds(actorUserId);
  return (
    await tenantServiceRequestRepository.list(
      { ...filters, tenantCompanyId },
      buildingIds,
    )
  ).map(toPublic);
}

export async function listBuildingServiceRequests(
  buildingId: string,
  filters: TenantServiceRequestFilters,
  actorUserId: string,
): Promise<PublicTenantServiceRequest[]> {
  await contextAccessService.assertBuildingAccess(actorUserId, buildingId);
  return (
    await tenantServiceRequestRepository.list(
      { ...filters, buildingId },
      [buildingId],
    )
  ).map(toPublic);
}

export async function updateTenantServiceRequest(
  id: string,
  input: UpdateTenantServiceRequestInput,
  actorUserId: string,
): Promise<PublicTenantServiceRequest> {
  const record = await loadAccessible(id, actorUserId);
  await assertServiceRequestActionAllowed(record, actorUserId, 'UPDATE');
  if (record.status !== 'OPEN') throw tenantServiceRequestNotOpenError();
  const updated = await tenantServiceRequestRepository.update(id, input);
  if (!updated) throw tenantServiceRequestNotFoundError();
  return toPublic(updated);
}

export async function cancelTenantServiceRequest(
  id: string,
  actorUserId: string,
): Promise<PublicTenantServiceRequest> {
  const record = await loadAccessible(id, actorUserId);
  await assertServiceRequestActionAllowed(record, actorUserId, 'CANCEL');
  if (record.status !== 'OPEN') throw tenantServiceRequestNotOpenError();
  const updated = await tenantServiceRequestRepository.cancel(id);
  if (!updated) throw tenantServiceRequestNotFoundError();
  return toPublic(updated);
}

export async function createWorkRequestForTenantServiceRequest(
  id: string,
  actorUserId: string,
): Promise<PublicTenantServiceRequest> {
  const record = await loadAccessible(id, actorUserId);
  if (record.workRequestId) throw tenantServiceRequestWorkRequestExistsError();
  await assertServiceRequestActionAllowed(record, actorUserId, 'CREATE_WORK_REQUEST');
  const pic = await tenantPicRepository.findById(record.tenantPicId);
  const workRequest = await workRequestService.createWorkRequest({
    clientId: record.clientId,
    buildingId: record.buildingId,
    requestNumber: record.requestNumber,
    title: record.title,
    ...(record.description ? { description: record.description } : {}),
    requestType: record.requestType,
    requestedByUserId: pic?.userId ?? actorUserId,
  });
  const updated = await tenantServiceRequestRepository.bindWorkRequest(
    id,
    workRequest.id,
  );
  if (!updated) throw tenantServiceRequestNotFoundError();
  return toPublic(updated);
}

export async function createWorkOrderForTenantServiceRequest(
  id: string,
  input: CreateServiceRequestWorkOrderInput,
  actorUserId: string,
): Promise<PublicTenantServiceRequest> {
  const record = await loadAccessible(id, actorUserId);
  if (!record.workRequestId) throw tenantServiceRequestActionNotAllowedError('CREATE_WORK_ORDER');
  if (record.workOrderId) throw tenantServiceRequestWorkOrderExistsError();
  await assertServiceRequestActionAllowed(record, actorUserId, 'CREATE_WORK_ORDER');
  const workOrder = await workOrderService.createWorkOrderFromRequest({
    workRequestId: record.workRequestId,
    workOrderNumber: input.workOrderNumber,
    title: record.title,
    ...(record.description ? { description: record.description } : {}),
    workType: record.requestType,
    createdByUserId: actorUserId,
  });
  if (workOrder.priority !== record.priority) {
    await workOrderService.updateWorkOrderPriority(workOrder.id, {
      priority: record.priority,
    });
  }
  const updated = await tenantServiceRequestRepository.bindWorkOrder(
    id,
    workOrder.id,
  );
  if (!updated) throw tenantServiceRequestNotFoundError();
  return toPublic(updated);
}

export async function resolveTenantServiceRequestAvailableActions(
  id: string,
  actorUserId: string,
): Promise<TenantServiceRequestAvailableActions> {
  const record = await loadAccessible(id, actorUserId);
  const allowed = await resolveAllowedActions(record, actorUserId);
  return {
    serviceRequestId: record.id,
    state: record.status,
    availableActions: TENANT_SERVICE_REQUEST_ACTIONS.filter((action) =>
      allowed.has(action)
    ),
  };
}

async function resolveAllowedActions(
  record: TenantServiceRequestRecord,
  actorUserId: string,
): Promise<Set<TenantServiceRequestAction>> {
  const permissions = new Set(
    await permissionService.resolvePermissionsForUser(actorUserId),
  );
  const allowed = new Set<TenantServiceRequestAction>();
  if (!permissions.has('tenant_company.read')) return allowed;
  const canManage = permissions.has('tenant_company.manage');
  if (record.status === 'OPEN' && canManage) {
    allowed.add('UPDATE');
    allowed.add('CANCEL');
    if (permissions.has('work_request.manage')) {
      allowed.add('CREATE_WORK_REQUEST');
    }
  }
  if (
    record.status === 'CONVERTED' &&
    record.workRequestId &&
    !record.workOrderId &&
    canManage &&
    permissions.has('work_request.manage') &&
    permissions.has('work_order.manage')
  ) {
    const workRequest = await workRequestRepository.findById(record.workRequestId);
    if (workRequest?.status === 'OPEN') allowed.add('CREATE_WORK_ORDER');
  }
  return allowed;
}

async function assertServiceRequestActionAllowed(
  record: TenantServiceRequestRecord,
  actorUserId: string,
  action: TenantServiceRequestAction,
): Promise<void> {
  if (!(await resolveAllowedActions(record, actorUserId)).has(action)) {
    throw tenantServiceRequestActionNotAllowedError(action);
  }
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23505' && candidate.constraint === constraint;
}

export const tenantServiceRequestService = {
  cancelTenantServiceRequest,
  createTenantServiceRequest,
  createWorkOrderForTenantServiceRequest,
  createWorkRequestForTenantServiceRequest,
  getTenantServiceRequest,
  listBuildingServiceRequests,
  listTenantServiceRequests,
  resolveTenantServiceRequestAvailableActions,
  updateTenantServiceRequest,
};
