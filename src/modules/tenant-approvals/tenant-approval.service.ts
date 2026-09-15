import { buildingAccessDeniedError, contextAccessService, getAccessibleBuildingIds } from '../context-access';
import { permissionService } from '../permissions';
import { tenantCompanyNotFoundError, tenantCompanyRepository } from '../tenant-companies';
import { tenantComplaintRepository } from '../tenant-complaints';
import { tenantServiceRequestRepository } from '../tenant-service-requests';
import { tenantUtilityRequestRepository } from '../tenant-utility-requests';
import { userRepository } from '../users';
import { utilityCalculationRepository } from '../utility-calculations/utility-calculation.repository';
import { utilityMeterTenantRepository } from '../utility-meter-tenants';
import { utilityMeterRepository } from '../utility-meters/utility-meter.repository';
import {
  tenantApprovalActionNotAllowedError,
  tenantApprovalAlreadyDecidedError,
  tenantApprovalAlreadyPendingError,
  tenantApprovalApproverInvalidError,
  tenantApprovalContextMismatchError,
  tenantApprovalNotFoundError,
  tenantApprovalRequestInvalidError,
  tenantApprovalUnauthorizedApproverError,
} from './tenant-approval.errors';
import { tenantApprovalRepository } from './tenant-approval.repository';
import {
  TENANT_APPROVAL_ACTIONS,
  type CreateTenantApprovalInput,
  type NewTenantApproval,
  type PublicTenantApproval,
  type TenantApprovalAction,
  type TenantApprovalAvailableActions,
  type TenantApprovalDecisionInput,
  type TenantApprovalPendingFilters,
  type TenantApprovalRecord,
  type TenantApprovalRequestType,
  type UtilityCalculationApprovalContext,
} from './tenant-approval.types';

type UtilityApprovalSnapshot = {
  spaceId: string;
  meterId: string;
  meterPurpose: 'TENANT';
  utilityType: 'ELECTRICITY' | 'WATER';
  periodStart: Date;
  periodEnd: Date;
  consumptionQuantity: string;
  uomId: string;
  tariffId: string;
  tariffRate: string;
  calculatedAmount: string;
  currency: string;
};
type RequestContext = {
  clientId: string;
  tenantCompanyId: string;
  buildingId: string;
  status: string;
  utilitySnapshot?: UtilityApprovalSnapshot;
};

