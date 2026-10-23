import { withTransaction } from '../../database';
import { buildingAccessDeniedError, contextAccessService } from '../context-access';
import { handymanDisciplineRepository } from '../handyman-disciplines';
import { recordOperationalEvent } from '../operational-events';
import { workOrderNotFoundError, workOrderService } from '../work-orders';
// Imported from the TYPES module on purpose: the assignment module imports this
// registry's repository, so loading its index here would create a cycle.
import { isWorkOrderAssignableStatus } from '../work-order-assignments/work-order-assignment.types';
import {
  workOrderClassificationClearBlockedError,
  workOrderTradeCategoryAlreadyExistsError,
  workOrderTradeCategoryInactiveError,
  workOrderTradeCategoryInvalidStateError,
  workOrderTradeCategoryNotFoundError,
} from './work-order-trade-category.errors';
// PART 03B2E — direct file import (same convention as the type import above):
// the assignment module imports this registry's REPOSITORY, so the service may
// reference the assignment SERVICE without an index-level load cycle.
import { revalidateActiveAssignmentForClassification } from '../work-order-assignments/work-order-assignment.service';
import { workOrderAssignmentRepository } from '../work-order-assignments/work-order-assignment.repository';
import { workOrderTradeCategoryRepository } from './work-order-trade-category.repository';
import type {
  ClassifyWorkOrderInput,
  CreateWorkOrderTradeCategoryInput,
  ListWorkOrderTradeCategoriesFilter,
  PublicWorkOrderTradeCategory,
  UpdateWorkOrderTradeCategoryInput,
  WorkOrderClassificationRecord,
  WorkOrderTradeCategoryRecord,
} from './work-order-trade-category.types';

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 03B2A — trade registry commands/reads and
 * the Work Order classification step Operations performs during triage.
 *
 * Governance:
 *   1. DATA-DRIVEN. A trade is a row, never an enum branch. Supporting a new
 *      trade is a configuration action, and no code path special-cases AC.
 *   2. OPTIONAL BY CONSTRUCTION. An unclassified Work Order carries no
 *      requirement and is assigned exactly as before this PART.
 *   3. ISOLATION. Classification requires an ACTIVE Building assignment to the
 *      Work Order's Building (BE-02G), and the category must be ACTIVE.
 *   4. NO SECOND ASSIGNMENT PATH. Classification writes metadata only; the
 *      competency gate stays in the existing Work Order assignment authority.
 *   5. TERMINAL DEACTIVATION. A trade category is deactivated, never deleted,
 *      so historical decisions keep a resolvable classification.
 */

function toPublic(
  record: WorkOrderTradeCategoryRecord,
): PublicWorkOrderTradeCategory {
  return {
    id: record.id,
    code: record.code,
    name: record.name,
    description: record.description,
    riskLevel: record.riskLevel,
    handymanDisciplineId: record.handymanDisciplineId,
    handymanDisciplineCode: record.handymanDisciplineCode,
    status: record.status,
    createdByUserId: record.createdByUserId,
    createdAt:
      record.createdAt instanceof Date
        ? record.createdAt.toISOString()
        : String(record.createdAt),
    updatedAt:
      record.updatedAt instanceof Date
        ? record.updatedAt.toISOString()
        : String(record.updatedAt),
  };
}

export function toPublicWorkOrderTradeCategory(
  record: WorkOrderTradeCategoryRecord,
): PublicWorkOrderTradeCategory {
  return toPublic(record);
}

async function requireCategory(
  id: string,
): Promise<WorkOrderTradeCategoryRecord> {
  const category = await workOrderTradeCategoryRepository.findById(undefined, id);
  if (!category) throw workOrderTradeCategoryNotFoundError();
  return category;
}

async function assertDisciplineExists(id: string | null): Promise<void> {
  if (id === null) return;
  const discipline = await handymanDisciplineRepository.findDisciplineById(
    undefined,
    id,
  );
  if (!discipline) {
    throw workOrderTradeCategoryInvalidStateError(
      'The linked handyman discipline does not exist.',
    );
  }
}

export async function listWorkOrderTradeCategories(
  filter: ListWorkOrderTradeCategoriesFilter = {},
): Promise<PublicWorkOrderTradeCategory[]> {
  const records = await workOrderTradeCategoryRepository.list(undefined, filter);
  return records.map(toPublic);
}

export async function getWorkOrderTradeCategoryById(
  id: string,
): Promise<PublicWorkOrderTradeCategory> {
  return toPublic(await requireCategory(id));
}

