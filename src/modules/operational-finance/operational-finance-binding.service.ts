import { basicExpenseRepository } from '../basic-expenses';
import { inventoryWorkOrderMaterialUsageRepository } from '../inventory-work-order-material-usages';
import {
  purchaseOrderLineRepository,
  purchaseOrderRepository,
  type PurchaseOrderRecord,
} from '../purchase-orders';
import { vendorInvoiceRepository } from '../vendor-invoices';
import {
  vendorServiceCostRepository,
  type VendorServiceCostRecord,
} from '../vendor-service-costs';
import { contextAccessService } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import {
  operationalBudgetNotFoundError,
  operationalBudgetSourceAlreadyBoundError,
  operationalBudgetSourceBindingBudgetNotOpenError,
  operationalBudgetSourceBindingNotActiveError,
  operationalBudgetSourceBindingNotFoundError,
  operationalBudgetSourceCategoryMismatchError,
  operationalBudgetSourceContextInvalidError,
  operationalBudgetSourceCurrencyMismatchError,
  operationalBudgetSourceLineageAmbiguousError,
  operationalBudgetSourceLineageDuplicateError,
  operationalBudgetSourceNotEligibleError,
  operationalBudgetSourceNotFoundError,
} from './operational-finance.errors';
import { operationalFinanceBindingRepository } from './operational-finance-binding.repository';
import { operationalFinanceRepository } from './operational-finance.repository';
import type {
  CreateOperationalBudgetSourceBindingInput,
  NewOperationalBudgetSourceBinding,
  OperationalBudgetSourceBindingRecord,
  OperationalBudgetSourceReferences,
  OperationalBudgetRecord,
  OperationalFinanceCurrencyStatus,
  OperationalFinanceSourceType,
  PublicOperationalBudgetSourceBinding,
} from './operational-finance.types';

type ResolvedSource = {
  sourceId: string;
  clientId: string;
  buildingId: string;
  currency: string | null;
  vendorWorkId: string | null;
  workOrderId: string | null;
  purchaseOrderId: string | null;
};

function toPublicBinding(
  record: OperationalBudgetSourceBindingRecord,
): PublicOperationalBudgetSourceBinding {
  return {
    ...record,
    removedAt: record.removedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505'
  );
}

function sourceReferences(
  input: CreateOperationalBudgetSourceBindingInput,
): OperationalBudgetSourceReferences {
  return {
    basicExpenseId: input.basicExpenseId,
    vendorServiceCostId: input.vendorServiceCostId,
    vendorInvoiceId: input.vendorInvoiceId,
    purchaseOrderId: input.purchaseOrderId,
    purchaseOrderLineId: input.purchaseOrderLineId,
    workOrderMaterialUsageId: input.workOrderMaterialUsageId,
  };
}

function sourceId(
  sourceType: OperationalFinanceSourceType,
  references: OperationalBudgetSourceReferences,
): string {
  switch (sourceType) {
    case 'BASIC_EXPENSE':
      return references.basicExpenseId!;
    case 'VENDOR_SERVICE_COST':
      return references.vendorServiceCostId!;
    case 'VENDOR_INVOICE':
      return references.vendorInvoiceId!;
    case 'PURCHASE_ORDER':
      return references.purchaseOrderId!;
    case 'PO_LINE':
      return references.purchaseOrderLineId!;
    case 'WORK_ORDER_MATERIAL':
      return references.workOrderMaterialUsageId!;
  }
}