function requestId(record: TenantApprovalRecord): string {
  return (
    record.serviceRequestId ??
    record.complaintId ??
    record.utilityRequestId ??
    record.utilityCalculationId!
  );
}
function toPublic(record: TenantApprovalRecord): PublicTenantApproval {
  return {
    ...record,
    requestId: requestId(record),
    decidedAt: record.decidedAt?.toISOString() ?? null,
    utilityPeriodStart: record.utilityPeriodStart?.toISOString() ?? null,
    utilityPeriodEnd: record.utilityPeriodEnd?.toISOString() ?? null,
    utilityConsumptionQuantity: record.utilityConsumptionQuantity === null
      ? null : Number(record.utilityConsumptionQuantity),
    utilityTariffRate: record.utilityTariffRate === null
      ? null : Number(record.utilityTariffRate),
    utilityCalculatedAmount: record.utilityCalculatedAmount === null
      ? null : Number(record.utilityCalculatedAmount),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

async function resolveRequest(
  type: TenantApprovalRequestType,
  id: string,
): Promise<RequestContext> {
  if (type === 'UTILITY_CALCULATION') {
    return resolveUtilityCalculationRequest(id);
  }
  const record = type === 'SERVICE_REQUEST'
    ? await tenantServiceRequestRepository.findById(id)
    : type === 'COMPLAINT'
      ? await tenantComplaintRepository.findById(id)
      : await tenantUtilityRequestRepository.findById(id);
  if (!record) throw tenantApprovalRequestInvalidError();
  return {
    clientId: record.clientId,
    tenantCompanyId: record.tenantCompanyId,
    buildingId: record.buildingId,
    status: record.status,
  };
}

/**
 * BE-18L — resolves a BE-18I Tenant utility calculation into the same request
 * context the other targets produce, and validates the Tenant / Meter /
 * Building chain while doing so.
 *
 * A calculation is only approvable when it actually belongs to a Tenant: an
 * unattributed (landlord-side) charge has no Tenant to approve it, so it is
 * rejected rather than silently bound to nobody. The Meter is re-read from
 * BE-18A to confirm it still agrees on Client and Building — a calculation
 * whose Meter has since moved is not a context anyone may approve.
 *
 * `status` is mapped so the engine's existing "target must be OPEN" rule
 * expresses the utility rule: only a FINALIZED calculation may be approved.
 * A DRAFT figure can still change, and a SUPERSEDED one has been replaced.
 */
async function resolveUtilityCalculationRequest(
  id: string,
): Promise<RequestContext> {
  const calculation = await utilityCalculationRepository.findById(id);
  if (!calculation) throw tenantApprovalRequestInvalidError();
  if (!calculation.tenantCompanyId) {
    throw tenantApprovalContextMismatchError(
      'This utility calculation is not attributed to a Tenant Company.',
    );
  }

  const meter = await utilityMeterRepository.findById(calculation.meterId);
  if (!meter) {
    throw tenantApprovalContextMismatchError(
      'The Meter behind this utility calculation no longer exists.',
    );
  }
  if (
    meter.clientId !== calculation.clientId ||
    meter.buildingId !== calculation.buildingId
  ) {
    throw tenantApprovalContextMismatchError();
  }

  const assignment = calculation.tenantAssignmentId
    ? await utilityMeterTenantRepository.findById(calculation.tenantAssignmentId)
    : null;
  if (
    meter.purpose !== 'TENANT' ||
    !assignment ||
    assignment.clientId !== calculation.clientId ||
    assignment.buildingId !== calculation.buildingId ||
    assignment.meterId !== calculation.meterId ||
    assignment.tenantCompanyId !== calculation.tenantCompanyId ||
    (calculation.utilityType !== 'ELECTRICITY' && calculation.utilityType !== 'WATER') ||
    !calculation.tariffId || calculation.tariffRate === null || !calculation.currency
  ) {
    throw tenantApprovalContextMismatchError(
      'Only finalized tariff charges for TENANT-purpose meters may enter Tenant approval.',
    );
  }

  const tenantCompany = await tenantCompanyRepository.findById(
    calculation.tenantCompanyId,
  );
  if (!tenantCompany) throw tenantCompanyNotFoundError();
  if (tenantCompany.clientId !== calculation.clientId) {
    throw tenantApprovalContextMismatchError(
      'The Tenant Company belongs to a different Client.',
    );
  }

  return {
    clientId: calculation.clientId,
    tenantCompanyId: calculation.tenantCompanyId,
    buildingId: calculation.buildingId,
    status: calculation.status === 'FINALIZED' ? 'OPEN' : calculation.status,
    utilitySnapshot: {
      spaceId: assignment.spaceId,
      meterId: calculation.meterId,
      meterPurpose: 'TENANT',
      utilityType: calculation.utilityType,
      periodStart: calculation.periodStart,
      periodEnd: calculation.periodEnd,
      consumptionQuantity: calculation.consumptionQuantity,
      uomId: calculation.uomId,
      tariffId: calculation.tariffId,
      tariffRate: calculation.tariffRate,
      calculatedAmount: calculation.calculatedAmount,
      currency: calculation.currency,
    },
  };
}

async function canApprove(userId: string, buildingId: string): Promise<boolean> {
  const user = await userRepository.findById(userId);
  if (!user || user.status !== 'ACTIVE') return false;
  if (!(await contextAccessService.canAccessBuilding(userId, buildingId))) return false;
  return (await permissionService.resolvePermissionsForUser(userId)).includes(
    'tenant_company.manage',
  );
}

export async function createTenantApproval(
  input: CreateTenantApprovalInput,
  actorUserId: string,
): Promise<PublicTenantApproval> {
  const target = await resolveRequest(input.requestType, input.requestId);
  await contextAccessService.assertBuildingAccess(actorUserId, target.buildingId);
  if (target.status !== 'OPEN') throw tenantApprovalRequestInvalidError();
  if (!(await canApprove(input.approverUserId, target.buildingId))) {
    throw tenantApprovalApproverInvalidError();
  }
  if (await tenantApprovalRepository.findPendingDuplicate(input)) {
    throw tenantApprovalAlreadyPendingError();
  }

  const record: NewTenantApproval = {
    clientId: target.clientId,
    tenantCompanyId: target.tenantCompanyId,
    buildingId: target.buildingId,
    requestType: input.requestType,
    serviceRequestId: input.requestType === 'SERVICE_REQUEST' ? input.requestId : null,
    complaintId: input.requestType === 'COMPLAINT' ? input.requestId : null,
    utilityRequestId: input.requestType === 'UTILITY_REQUEST' ? input.requestId : null,
    utilityCalculationId:
      input.requestType === 'UTILITY_CALCULATION' ? input.requestId : null,
    utilitySpaceId: target.utilitySnapshot?.spaceId ?? null,
    utilityMeterId: target.utilitySnapshot?.meterId ?? null,
    utilityMeterPurpose: target.utilitySnapshot?.meterPurpose ?? null,
    utilityType: target.utilitySnapshot?.utilityType ?? null,
    utilityPeriodStart: target.utilitySnapshot?.periodStart ?? null,
    utilityPeriodEnd: target.utilitySnapshot?.periodEnd ?? null,
    utilityConsumptionQuantity: target.utilitySnapshot?.consumptionQuantity ?? null,
    utilityUomId: target.utilitySnapshot?.uomId ?? null,
    utilityTariffId: target.utilitySnapshot?.tariffId ?? null,
    utilityTariffRate: target.utilitySnapshot?.tariffRate ?? null,
    utilityCalculatedAmount: target.utilitySnapshot?.calculatedAmount ?? null,
    utilityCurrency: target.utilitySnapshot?.currency ?? null,
    approvalType: input.approvalType,
    approverUserId: input.approverUserId,
    createdByUserId: actorUserId,
  };
  try {
    return toPublic(await tenantApprovalRepository.create(record));
  } catch (error) {
    if (isPendingUnique(error)) throw tenantApprovalAlreadyPendingError();
    throw error;
  }
}

export async function getTenantApproval(
  id: string,
  actorUserId: string,
): Promise<PublicTenantApproval> {
  const record = await tenantApprovalRepository.findById(id);
  if (!record) throw tenantApprovalNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, record.buildingId);
  return toPublic(record);
}

export async function listPendingTenantApprovals(
  filters: TenantApprovalPendingFilters,
  actorUserId: string,
): Promise<PublicTenantApproval[]> {
  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(actorUserId, filters.buildingId);
  }
  if (filters.tenantCompanyId) {
    const company = await tenantCompanyRepository.findById(filters.tenantCompanyId);
    if (!company) throw tenantCompanyNotFoundError();
    if (!(await contextAccessService.canAccessClient(actorUserId, company.clientId))) {
      throw buildingAccessDeniedError();
    }
  }
  const buildingIds = await getAccessibleBuildingIds(actorUserId);
  return (await tenantApprovalRepository.listPending(filters, buildingIds)).map(toPublic);
}

