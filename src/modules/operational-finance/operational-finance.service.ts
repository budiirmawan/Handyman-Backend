import {
  buildingNotFoundError,
  buildingRepository,
} from '../buildings';
import { contextAccessService } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { propertyNotFoundError, propertyRepository } from '../properties';
import {
  operationalBudgetCategoryCodeExistsError,
  operationalBudgetCategoryNotFoundError,
  operationalBudgetCategoryNotDraftError,
  operationalBudgetNotDraftError,
  operationalBudgetNotFoundError,
  operationalBudgetPeriodConflictError,
  operationalBudgetTransitionInvalidError,
} from './operational-finance.errors';
import { operationalFinanceRepository } from './operational-finance.repository';
import {
  DEFAULT_OPERATIONAL_BUDGET_OVERSPEND_POLICY,
} from './operational-finance.types';
import type {
  CreateOperationalBudgetCategoryInput,
  CreateOperationalBudgetInput,
  NewOperationalBudget,
  NewOperationalBudgetCategory,
  OperationalBudgetCategoryRecord,
  OperationalBudgetFilters,
  OperationalBudgetRecord,
  OperationalBudgetStatus,
  PublicOperationalBudget,
  PublicOperationalBudgetCategory,
  UpdateOperationalBudgetCategoryInput,
  UpdateOperationalBudgetInput,
} from './operational-finance.types';

function toPublicBudget(record: OperationalBudgetRecord): PublicOperationalBudget {
  return {
    ...record,
    plannedAmount: Number(record.plannedAmount),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function toPublicCategory(
  record: OperationalBudgetCategoryRecord,
): PublicOperationalBudgetCategory {
  return {
    ...record,
    plannedAmount: Number(record.plannedAmount),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function isPeriodConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23P01' &&
    candidate.constraint === 'operational_budgets_live_period_exclusion'
  );
}

function isCategoryCodeConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint === 'operational_budget_categories_budget_code_unique'
  );
}

async function resolveBuildingClient(
  buildingId: string,
  actorUserId: string,
): Promise<string> {
  await contextAccessService.assertBuildingAccess(actorUserId, buildingId);
  const building = await buildingRepository.findById(buildingId);
  if (!building) throw buildingNotFoundError();
  const property = await propertyRepository.findById(building.propertyId);
  if (!property) throw propertyNotFoundError();
  return property.clientId;
}

async function loadBudget(
  budgetId: string,
  actorUserId: string,
): Promise<OperationalBudgetRecord> {
  const budget = await operationalFinanceRepository.findBudgetById(budgetId);
  if (!budget) throw operationalBudgetNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, budget.buildingId);
  return budget;
}

async function loadCategoryBudget(
  categoryId: string,
  actorUserId: string,
): Promise<{
  category: OperationalBudgetCategoryRecord;
  budget: OperationalBudgetRecord;
}> {
  const category = await operationalFinanceRepository.findCategoryById(categoryId);
  if (!category) throw operationalBudgetCategoryNotFoundError();
  const budget = await loadBudget(category.budgetId, actorUserId);
  return { category, budget };
}

export async function createOperationalBudget(
  buildingId: string,
  input: CreateOperationalBudgetInput,
  actorUserId: string,
): Promise<PublicOperationalBudget> {
  const clientId = await resolveBuildingClient(buildingId, actorUserId);
  const newBudget: NewOperationalBudget = {
    budgetName: input.budgetName ?? 'Operational Budget',
    budgetPeriod: input.budgetPeriod,
    currency: input.currency,
    plannedAmount: input.plannedAmount,
    // CR-BE-COMM-VAR-01 PART 01 — overspend control defaults to STRICT so an
    // omitted policy can never widen future commitment authority.
    overspendPolicy:
      input.overspendPolicy ?? DEFAULT_OPERATIONAL_BUDGET_OVERSPEND_POLICY,
    clientId,
    buildingId,
  };

  try {
    const record = await operationalFinanceRepository.createBudget(newBudget);
    await recordOperationalEvent({
      clientId: record.clientId,
      buildingId: record.buildingId,
      eventType: 'OPERATIONAL_BUDGET_CREATED',
      entityType: 'OPERATIONAL_BUDGET',
      entityId: record.id,
      actorUserId,
      summary: 'Operational Budget created as draft.',
      metadata: {
        periodStart: record.budgetPeriod.start,
        periodEnd: record.budgetPeriod.end,
        currency: record.currency,
        plannedAmount: record.plannedAmount,
        overspendPolicy: record.overspendPolicy,
      },
    });
    return toPublicBudget(record);
  } catch (error) {
    if (isPeriodConflict(error)) throw operationalBudgetPeriodConflictError();
    throw error;
  }
}