export async function createWorkOrderTradeCategory(
  input: CreateWorkOrderTradeCategoryInput,
  actorUserId: string,
): Promise<PublicWorkOrderTradeCategory> {
  const existing = await workOrderTradeCategoryRepository.findByCode(
    undefined,
    input.code,
  );
  if (existing) throw workOrderTradeCategoryAlreadyExistsError(input.code);
  await assertDisciplineExists(input.handymanDisciplineId);

  return withTransaction(async (tx) => {
    const created = await workOrderTradeCategoryRepository.insert(tx, {
      ...input,
      createdByUserId: actorUserId,
    });
    await recordOperationalEvent(
      {
        clientId: null,
        eventType: 'WORK_ORDER_TRADE_CATEGORY_CREATED',
        entityType: 'WORK_ORDER_TRADE_CATEGORY',
        entityId: created.id,
        actorUserId,
        summary:
          `Work order trade category ${created.code} created ` +
          `(default risk ${created.riskLevel}).`,
        metadata: {
          code: created.code,
          riskLevel: created.riskLevel,
          handymanDisciplineId: created.handymanDisciplineId,
        },
      },
      tx,
    );
    return toPublic(created);
  });
}

export async function updateWorkOrderTradeCategory(
  id: string,
  changes: UpdateWorkOrderTradeCategoryInput,
  actorUserId: string,
): Promise<PublicWorkOrderTradeCategory> {
  const existing = await requireCategory(id);
  if (existing.status !== 'ACTIVE') {
    throw workOrderTradeCategoryInvalidStateError(
      'An INACTIVE trade category can no longer be modified.',
    );
  }
  if (changes.handymanDisciplineId !== undefined && changes.handymanDisciplineId !== null) {
    await assertDisciplineExists(changes.handymanDisciplineId);
  }

  return withTransaction(async (tx) => {
    const updated = await workOrderTradeCategoryRepository.update(
      tx,
      id,
      changes,
    );
    if (!updated) throw workOrderTradeCategoryNotFoundError();
    await recordOperationalEvent(
      {
        clientId: null,
        eventType: 'WORK_ORDER_TRADE_CATEGORY_UPDATED',
        entityType: 'WORK_ORDER_TRADE_CATEGORY',
        entityId: updated.id,
        actorUserId,
        summary: `Work order trade category ${updated.code} updated.`,
        metadata: {
          code: updated.code,
          changedFields: Object.keys(changes),
          riskLevel: updated.riskLevel,
        },
      },
      tx,
    );
    return toPublic(updated);
  });
}

export async function deactivateWorkOrderTradeCategory(
  id: string,
  actorUserId: string,
): Promise<PublicWorkOrderTradeCategory> {
  const existing = await requireCategory(id);
  if (existing.status !== 'ACTIVE') {
    throw workOrderTradeCategoryInvalidStateError(
      'The trade category is already INACTIVE.',
    );
  }

  return withTransaction(async (tx) => {
    const deactivated = await workOrderTradeCategoryRepository.setStatus(
      tx,
      id,
      'INACTIVE',
    );
    if (!deactivated) throw workOrderTradeCategoryNotFoundError();
    await recordOperationalEvent(
      {
        clientId: null,
        eventType: 'WORK_ORDER_TRADE_CATEGORY_DEACTIVATED',
        entityType: 'WORK_ORDER_TRADE_CATEGORY',
        entityId: deactivated.id,
        actorUserId,
        summary:
          `Work order trade category ${deactivated.code} deactivated; it can no ` +
          'longer classify a new Work Order.',
        metadata: { code: deactivated.code },
      },
      tx,
    );
    return toPublic(deactivated);
  });
}

/** Read the current classification of a Work Order (unclassified → nulls). */
export async function getWorkOrderClassification(
  workOrderId: string,
  actorUserId: string,
): Promise<WorkOrderClassificationRecord> {
  const workOrder = await workOrderService.getWorkOrderById(workOrderId);
  await contextAccessService.assertBuildingAccess(actorUserId, workOrder.buildingId);
  const classification = await workOrderTradeCategoryRepository.findClassification(
    undefined,
    workOrderId,
  );
  if (!classification) throw workOrderNotFoundError();
  return classification;
}

/**
 * The triage decision: Operations confirms the FINAL trade classification and
 * risk level for a Work Order (requirement 5 of the CR). The risk level
 * defaults to the category's configured default, and can be raised or lowered
 * for this specific job — the risk is a property of the WORK, the default is a
 * property of the trade.
 */
