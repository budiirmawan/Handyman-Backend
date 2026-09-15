import { AppError } from '../../shared/errors';
import { buildingAccessDeniedError, contextAccessService } from '../context-access';
import { tenantApprovalRepository } from '../tenant-approvals/tenant-approval.repository';
import { recordOperationalEvent } from '../operational-events';
import { tenantCompanyNotFoundError, tenantCompanyRepository } from '../tenant-companies';
import {
  utilityCalculationNotFoundError,
  utilityCalculationRepository,
} from '../utility-calculations';
import {
  utilityBillApprovalRejectedError,
  utilityBillApprovalRequiredError,
  utilityBillCalculationInvalidError,
  utilityBillContextInvalidError,
  utilityBillMeterNotTenantError,
  utilityBillDuplicateError,
  utilityBillNotFoundError,
  utilityBillStatusTransitionInvalidError,
  utilityBillUpdateNotAllowedError,
} from './utility-bill.errors';
import { utilityBillRepository } from './utility-bill.repository';
import {
  isUtilityBillType,
  type GenerateUtilityBillInput,
  type NewUtilityBill,
  type PublicUtilityBill,
  type UtilityBillFilters,
  type UtilityBillInvoiceReady,
  type UtilityBillRecord,
  type UtilityBillStatus,
  type UpdateUtilityBillInput,
} from './utility-bill.types';

function toPublic(record: UtilityBillRecord): PublicUtilityBill {
  return {
    ...record,
    calculatedUtilityValue: Number(record.calculatedUtilityValue),
    billAmount: Number(record.billAmount),
    consumptionQuantity: record.consumptionQuantity === null
      ? null : Number(record.consumptionQuantity),
    tariffRate: record.tariffRate === null ? null : Number(record.tariffRate),
    periodStart: record.periodStart.toISOString(),
    periodEnd: record.periodEnd.toISOString(),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}
function assertDueDate(dueDate: string, periodEnd: Date): void {
  const periodEndDate = periodEnd.toISOString().slice(0, 10);
  if (dueDate < periodEndDate) {
    throw AppError.validation('Request validation failed.', [
      { field: 'dueDate', message: 'dueDate must be the same as or after the billing period end date.' },
    ]);
  }
}
async function loadAccessible(id: string, actorUserId: string): Promise<UtilityBillRecord> {
  const record = await utilityBillRepository.findById(id);
  if (!record) throw utilityBillNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, record.buildingId);
  return record;
}

export async function generateUtilityBill(
  input: GenerateUtilityBillInput,
  actorUserId: string,
): Promise<PublicUtilityBill> {
  const calculation = await utilityCalculationRepository.findById(input.calculationId);
  if (!calculation) throw utilityCalculationNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, calculation.buildingId);
  if (
    calculation.status !== 'FINALIZED' ||
    !isUtilityBillType(calculation.utilityType) ||
    !calculation.tenantCompanyId ||
    !calculation.tenantAssignmentId
  ) {
    throw utilityBillCalculationInvalidError();
  }
  if (calculation.tenantCompanyId !== input.tenantCompanyId) {
    throw utilityBillContextInvalidError();
  }

  const company = await tenantCompanyRepository.findById(input.tenantCompanyId);
  if (!company) throw tenantCompanyNotFoundError();
  if (!(await contextAccessService.canAccessClient(actorUserId, company.clientId))) {
    throw buildingAccessDeniedError();
  }

  const approval = await tenantApprovalRepository.findLatestByUtilityCalculation(
    calculation.id,
  );
  if (!approval || approval.status === 'PENDING') {
    throw utilityBillApprovalRequiredError();
  }
  if (approval.status === 'REJECTED') {
    throw utilityBillApprovalRejectedError();
  }
  if (approval.utilityMeterPurpose !== 'TENANT') {
    throw utilityBillMeterNotTenantError();
  }
  if (
    approval.utilitySnapshotVersion !== 1 ||
    approval.tenantCompanyId !== input.tenantCompanyId ||
    approval.clientId !== calculation.clientId ||
    approval.buildingId !== calculation.buildingId ||
    approval.utilityMeterId !== calculation.meterId ||
    approval.utilityType !== calculation.utilityType ||
    approval.utilityPeriodStart?.getTime() !== calculation.periodStart.getTime() ||
    approval.utilityPeriodEnd?.getTime() !== calculation.periodEnd.getTime() ||
    approval.utilityConsumptionQuantity !== calculation.consumptionQuantity ||
    approval.utilityUomId !== calculation.uomId ||
    approval.utilityTariffId !== calculation.tariffId ||
    approval.utilityTariffRate !== calculation.tariffRate ||
    approval.utilityCalculatedAmount !== calculation.calculatedAmount ||
    approval.utilityCurrency !== calculation.currency ||
    !approval.utilitySpaceId || !calculation.tariffId ||
    calculation.tariffRate === null || !calculation.currency
  ) {
    throw utilityBillContextInvalidError();
  }
  assertDueDate(input.dueDate, calculation.periodEnd);
  if (await utilityBillRepository.findByContextPeriod({
    tenantCompanyId: input.tenantCompanyId,
    meterId: calculation.meterId,
    periodStart: calculation.periodStart,
    periodEnd: calculation.periodEnd,
  })) {
    throw utilityBillDuplicateError();
  }

  const payload: NewUtilityBill = {
    clientId: calculation.clientId,
    tenantCompanyId: input.tenantCompanyId,
    buildingId: calculation.buildingId,
    meterId: calculation.meterId,
    tenantAssignmentId: calculation.tenantAssignmentId,
    calculationId: calculation.id,
    approvalId: approval.id,
    spaceId: approval.utilitySpaceId,
    consumptionQuantity: approval.utilityConsumptionQuantity!,
    uomId: approval.utilityUomId!,
    tariffRate: approval.utilityTariffRate!,
    currency: approval.utilityCurrency!,
    utilityType: calculation.utilityType,
    periodStart: calculation.periodStart,
    periodEnd: calculation.periodEnd,
    billAmount: calculation.calculatedAmount,
    dueDate: input.dueDate,
    generatedByUserId: actorUserId,
  };
  try {
    const record = await utilityBillRepository.create(payload);
    await recordOperationalEvent({
      clientId: record.clientId,
      buildingId: record.buildingId,
      eventType: 'UTILITY_BILL_CREATED',
      entityType: 'UTILITY_BILL',
      entityId: record.id,
      actorUserId,
      summary: `${record.utilityType} Utility bill generated from finalized BE-18 calculation.`,
      metadata: { calculationId: record.calculationId, consumptionId: record.consumptionId,
        tenantCompanyId: record.tenantCompanyId, meterId: record.meterId },
    });
    return toPublic(record);
  } catch (error) {
    if (isUniqueViolation(error)) throw utilityBillDuplicateError();
    throw error;
  }
}