export async function approveTenantApproval(
  id: string,
  input: TenantApprovalDecisionInput,
  actorUserId: string,
): Promise<PublicTenantApproval> {
  return decide(id, 'APPROVED', input.decisionNotes ?? null, actorUserId, 'APPROVE');
}

export async function rejectTenantApproval(
  id: string,
  input: TenantApprovalDecisionInput,
  actorUserId: string,
): Promise<PublicTenantApproval> {
  return decide(id, 'REJECTED', input.decisionNotes ?? null, actorUserId, 'REJECT');
}

async function decide(
  id: string,
  status: 'APPROVED' | 'REJECTED',
  notes: string | null,
  actorUserId: string,
  action: TenantApprovalAction,
): Promise<PublicTenantApproval> {
  const record = await tenantApprovalRepository.findById(id);
  if (!record) throw tenantApprovalNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, record.buildingId);
  if (record.status !== 'PENDING') throw tenantApprovalAlreadyDecidedError();
  if (record.approverUserId !== actorUserId) {
    throw tenantApprovalUnauthorizedApproverError();
  }
  if (!(await resolveAllowedActions(record, actorUserId)).has(action)) {
    throw tenantApprovalActionNotAllowedError(action);
  }
  const updated = await tenantApprovalRepository.decide(id, status, notes);
  if (!updated) throw tenantApprovalAlreadyDecidedError();
  return toPublic(updated);
}

