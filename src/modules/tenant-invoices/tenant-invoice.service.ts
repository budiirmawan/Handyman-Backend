import { AppError } from '../../shared/errors';
import { assertActiveAllowedCurrencyCommand } from '../client-monetary-contexts';
import { buildingAccessDeniedError, contextAccessService } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { tenantBuildingContextRepository } from '../tenant-building-contexts';
import { tenantChargeRepository } from '../tenant-charges';
import { tenantCompanyNotFoundError, tenantCompanyRepository } from '../tenant-companies';
import { tenantSpaceRepository } from '../tenant-spaces';
import { utilityBillRepository } from '../utility-bills';
import { utilityMeterTenantRepository } from '../utility-meter-tenants';
import {
  tenantInvoiceCancelNotAllowedError, tenantInvoiceContextInvalidError,
  tenantInvoiceCurrencyImmutableError, tenantInvoiceCurrencyMismatchError,
  tenantInvoiceCurrencyRequiredError, tenantInvoiceFinalizedProtectedError,
  tenantInvoiceNoLinesError, tenantInvoiceNotDraftError,
  tenantInvoiceNotFoundError, tenantInvoiceNumberExistsError,
  tenantInvoiceSourceCurrencyUnknownError, tenantInvoiceSourceDuplicateError,
  tenantInvoiceSourceInvalidError,
} from './tenant-invoice.errors';
import { tenantInvoiceRepository } from './tenant-invoice.repository';
import type {
  AddTenantInvoiceLineInput, CreateTenantInvoiceInput, NewTenantInvoice,
  NewTenantInvoiceLine, PublicTenantInvoice, PublicTenantInvoiceLine,
  TenantInvoiceFilters, TenantInvoiceLineRecord, TenantInvoiceRecord,
  UpdateTenantInvoiceInput,
} from './tenant-invoice.types';

function publicLine(line: TenantInvoiceLineRecord): PublicTenantInvoiceLine {
  return {
    ...line,
    sourceId: (line.tenantChargeId ?? line.utilityBillId)!,
    amount: Number(line.amountSnapshot),
    createdAt: line.createdAt.toISOString(),
  };
}
async function toPublic(record: TenantInvoiceRecord): Promise<PublicTenantInvoice> {
  const lines = await tenantInvoiceRepository.listLines(record.id);
  return {
    ...record, subtotal: Number(record.subtotal), totalAmount: Number(record.totalAmount),
    finalizedAt: record.finalizedAt?.toISOString() ?? null,
    cancelledAt: record.cancelledAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(), updatedAt: record.updatedAt.toISOString(),
    lines: lines.map(publicLine),
  };
}
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}
function assertDates(invoiceDate: string, dueDate: string): void {
  if (dueDate < invoiceDate) throw AppError.validation('Request validation failed.', [
    { field: 'dueDate', message: 'dueDate must be the same as or after invoiceDate.' },
  ]);
}
async function assertContext(tenantId: string, buildingId: string, spaceId: string, actor: string): Promise<string> {
  const company = await tenantCompanyRepository.findById(tenantId);
  if (!company) throw tenantCompanyNotFoundError();
  if (!(await contextAccessService.canAccessClient(actor, company.clientId))) throw buildingAccessDeniedError();
  await contextAccessService.assertBuildingAccess(actor, buildingId);
  if (company.status !== 'ACTIVE' || !(await tenantBuildingContextRepository.findActive(tenantId, buildingId))) {
    throw tenantInvoiceContextInvalidError();
  }
  if (!(await tenantSpaceRepository.findActiveByTenantBuildingAndSpace(tenantId, buildingId, spaceId))) {
    throw tenantInvoiceContextInvalidError();
  }
  return company.clientId;
}
async function loadAccessible(id: string, actor: string): Promise<TenantInvoiceRecord> {
  const record = await tenantInvoiceRepository.findById(id);
  if (!record) throw tenantInvoiceNotFoundError();
  await contextAccessService.assertBuildingAccess(actor, record.buildingId);
  return record;
}
async function resolveEligibleSource(
  invoice: TenantInvoiceRecord,
  input: AddTenantInvoiceLineInput,
  allowExisting = false,
): Promise<NewTenantInvoiceLine> {
  if (!allowExisting && await tenantInvoiceRepository.findLineBySource(input.sourceType, input.sourceId)) {
    throw tenantInvoiceSourceDuplicateError();
  }
  /* CUR-02 PART 02: an Invoice must have one exact governed header currency,
     and every source currency must be known and exactly equal it. Unknown or
     mixed source currency fails closed; no substitution, conversion, or Client
     default inference is ever applied. */
  if (invoice.currencyCode === null) throw tenantInvoiceCurrencyRequiredError();
  if (input.sourceType === 'TENANT_CHARGE') {
    const charge = await tenantChargeRepository.findById(input.sourceId);
    if (!charge || charge.tenantCompanyId !== invoice.tenantCompanyId ||
        charge.buildingId !== invoice.buildingId || charge.spaceId !== invoice.spaceId ||
        charge.status !== 'ACTIVE' || charge.chargeDate > invoice.invoiceDate) {
      throw tenantInvoiceSourceInvalidError();
    }
    const readiness = await tenantInvoiceRepository.serviceReadinessForCharge(charge.id);
    if (readiness === false) throw tenantInvoiceSourceInvalidError();
    if (charge.currencyCode === null) throw tenantInvoiceSourceCurrencyUnknownError();
    if (charge.currencyCode !== invoice.currencyCode) throw tenantInvoiceCurrencyMismatchError();
    return {
      invoiceId: invoice.id, sourceType: input.sourceType,
      tenantChargeId: charge.id, utilityBillId: null, amountSnapshot: charge.amount,
      currencyCode: charge.currencyCode,
    };
  }
  const bill = await utilityBillRepository.findById(input.sourceId);
  if (!bill || bill.tenantCompanyId !== invoice.tenantCompanyId ||
      bill.buildingId !== invoice.buildingId || bill.status !== 'ISSUED') {
    throw tenantInvoiceSourceInvalidError();
  }
  const assignment = await utilityMeterTenantRepository.findById(bill.tenantAssignmentId);
  if (!assignment || assignment.spaceId !== invoice.spaceId ||
      assignment.tenantCompanyId !== invoice.tenantCompanyId ||
      assignment.buildingId !== invoice.buildingId) {
    throw tenantInvoiceSourceInvalidError();
  }
  if (bill.currency === null) throw tenantInvoiceSourceCurrencyUnknownError();
  if (bill.currency !== invoice.currencyCode) throw tenantInvoiceCurrencyMismatchError();
  return {
    invoiceId: invoice.id, sourceType: input.sourceType,
    tenantChargeId: null, utilityBillId: bill.id, amountSnapshot: bill.billAmount,
    currencyCode: bill.currency,
  };
}