export async function getUtilityBill(id: string, actorUserId: string): Promise<PublicUtilityBill> {
  return toPublic(await loadAccessible(id, actorUserId));
}
export async function getUtilityBillInvoiceReady(
  id: string,
  actorUserId: string,
): Promise<UtilityBillInvoiceReady> {
  const bill = await loadAccessible(id, actorUserId);
  if (
    bill.status === 'CANCELLED' || bill.consumptionQuantity === null ||
    bill.uomId === null || bill.tariffRate === null || bill.currency === null
  ) {
    throw utilityBillUpdateNotAllowedError();
  }
  return {
    tenantCompanyId: bill.tenantCompanyId,
    billingPeriod: {
      start: bill.periodStart.toISOString(),
      end: bill.periodEnd.toISOString(),
    },
    chargeDescription: `${bill.utilityType} utility charge`,
    utilityType: bill.utilityType,
    quantity: Number(bill.consumptionQuantity),
    uomId: bill.uomId,
    unitRate: Number(bill.tariffRate),
    amount: Number(bill.billAmount),
    currency: bill.currency,
    utilityBillId: bill.id,
    sourceCalculationId: bill.calculationId,
  };
}

export async function listUtilityBills(
  filters: UtilityBillFilters,
  actorUserId: string,
): Promise<PublicUtilityBill[]> {
  if (filters.buildingId) await contextAccessService.assertBuildingAccess(actorUserId, filters.buildingId);
  const buildingIds = await contextAccessService.getAccessibleBuildingIds(actorUserId);
  return (await utilityBillRepository.list(filters, buildingIds)).map(toPublic);
}

const TRANSITIONS: Readonly<Record<UtilityBillStatus, readonly UtilityBillStatus[]>> = {
  DRAFT: ['ISSUED', 'CANCELLED'],
  ISSUED: ['CANCELLED'],
  CANCELLED: [],
};
export async function updateUtilityBill(
  id: string,
  input: UpdateUtilityBillInput,
  actorUserId: string,
): Promise<PublicUtilityBill> {
  const current = await loadAccessible(id, actorUserId);
  if (input.dueDate !== undefined) {
    if (current.status !== 'DRAFT') throw utilityBillUpdateNotAllowedError();
    assertDueDate(input.dueDate, current.periodEnd);
  }
  if (input.status !== undefined && !TRANSITIONS[current.status].includes(input.status)) {
    throw utilityBillStatusTransitionInvalidError();
  }
  if (input.status === 'ISSUED') {
    if (!current.approvalId) throw utilityBillApprovalRequiredError();
    const approval = await tenantApprovalRepository.findById(current.approvalId);
    if (!approval || approval.status !== 'APPROVED' ||
        approval.utilityCalculationId !== current.calculationId) {
      throw utilityBillApprovalRequiredError();
    }
  }
  const record = await utilityBillRepository.update(id, input, current.status, actorUserId);
  if (!record) throw utilityBillUpdateNotAllowedError();
  await recordOperationalEvent({
    clientId: record.clientId,
    buildingId: record.buildingId,
    eventType: 'UTILITY_BILL_UPDATED',
    entityType: 'UTILITY_BILL',
    entityId: record.id,
    actorUserId,
    summary: 'Utility bill due date or lifecycle status updated.',
    metadata: { changedFields: Object.keys(input), status: record.status },
  });
  return toPublic(record);
}

export const utilityBillService = {
  generateUtilityBill,
  getUtilityBill,
  getUtilityBillInvoiceReady,
  listUtilityBills,
  updateUtilityBill,
};