export async function getOperationalBudget(
  budgetId: string,
  actorUserId: string,
): Promise<PublicOperationalBudget> {
  return toPublicBudget(await loadBudget(budgetId, actorUserId));
}

export async function listOperationalBudgets(
  filters: OperationalBudgetFilters,
  actorUserId: string,
): Promise<PublicOperationalBudget[]> {
  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(actorUserId, filters.buildingId);
  }
  const buildingIds = await contextAccessService.getAccessibleBuildingIds(actorUserId);
  return (
    await operationalFinanceRepository.listBudgets(filters, buildingIds)
  ).map(toPublicBudget);
}

export async function updateOperationalBudget(
  budgetId: string,
  input: UpdateOperationalBudgetInput,
  actorUserId: string,
): Promise<PublicOperationalBudget> {
  const current = await loadBudget(budgetId, actorUserId);
  if (current.status !== 'DRAFT') throw operationalBudgetNotDraftError();

  try {
    const record = await operationalFinanceRepository.updateBudget(budgetId, input);
    if (!record) throw operationalBudgetNotDraftError();
    await recordOperationalEvent({
      clientId: record.clientId,
      buildingId: record.buildingId,
      eventType: 'OPERATIONAL_BUDGET_UPDATED',
      entityType: 'OPERATIONAL_BUDGET',
      entityId: record.id,
      actorUserId,
      summary: 'Draft Operational Budget updated.',
      metadata: { changedFields: Object.keys(input) },
    });
    // CR-BE-COMM-VAR-01 PART 01 — an actual change of the overspend control
    // policy is a financial-control decision, so it is audited distinctly from
    // ordinary draft edits. A no-op re-assert emits no policy event.
    if (record.overspendPolicy !== current.overspendPolicy) {
      await recordOperationalEvent({
        clientId: record.clientId,
        buildingId: record.buildingId,
        eventType: 'OPERATIONAL_BUDGET_OVERSPEND_POLICY_CHANGED',
        entityType: 'OPERATIONAL_BUDGET',
        entityId: record.id,
        actorUserId,
        summary: `Operational Budget overspend policy changed to ${record.overspendPolicy}.`,
        metadata: {
          fromOverspendPolicy: current.overspendPolicy,
          toOverspendPolicy: record.overspendPolicy,
        },
      });
    }
    return toPublicBudget(record);
  } catch (error) {
    if (isPeriodConflict(error)) throw operationalBudgetPeriodConflictError();
    throw error;
  }
}

const TRANSITIONS: Readonly<
  Record<OperationalBudgetStatus, readonly OperationalBudgetStatus[]>
> = {
  DRAFT: ['ACTIVE', 'CANCELLED'],
  ACTIVE: ['CLOSED', 'CANCELLED'],
  CLOSED: [],
  CANCELLED: [],
};