export async function classifyWorkOrder(
  workOrderId: string,
  input: ClassifyWorkOrderInput,
  actorUserId: string,
): Promise<WorkOrderClassificationRecord> {
  const workOrder = await workOrderService.getWorkOrderById(workOrderId);
  await contextAccessService.assertBuildingAccess(actorUserId, workOrder.buildingId);

  if (!isWorkOrderAssignableStatus(workOrder.status)) {
    throw workOrderTradeCategoryInvalidStateError(
      `The Work Order is ${workOrder.status}; its classification can no longer ` +
        'be changed because assignment and completion already relied on it.',
    );
  }

  const category =
    input.tradeCategoryId === null
      ? null
      : await requireCategory(input.tradeCategoryId);
  if (category && category.status !== 'ACTIVE') {
    throw workOrderTradeCategoryInactiveError();
  }

  const riskLevel =
    category === null
      ? null
      : input.riskLevel === undefined || input.riskLevel === null
        ? category.riskLevel
        : input.riskLevel;

  return withTransaction(async (tx) => {
    // PART 03B2E — serialize against the assignment authority for this row, so
    // "is there an ACTIVE assignment?" and "which classification does it run
    // under?" cannot be read from two different transactions.
    const locked = await workOrderTradeCategoryRepository.lockWorkOrder(tx, workOrderId);
    if (!locked) throw workOrderNotFoundError();

    const previous = await workOrderTradeCategoryRepository.findClassification(
      tx,
      workOrderId,
    );
    const previousCategoryId = previous?.tradeCategoryId ?? null;
    const previousRiskLevel = previous?.riskLevel ?? null;
    const classificationRequired = previous?.classificationRequired ?? false;

    // Clearing the classification of a Handyman-lifecycle Work Order that is
    // still assigned would return a gated, running job to the ungated path.
    if (category === null && classificationRequired) {
      const active = await workOrderAssignmentRepository.findActiveByWorkOrderId(
        workOrderId,
        tx,
      );
      if (active) throw workOrderClassificationClearBlockedError(active.id);
    }

    const classification = await workOrderTradeCategoryRepository.classify(tx, {
      workOrderId,
      tradeCategoryId: category?.id ?? null,
      tradeCategoryCode: category?.code ?? null,
      riskLevel,
      actorUserId,
    });
    if (!classification) throw workOrderNotFoundError();

    // PART 03B2E — the classification only changes the requirements of FUTURE
    // assignments if nobody is working yet. When an assignment is ACTIVE, the
    // SAME gate revalidates it here; a MANDATORY gap throws and rolls the whole
    // change back, so a running job can never be silently left non-compliant.
    const classificationChanged =
      (category?.id ?? null) !== previousCategoryId ||
      (riskLevel ?? null) !== previousRiskLevel;
    const revalidation =
      category !== null && classificationChanged
        ? await revalidateActiveAssignmentForClassification(tx, {
            workOrderId,
            clientId: workOrder.clientId,
            tradeCategoryId: category.id,
            tradeCategoryCode: category.code,
            riskLevel,
          })
        : null;

    await recordOperationalEvent(
      {
        clientId: workOrder.clientId,
        eventType:
          category === null
            ? 'WORK_ORDER_CLASSIFICATION_CLEARED'
            : 'WORK_ORDER_CLASSIFIED',
        entityType: 'WORK_ORDER',
        entityId: workOrderId,
        actorUserId,
        buildingId: workOrder.buildingId,
        summary:
          category === null
            ? 'Work order classification cleared; competency requirements no ' +
              'longer apply to its assignments.'
            : `Work order classified as ${category.code} at ${riskLevel} risk.`,
        metadata: {
          tradeCategoryId: category?.id ?? null,
          tradeCategoryCode: category?.code ?? null,
          riskLevel,
          previousTradeCategoryId: previousCategoryId,
          previousRiskLevel,
          // Proof that an ACTIVE assignment was revalidated (or that there was
          // nothing to revalidate), so the audit trail answers "why is the
          // running assignment still valid under the new trade?".
          revalidation:
            revalidation === null
              ? null
              : {
                  assignmentId: revalidation.assignmentId,
                  satisfied: revalidation.satisfied,
                  mandatoryRequirementCount:
                    revalidation.mandatoryRequirementCount,
                  advisoryCount: revalidation.advisory.length,
                },
          ...(input.notes ? { notes: input.notes } : {}),
        },
      },
      tx,
    );

    return classification;
  });
}

export const workOrderTradeCategoryService = {
  classifyWorkOrder,
  createWorkOrderTradeCategory,
  deactivateWorkOrderTradeCategory,
  getWorkOrderClassification,
  getWorkOrderTradeCategoryById,
  listWorkOrderTradeCategories,
  updateWorkOrderTradeCategory,
};