async function resolveSource(
  input: CreateOperationalBudgetSourceBindingInput,
): Promise<ResolvedSource> {
  const id = sourceId(input.sourceType, sourceReferences(input));

  switch (input.sourceType) {
    case 'BASIC_EXPENSE': {
      const source = await basicExpenseRepository.findById(id);
      if (!source) throw operationalBudgetSourceNotFoundError();
      if (source.status !== 'FINALIZED') {
        throw operationalBudgetSourceNotEligibleError(
          'Only a finalized Basic Expense can be bound to Operational Finance.',
        );
      }
      return {
        sourceId: id,
        clientId: source.clientId,
        buildingId: source.buildingId,
        /* CUR-02 PART 05: propagate the persisted snapshot; NULL stays UNKNOWN
           (never inferred or substituted). */
        currency: source.currencyCode,
        vendorWorkId: null,
        workOrderId: null,
        purchaseOrderId: null,
      };
    }
    case 'VENDOR_SERVICE_COST': {
      const source = await vendorServiceCostRepository.findById(id);
      if (!source) throw operationalBudgetSourceNotFoundError();
      if (source.status !== 'FINALIZED') {
        throw operationalBudgetSourceNotEligibleError(
          'Only a finalized Vendor Service Cost can be bound to Operational Finance.',
        );
      }
      return vendorServiceCostSource(source);
    }
    case 'VENDOR_INVOICE': {
      const source = await vendorInvoiceRepository.findById(id);
      if (!source) throw operationalBudgetSourceNotFoundError();
      if (source.status !== 'FINALIZED' || source.verificationStatus !== 'VERIFIED') {
        throw operationalBudgetSourceNotEligibleError(
          'Only a finalized and verified Vendor Invoice can be bound to Operational Finance.',
        );
      }
      return {
        sourceId: id,
        clientId: source.clientId,
        buildingId: source.buildingId,
        currency: source.currency,
        vendorWorkId: source.vendorWorkId,
        workOrderId: source.workOrderId,
        purchaseOrderId: source.purchaseOrderId,
      };
    }
    case 'PURCHASE_ORDER': {
      const source = await purchaseOrderRepository.findById(id);
      if (!source) throw operationalBudgetSourceNotFoundError();
      if (source.status !== 'ISSUED') {
        throw operationalBudgetSourceNotEligibleError(
          'Only an issued Purchase Order can be bound to Operational Finance.',
        );
      }
      const lines = await purchaseOrderLineRepository.listByPurchaseOrder(source.id);
      if (lines.length !== 1) {
        throw operationalBudgetSourceLineageAmbiguousError();
      }
      return purchaseOrderSource(source);
    }
    case 'PO_LINE': {
      const source = await purchaseOrderLineRepository.findById(id);
      if (!source) throw operationalBudgetSourceNotFoundError();
      const purchaseOrder = await purchaseOrderRepository.findById(source.purchaseOrderId);
      if (!purchaseOrder) throw operationalBudgetSourceContextInvalidError();
      if (purchaseOrder.status !== 'ISSUED') {
        throw operationalBudgetSourceNotEligibleError(
          'A Purchase Order line can only be bound after its Purchase Order is issued.',
        );
      }
      if (
        source.clientId !== purchaseOrder.clientId ||
        source.buildingId !== purchaseOrder.buildingId
      ) {
        throw operationalBudgetSourceContextInvalidError();
      }
      return {
        sourceId: id,
        clientId: source.clientId,
        buildingId: source.buildingId,
        currency: purchaseOrder.currency,
        vendorWorkId: null,
        workOrderId: null,
        purchaseOrderId: purchaseOrder.id,
      };
    }
    case 'WORK_ORDER_MATERIAL': {
      const source = await inventoryWorkOrderMaterialUsageRepository.findById(id);
      if (!source) throw operationalBudgetSourceNotFoundError();
      if (source.totalCost === null) {
        throw operationalBudgetSourceNotEligibleError(
          'Only a costed Work Order Material Usage can be bound to Operational Finance.',
        );
      }
      return {
        sourceId: id,
        clientId: source.clientId,
        buildingId: source.buildingId,
        currency: source.currency,
        vendorWorkId: null,
        workOrderId: source.workOrderId,
        purchaseOrderId: null,
      };
    }
  }
}

function vendorServiceCostSource(source: VendorServiceCostRecord): ResolvedSource {
  return {
    sourceId: source.id,
    clientId: source.clientId,
    buildingId: source.buildingId,
    /* CUR-02 PART 05: propagate the persisted snapshot; NULL stays UNKNOWN
       (never inferred or substituted). */
    currency: source.currencyCode,
    vendorWorkId: source.vendorWorkId,
    workOrderId: source.workOrderId,
    purchaseOrderId: null,
  };
}