async function transitionOperationalBudget(
  budgetId: string,
  to: OperationalBudgetStatus,
  actorUserId: string,
): Promise<PublicOperationalBudget> {
  const current = await loadBudget(budgetId, actorUserId);
  if (!TRANSITIONS[current.status].includes(to)) {
    throw operationalBudgetTransitionInvalidError(current.status, to);
  }

  const record = await operationalFinanceRepository.transitionBudget(
    budgetId,
    current.status,
    to,
  );
  if (!record) {
    throw operationalBudgetTransitionInvalidError(current.status, to);
  }
  await recordOperationalEvent({
    clientId: record.clientId,
    buildingId: record.buildingId,
    eventType: `OPERATIONAL_BUDGET_${to}`,
    entityType: 'OPERATIONAL_BUDGET',
    entityId: record.id,
    actorUserId,
    summary: `Operational Budget moved to ${to}.`,
    metadata: { fromStatus: current.status, toStatus: to },
  });
  return toPublicBudget(record);
}

export async function activateOperationalBudget(
  budgetId: string,
  actorUserId: string,
): Promise<PublicOperationalBudget> {
  return transitionOperationalBudget(budgetId, 'ACTIVE', actorUserId);
}

export async function closeOperationalBudget(
  budgetId: string,
  actorUserId: string,
): Promise<PublicOperationalBudget> {
  return transitionOperationalBudget(budgetId, 'CLOSED', actorUserId);
}

export async function cancelOperationalBudget(
  budgetId: string,
  actorUserId: string,
): Promise<PublicOperationalBudget> {
  return transitionOperationalBudget(budgetId, 'CANCELLED', actorUserId);
}

export async function createOperationalBudgetCategory(
  budgetId: string,
  input: CreateOperationalBudgetCategoryInput,
  actorUserId: string,
): Promise<PublicOperationalBudgetCategory> {
  const budget = await loadBudget(budgetId, actorUserId);
  if (budget.status !== 'DRAFT') throw operationalBudgetCategoryNotDraftError();

  const newCategory: NewOperationalBudgetCategory = { ...input, budgetId };
  try {
    return toPublicCategory(
      await operationalFinanceRepository.createCategory(newCategory),
    );
  } catch (error) {
    if (isCategoryCodeConflict(error)) {
      throw operationalBudgetCategoryCodeExistsError();
    }
    throw error;
  }
}

export async function getOperationalBudgetCategory(
  categoryId: string,
  actorUserId: string,
): Promise<PublicOperationalBudgetCategory> {
  const { category } = await loadCategoryBudget(categoryId, actorUserId);
  return toPublicCategory(category);
}

export async function listOperationalBudgetCategories(
  budgetId: string,
  actorUserId: string,
): Promise<PublicOperationalBudgetCategory[]> {
  await loadBudget(budgetId, actorUserId);
  return (
    await operationalFinanceRepository.listCategories(budgetId)
  ).map(toPublicCategory);
}

export async function updateOperationalBudgetCategory(
  categoryId: string,
  input: UpdateOperationalBudgetCategoryInput,
  actorUserId: string,
): Promise<PublicOperationalBudgetCategory> {
  const { budget } = await loadCategoryBudget(categoryId, actorUserId);
  if (budget.status !== 'DRAFT') throw operationalBudgetCategoryNotDraftError();

  const category = await operationalFinanceRepository.updateCategory(
    categoryId,
    input,
  );
  if (!category) throw operationalBudgetCategoryNotDraftError();
  return toPublicCategory(category);
}

export async function deleteOperationalBudgetCategory(
  categoryId: string,
  actorUserId: string,
): Promise<void> {
  const { budget } = await loadCategoryBudget(categoryId, actorUserId);
  if (budget.status !== 'DRAFT') throw operationalBudgetCategoryNotDraftError();
  if (!(await operationalFinanceRepository.deleteCategory(categoryId))) {
    throw operationalBudgetCategoryNotDraftError();
  }
}

export const operationalFinanceService = {
  activateOperationalBudget,
  cancelOperationalBudget,
  closeOperationalBudget,
  createOperationalBudget,
  createOperationalBudgetCategory,
  deleteOperationalBudgetCategory,
  getOperationalBudget,
  getOperationalBudgetCategory,
  listOperationalBudgetCategories,
  listOperationalBudgets,
  updateOperationalBudget,
  updateOperationalBudgetCategory,
};