/**
 * BE-18L — GET /utility/calculations/:id/tenant-approvals.
 *
 * The Tenant utility approval context: the validated Tenant / Meter /
 * Building chain, whether the calculation may be bound at all, and every
 * binding raised against it so far. Backend-authoritative — the client never
 * decides for itself whether a charge is approvable.
 */
export async function getUtilityCalculationApprovalContext(
  utilityCalculationId: string,
  actorUserId: string,
): Promise<UtilityCalculationApprovalContext> {
  const target = await resolveRequest('UTILITY_CALCULATION', utilityCalculationId);
  await contextAccessService.assertBuildingAccess(actorUserId, target.buildingId);

  const records = await tenantApprovalRepository.listByUtilityCalculation(
    utilityCalculationId,
  );
  const approvals = records.map(toPublic);

  return {
    utilityCalculationId,
    clientId: target.clientId,
    tenantCompanyId: target.tenantCompanyId,
    buildingId: target.buildingId,
    approvable: target.status === 'OPEN',
    pendingApprovals: approvals.filter((item) => item.status === 'PENDING'),
    approvals,
  };
}

export async function resolveTenantApprovalAvailableActions(
  id: string,
  actorUserId: string,
): Promise<TenantApprovalAvailableActions> {
  const record = await tenantApprovalRepository.findById(id);
  if (!record) throw tenantApprovalNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, record.buildingId);
  const allowed = await resolveAllowedActions(record, actorUserId);
  return {
    approvalId: record.id,
    state: record.status,
    availableActions: TENANT_APPROVAL_ACTIONS.filter((action) => allowed.has(action)),
  };
}

async function resolveAllowedActions(
  record: TenantApprovalRecord,
  actorUserId: string,
): Promise<Set<TenantApprovalAction>> {
  const allowed = new Set<TenantApprovalAction>();
  if (record.status !== 'PENDING' || record.approverUserId !== actorUserId) {
    return allowed;
  }
  if (!(await canApprove(actorUserId, record.buildingId))) return allowed;
  if (record.requestType !== 'UTILITY_CALCULATION') {
    const target = await resolveRequest(record.requestType, requestId(record));
    if (target.status !== 'OPEN') return allowed;
  } else {
    // CR-BE-UTL-02 — re-resolve the current calculation instead of trusting
    // only the binding snapshot: a SUPERSEDED (or DRAFT) calculation must
    // never expose APPROVE/REJECT, and a PENDING binding on it must not be
    // decidable. The binding row itself is preserved untouched.
    if (!record.utilitySpaceId || record.utilityMeterPurpose !== 'TENANT') {
      return allowed;
    }
    const target = await resolveRequest(record.requestType, requestId(record));
    if (target.status !== 'OPEN') return allowed;
  }
  allowed.add('APPROVE');
  allowed.add('REJECT');
  return allowed;
}

function isPendingUnique(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23505' &&
    candidate.constraint?.startsWith('tenant_approval_') === true &&
    candidate.constraint.endsWith('_pending_unique');
}

export const tenantApprovalService = {
  approveTenantApproval,
  createTenantApproval,
  getTenantApproval,
  getUtilityCalculationApprovalContext,
  listPendingTenantApprovals,
  rejectTenantApproval,
  resolveTenantApprovalAvailableActions,
};