function purchaseOrderSource(source: PurchaseOrderRecord): ResolvedSource {
  return {
    sourceId: source.id,
    clientId: source.clientId,
    buildingId: source.buildingId,
    currency: source.currency,
    vendorWorkId: null,
    workOrderId: null,
    purchaseOrderId: source.id,
  };
}

function currencyStatus(
  sourceCurrency: string | null,
  budget: OperationalBudgetRecord,
): OperationalFinanceCurrencyStatus {
  if (sourceCurrency === null) return 'MISSING';
  if (sourceCurrency !== budget.currency) {
    throw operationalBudgetSourceCurrencyMismatchError();
  }
  return 'MATCHED';
}

async function assertLineageAvailable(
  sourceType: OperationalFinanceSourceType,
  resolved: ResolvedSource,
  references: OperationalBudgetSourceReferences,
): Promise<void> {
  const exact = await operationalFinanceBindingRepository.findActiveBySource(
    sourceType,
    resolved.sourceId,
  );
  if (exact) throw operationalBudgetSourceAlreadyBoundError();

  if (sourceType === 'BASIC_EXPENSE' && references.basicExpenseId) {
    const source = await basicExpenseRepository.findById(references.basicExpenseId);
    if (source?.vendorServiceCostId) {
      const counterparts =
        await operationalFinanceBindingRepository.findActiveBySource(
          'VENDOR_SERVICE_COST',
          source.vendorServiceCostId,
        );
      if (counterparts) throw operationalBudgetSourceLineageDuplicateError();
    }
  }

  if (sourceType === 'VENDOR_SERVICE_COST' && references.vendorServiceCostId) {
    const counterparts =
      await operationalFinanceBindingRepository.findActiveBasicExpenseForVendorServiceCost(
        references.vendorServiceCostId,
      );
    if (counterparts.length > 0) throw operationalBudgetSourceLineageDuplicateError();
  }

  if (sourceType === 'PURCHASE_ORDER' && resolved.purchaseOrderId) {
    const conflicts =
      await operationalFinanceBindingRepository.findActiveByPurchaseOrder(
        resolved.purchaseOrderId,
      );
    if (conflicts.length > 0) throw operationalBudgetSourceLineageAmbiguousError();
  }

  if (sourceType === 'PO_LINE' && resolved.purchaseOrderId) {
    const conflicts =
      await operationalFinanceBindingRepository.findActiveByPurchaseOrder(
        resolved.purchaseOrderId,
      );
    if (conflicts.length > 0) throw operationalBudgetSourceLineageAmbiguousError();
  }

  if (
    (sourceType === 'VENDOR_SERVICE_COST' || sourceType === 'VENDOR_INVOICE') &&
    (resolved.vendorWorkId || resolved.workOrderId)
  ) {
    const conflicts =
      await operationalFinanceBindingRepository.findActiveByVendorLineage({
        vendorWorkId: resolved.vendorWorkId,
        workOrderId: resolved.workOrderId,
      });
    if (conflicts.length > 0) throw operationalBudgetSourceLineageAmbiguousError();
  }
}

async function loadAccessibleBudget(
  budgetId: string,
  actorUserId: string,
): Promise<OperationalBudgetRecord> {
  const budget = await operationalFinanceRepository.findBudgetById(budgetId);
  if (!budget) throw operationalBudgetNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, budget.buildingId);
  return budget;
}

async function loadOpenBudget(
  budgetId: string,
  actorUserId: string,
): Promise<OperationalBudgetRecord> {
  const budget = await loadAccessibleBudget(budgetId, actorUserId);
  if (budget.status !== 'DRAFT' && budget.status !== 'ACTIVE') {
    throw operationalBudgetSourceBindingBudgetNotOpenError();
  }
  return budget;
}

