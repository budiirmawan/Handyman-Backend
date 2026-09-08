import { AppError } from '../../shared/errors';
import { assertActiveAllowedCurrencyCommand } from '../client-monetary-contexts';
import { buildingAccessDeniedError, contextAccessService } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { tenantBuildingContextRepository } from '../tenant-building-contexts';
import { tenantCompanyNotFoundError, tenantCompanyRepository } from '../tenant-companies';
import { tenantSpaceRepository } from '../tenant-spaces';
import {
  tenantChargeContextInvalidError,
  tenantChargeCurrencyImmutableError,
  tenantChargeCurrencyRequiredError,
  tenantChargeNotActiveError,
  tenantChargeNotFoundError,
  tenantChargeSpaceMismatchError,
} from './tenant-charge.errors';
import { tenantChargeRepository } from './tenant-charge.repository';
import type {
  CreateTenantChargeInput,
  NewTenantCharge,
  PublicTenantCharge,
  TenantChargeFilters,
  TenantChargeRecord,
  UpdateTenantChargeInput,
} from './tenant-charge.types';

function toPublic(record: TenantChargeRecord): PublicTenantCharge {
  return {
    ...record,
    amount: Number(record.amount),
    cancelledAt: record.cancelledAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

async function assertChargeContext(
  tenantCompanyId: string,
  buildingId: string,
  spaceId: string,
  actorUserId: string,
): Promise<{ clientId: string }> {
  const company = await tenantCompanyRepository.findById(tenantCompanyId);
  if (!company) throw tenantCompanyNotFoundError();
  if (!(await contextAccessService.canAccessClient(actorUserId, company.clientId))) {
    throw buildingAccessDeniedError();
  }
  await contextAccessService.assertBuildingAccess(actorUserId, buildingId);
  if (company.status !== 'ACTIVE') throw tenantChargeContextInvalidError();
  const buildingContext = await tenantBuildingContextRepository.findActive(
    tenantCompanyId,
    buildingId,
  );
  if (!buildingContext) throw tenantChargeContextInvalidError();
  const spaceContext = await tenantSpaceRepository.findActiveByTenantBuildingAndSpace(
    tenantCompanyId,
    buildingId,
    spaceId,
  );
  if (!spaceContext) throw tenantChargeSpaceMismatchError();
  return { clientId: company.clientId };
}

async function loadAccessible(id: string, actorUserId: string): Promise<TenantChargeRecord> {
  const record = await tenantChargeRepository.findById(id);
  if (!record) throw tenantChargeNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, record.buildingId);
  return record;
}

function assertDateOrder(chargeDate: string, dueDate: string | null): void {
  if (dueDate && dueDate < chargeDate) {
    throw AppError.validation('Request validation failed.', [
      { field: 'dueDate', message: 'dueDate must be the same as or after chargeDate.' },
    ]);
  }
}

export async function createTenantCharge(
  input: CreateTenantChargeInput,
  actorUserId: string,
): Promise<PublicTenantCharge> {
  const { clientId } = await assertChargeContext(
    input.tenantCompanyId,
    input.buildingId,
    input.spaceId,
    actorUserId,
  );
  const dueDate = input.dueDate ?? null;
  assertDateOrder(input.chargeDate, dueDate);
  await assertActiveAllowedCurrencyCommand(clientId, input.currencyCode);
  const payload: NewTenantCharge = {
    ...input,
    clientId,
    dueDate,
    reference: input.reference ?? null,
    notes: input.notes ?? null,
    createdByUserId: actorUserId,
  };
  const record = await tenantChargeRepository.create(payload);
  await recordOperationalEvent({
    clientId,
    buildingId: record.buildingId,
    eventType: 'TENANT_CHARGE_CREATED',
    entityType: 'TENANT_CHARGE',
    entityId: record.id,
    actorUserId,
    summary: `Tenant charge ${record.chargeType} created.`,
    metadata: { tenantCompanyId: record.tenantCompanyId, spaceId: record.spaceId, amount: record.amount, currencyCode: record.currencyCode },
  });
  return toPublic(record);
}

export async function getTenantCharge(
  id: string,
  actorUserId: string,
): Promise<PublicTenantCharge> {
  return toPublic(await loadAccessible(id, actorUserId));
}

export async function listTenantCharges(
  filters: TenantChargeFilters,
  actorUserId: string,
): Promise<PublicTenantCharge[]> {
  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(actorUserId, filters.buildingId);
  }
  const buildingIds = await contextAccessService.getAccessibleBuildingIds(actorUserId);
  return (await tenantChargeRepository.list(filters, buildingIds)).map(toPublic);
}

export async function updateTenantCharge(
  id: string,
  input: UpdateTenantChargeInput,
  actorUserId: string,
): Promise<PublicTenantCharge> {
  const current = await loadAccessible(id, actorUserId);
  if (current.status !== 'ACTIVE') throw tenantChargeNotActiveError();
  const chargeDate = input.chargeDate ?? current.chargeDate;
  const dueDate = input.dueDate === undefined ? current.dueDate : input.dueDate;
  assertDateOrder(chargeDate, dueDate);
  /* CUR-02 PART 02: a legacy NULL-currency charge keeps NULL unless the amount
     changes (which requires an explicit governed currency); a record that
     already carries a governed snapshot is currency-immutable. */
  if (current.currencyCode === null) {
    if (input.amount !== undefined && input.currencyCode === undefined) {
      throw tenantChargeCurrencyRequiredError();
    }
    if (input.currencyCode !== undefined) {
      await assertActiveAllowedCurrencyCommand(current.clientId, input.currencyCode);
    }
  } else if (input.currencyCode !== undefined && input.currencyCode !== current.currencyCode) {
    throw tenantChargeCurrencyImmutableError();
  }
  const record = await tenantChargeRepository.update(id, input, actorUserId);
  if (!record) throw tenantChargeNotActiveError();
  await recordOperationalEvent({
    clientId: record.clientId,
    buildingId: record.buildingId,
    eventType: 'TENANT_CHARGE_UPDATED',
    entityType: 'TENANT_CHARGE',
    entityId: record.id,
    actorUserId,
    summary: 'Tenant charge updated.',
    metadata: { changedFields: Object.keys(input), currencyCode: record.currencyCode },
  });
  return toPublic(record);
}

export async function cancelTenantCharge(
  id: string,
  cancellationNote: string | null,
  actorUserId: string,
): Promise<PublicTenantCharge> {
  const current = await loadAccessible(id, actorUserId);
  if (current.status !== 'ACTIVE') throw tenantChargeNotActiveError();
  const record = await tenantChargeRepository.cancel(id, actorUserId, cancellationNote);
  if (!record) throw tenantChargeNotActiveError();
  await recordOperationalEvent({
    clientId: record.clientId,
    buildingId: record.buildingId,
    eventType: 'TENANT_CHARGE_CANCELLED',
    entityType: 'TENANT_CHARGE',
    entityId: record.id,
    actorUserId,
    summary: 'Tenant charge cancelled.',
    metadata: { cancellationNote },
  });
  return toPublic(record);
}

export const tenantChargeService = {
  cancelTenantCharge,
  createTenantCharge,
  getTenantCharge,
  listTenantCharges,
  updateTenantCharge,
};