export async function createTenantInvoice(input: CreateTenantInvoiceInput, actor: string): Promise<PublicTenantInvoice> {
  const clientId = await assertContext(input.tenantCompanyId, input.buildingId, input.spaceId, actor);
  assertDates(input.invoiceDate, input.dueDate);
  await assertActiveAllowedCurrencyCommand(clientId, input.currencyCode);
  const payload: NewTenantInvoice = { ...input, clientId, notes: input.notes?.trim() || null, createdByUserId: actor };
  try {
    const record = await tenantInvoiceRepository.create(payload);
    await recordOperationalEvent({ clientId, buildingId: record.buildingId,
      eventType: 'TENANT_INVOICE_CREATED', entityType: 'TENANT_INVOICE', entityId: record.id,
      actorUserId: actor, summary: `Tenant Invoice ${record.invoiceNumber} created as draft.`,
      metadata: { tenantCompanyId: record.tenantCompanyId, spaceId: record.spaceId, currencyCode: record.currencyCode } });
    return toPublic(record);
  } catch (error) {
    if (isUniqueViolation(error)) throw tenantInvoiceNumberExistsError();
    throw error;
  }
}
export async function addTenantInvoiceLine(id: string, input: AddTenantInvoiceLineInput, actor: string): Promise<PublicTenantInvoice> {
  const invoice = await loadAccessible(id, actor);
  if (invoice.status === 'FINALIZED') throw tenantInvoiceFinalizedProtectedError();
  if (invoice.status !== 'DRAFT') throw tenantInvoiceNotDraftError();
  const line = await resolveEligibleSource(invoice, input);
  try {
    const updated = await tenantInvoiceRepository.addLine(line, actor);
    if (!updated) throw tenantInvoiceNotDraftError();
    await recordOperationalEvent({ clientId: updated.clientId, buildingId: updated.buildingId,
      eventType: 'TENANT_INVOICE_SOURCE_LINKED', entityType: 'TENANT_INVOICE', entityId: updated.id,
      actorUserId: actor, summary: `${input.sourceType} linked to Tenant Invoice.`,
      metadata: { sourceType: input.sourceType, sourceId: input.sourceId, currencyCode: line.currencyCode } });
    return toPublic(updated);
  } catch (error) {
    if (isUniqueViolation(error)) throw tenantInvoiceSourceDuplicateError();
    throw error;
  }
}
export async function getTenantInvoice(id: string, actor: string): Promise<PublicTenantInvoice> {
  return toPublic(await loadAccessible(id, actor));
}
export async function listTenantInvoices(filters: TenantInvoiceFilters, actor: string): Promise<PublicTenantInvoice[]> {
  if (filters.buildingId) await contextAccessService.assertBuildingAccess(actor, filters.buildingId);
  const ids = await contextAccessService.getAccessibleBuildingIds(actor);
  return Promise.all((await tenantInvoiceRepository.list(filters, ids)).map(toPublic));
}
export async function updateTenantInvoice(id: string, input: UpdateTenantInvoiceInput, actor: string): Promise<PublicTenantInvoice> {
  const current = await loadAccessible(id, actor);
  if (current.status === 'FINALIZED') throw tenantInvoiceFinalizedProtectedError();
  if (current.status !== 'DRAFT') throw tenantInvoiceNotDraftError();
  assertDates(input.invoiceDate ?? current.invoiceDate, input.dueDate ?? current.dueDate);
  /* CUR-02 PART 02: a legacy NULL-currency draft may be governed before lines
     are added; an existing governed header currency is immutable. */
  if (current.currencyCode === null) {
    if (input.currencyCode !== undefined) {
      await assertActiveAllowedCurrencyCommand(current.clientId, input.currencyCode);
    }
  } else if (input.currencyCode !== undefined && input.currencyCode !== current.currencyCode) {
    throw tenantInvoiceCurrencyImmutableError();
  }
  const updated = await tenantInvoiceRepository.update(id, input, actor);
  if (!updated) throw tenantInvoiceNotDraftError();
  return toPublic(updated);
}
export async function finalizeTenantInvoice(id: string, actor: string): Promise<PublicTenantInvoice> {
  const current = await loadAccessible(id, actor);
  if (current.status === 'FINALIZED') throw tenantInvoiceFinalizedProtectedError();
  if (current.status !== 'DRAFT') throw tenantInvoiceNotDraftError();
  const lines = await tenantInvoiceRepository.listLines(id);
  if (lines.length === 0) throw tenantInvoiceNoLinesError();
  /* CUR-02 PART 02 finalize guard: a single known currency across header and
     every line before the persisted totals are recalculated. Rejects mixed
     (e.g. IDR + USD), known + UNKNOWN, and an unknown header. */
  if (current.currencyCode === null) throw tenantInvoiceCurrencyRequiredError();
  for (const line of lines) {
    if (line.currencyCode === null) throw tenantInvoiceSourceCurrencyUnknownError();
    if (line.currencyCode !== current.currencyCode) throw tenantInvoiceCurrencyMismatchError();
  }
  for (const line of lines) {
    await resolveEligibleSource(current, {
      sourceType: line.sourceType,
      sourceId: (line.tenantChargeId ?? line.utilityBillId)!,
    }, true);
  }
  const finalized = await tenantInvoiceRepository.finalize(id, actor);
  if (!finalized) throw tenantInvoiceFinalizedProtectedError();
  await recordOperationalEvent({ clientId: finalized.clientId, buildingId: finalized.buildingId,
    eventType: 'TENANT_INVOICE_FINALIZED', entityType: 'TENANT_INVOICE', entityId: finalized.id,
    actorUserId: actor, summary: `Tenant Invoice ${finalized.invoiceNumber} finalized.`,
    metadata: { subtotal: finalized.subtotal, totalAmount: finalized.totalAmount, currencyCode: finalized.currencyCode } });
  return toPublic(finalized);
}
export async function cancelTenantInvoice(id: string, actor: string): Promise<PublicTenantInvoice> {
  const current = await loadAccessible(id, actor);
  if (current.status === 'CANCELLED') throw tenantInvoiceCancelNotAllowedError();
  const cancelled = await tenantInvoiceRepository.cancel(id, actor);
  if (!cancelled) throw tenantInvoiceCancelNotAllowedError();
  await recordOperationalEvent({ clientId: cancelled.clientId, buildingId: cancelled.buildingId,
    eventType: 'TENANT_INVOICE_CANCELLED', entityType: 'TENANT_INVOICE', entityId: cancelled.id,
    actorUserId: actor, summary: `Tenant Invoice ${cancelled.invoiceNumber} cancelled.` });
  return toPublic(cancelled);
}
export const tenantInvoiceService = {
  addTenantInvoiceLine, cancelTenantInvoice, createTenantInvoice,
  finalizeTenantInvoice, getTenantInvoice, listTenantInvoices, updateTenantInvoice,
};