export async function createOperationalBudgetSourceBinding(
  budgetId: string,
  input: CreateOperationalBudgetSourceBindingInput,
  actorUserId: string,
): Promise<PublicOperationalBudgetSourceBinding> {
  const budget = await loadOpenBudget(budgetId, actorUserId);
  const category = await operationalFinanceRepository.findCategoryById(
    input.budgetCategoryId,
  );
  if (!category || category.budgetId !== budget.id) {
    throw operationalBudgetSourceCategoryMismatchError();
  }

  const references = sourceReferences(input);
  const resolved = await resolveSource(input);
  if (
    resolved.clientId !== budget.clientId ||
    resolved.buildingId !== budget.buildingId
  ) {
    throw operationalBudgetSourceContextInvalidError();
  }

  await assertLineageAvailable(input.sourceType, resolved, references);
  const binding: NewOperationalBudgetSourceBinding = {
    ...references,
    budgetId: budget.id,
    budgetCategoryId: category.id,
    clientId: budget.clientId,
    buildingId: budget.buildingId,
    sourceType: input.sourceType,
    currencyStatus: currencyStatus(resolved.currency, budget),
    createdByUserId: actorUserId,
  };

  try {
    const record = await operationalFinanceBindingRepository.createBinding(binding);
    await recordOperationalEvent({
      clientId: record.clientId,
      buildingId: record.buildingId,
      eventType: 'OPERATIONAL_BUDGET_SOURCE_BOUND',
      entityType: 'OPERATIONAL_BUDGET_SOURCE_BINDING',
      entityId: record.id,
      actorUserId,
      summary: 'Authoritative operational cost source bound to a budget category.',
      metadata: {
        budgetId: record.budgetId,
        budgetCategoryId: record.budgetCategoryId,
        sourceType: record.sourceType,
        currencyStatus: record.currencyStatus,
      },
    });
    return toPublicBinding(record);
  } catch (error) {
    if (isUniqueViolation(error)) throw operationalBudgetSourceAlreadyBoundError();
    throw error;
  }
}

export async function getOperationalBudgetSourceBinding(
  bindingId: string,
  actorUserId: string,
): Promise<PublicOperationalBudgetSourceBinding> {
  const binding = await operationalFinanceBindingRepository.findById(bindingId);
  if (!binding) throw operationalBudgetSourceBindingNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, binding.buildingId);
  return toPublicBinding(binding);
}

export async function listOperationalBudgetSourceBindings(
  budgetId: string,
  actorUserId: string,
): Promise<PublicOperationalBudgetSourceBinding[]> {
  await loadAccessibleBudget(budgetId, actorUserId);
  return (await operationalFinanceBindingRepository.listByBudget(budgetId)).map(
    toPublicBinding,
  );
}

export async function removeOperationalBudgetSourceBinding(
  bindingId: string,
  actorUserId: string,
): Promise<PublicOperationalBudgetSourceBinding> {
  const binding = await operationalFinanceBindingRepository.findById(bindingId);
  if (!binding) throw operationalBudgetSourceBindingNotFoundError();
  await loadOpenBudget(binding.budgetId, actorUserId);
  if (binding.status !== 'ACTIVE') {
    throw operationalBudgetSourceBindingNotActiveError();
  }
  const removed = await operationalFinanceBindingRepository.removeBinding(
    bindingId,
    actorUserId,
  );
  if (!removed) throw operationalBudgetSourceBindingNotActiveError();
  await recordOperationalEvent({
    clientId: removed.clientId,
    buildingId: removed.buildingId,
    eventType: 'OPERATIONAL_BUDGET_SOURCE_UNBOUND',
    entityType: 'OPERATIONAL_BUDGET_SOURCE_BINDING',
    entityId: removed.id,
    actorUserId,
    summary: 'Operational Finance source binding removed from active control.',
    metadata: {
      budgetId: removed.budgetId,
      budgetCategoryId: removed.budgetCategoryId,
      sourceType: removed.sourceType,
    },
  });
  return toPublicBinding(removed);
}

export const operationalFinanceBindingService = {
  createOperationalBudgetSourceBinding,
  getOperationalBudgetSourceBinding,
  listOperationalBudgetSourceBindings,
  removeOperationalBudgetSourceBinding,
};
