import { AppError } from '../../shared/errors';
import { contextAccessService } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { vendorWorkNotFoundError, vendorWorkRepository } from '../vendor-work';
import {
  workOrderNotFoundError,
  workOrderRepository,
} from '../work-orders';
import {
  vendorChecklistBindingAlreadyExistsError,
  vendorChecklistBindingInactiveError,
  vendorChecklistBindingNotFoundError,
  vendorChecklistBuildingMismatchError,
  vendorChecklistExecutionNotFoundError,
  vendorChecklistVendorWorkCompletedError,
} from './vendor-checklist-binding.errors';
import {
  vendorChecklistBindingRepository,
  type ChecklistTemplateRow,
  type ExecutionRow,
} from './vendor-checklist-binding.repository';
import type {
  CreateVendorChecklistBindingInput,
  NewVendorChecklistBinding,
  PublicVendorChecklistBinding,
  PublicVendorChecklistExecutionContext,
  PublicVendorChecklistExecution,
  VendorChecklistBindingFilters,
  VendorChecklistBindingRecord,
} from './vendor-checklist-binding.types';

/**
 * BE-15C — Vendor Checklist Binding service.
 *
 * Binds BE-07 Checklist Templates to a Vendor operational context (a BE-15B
 * Vendor Work inside a Building / Work Order) and starts executions on the
 * shared BE-07 checklist execution table. Workflow, measurement, evidence,
 * and verification all remain owned by BE-07 — this service only validates
 * and records the binding.
 *
 * Validation order (pinned by tests):
 *   1. unknown Vendor Work              → 404 VENDOR_WORK_NOT_FOUND
 *   2. COMPLETED Vendor Work            → 400 VENDOR_CHECKLIST_VENDOR_WORK_COMPLETED
 *   3. unknown Work Order               → 404 WORK_ORDER_NOT_FOUND
 *   4. Work Order / Vendor Work Building mismatch → 400 VENDOR_CHECKLIST_BUILDING_MISMATCH
 *   5. unknown template                 → 404 NOT_FOUND
 *   6. non-ACTIVE template              → 400 BAD_REQUEST
 *   7. cross-Client template            → 400 VENDOR_CHECKLIST_BUILDING_MISMATCH
 *   8. duplicate ACTIVE binding         → 409 VENDOR_CHECKLIST_BINDING_ALREADY_EXISTS
 */

export function toPublicVendorChecklistBinding(
  record: VendorChecklistBindingRecord,
): PublicVendorChecklistBinding {
  return {
    id: record.id,
    clientId: record.clientId,
    vendorWorkId: record.vendorWorkId,
    checklistTemplateId: record.checklistTemplateId,
    checklistExecutionId: record.checklistExecutionId,
    buildingId: record.buildingId,
    workOrderId: record.workOrderId,
    status: record.status,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/** BE-07 rule, unchanged: only an ACTIVE template can be bound/executed. */
async function assertChecklistTemplate(
  templateId: string,
): Promise<ChecklistTemplateRow> {
  const template =
    await vendorChecklistBindingRepository.findChecklistTemplate(templateId);
  if (!template) {
    throw AppError.notFound('Checklist template not found.');
  }
  if (template.status !== 'ACTIVE') {
    throw AppError.badRequest('Checklist template is not active.');
  }
  return template;
}

/**
 * Resolves the Vendor Work and its authoritative Building / Client context
 * from the Work Order (the BE-08 master is the authority for the Work Order's
 * Building and Client).
 */
async function resolveVendorWorkContext(vendorWorkId: string): Promise<{
  vendorWorkId: string;
  workOrderId: string;
  buildingId: string;
  clientId: string;
}> {
  const work = await vendorWorkRepository.findById(vendorWorkId);
  if (!work) {
    throw vendorWorkNotFoundError();
  }
  if (work.status === 'COMPLETED') {
    throw vendorChecklistVendorWorkCompletedError();
  }

  const workOrder = await workOrderRepository.findById(work.workOrderId);
  if (!workOrder) {
    throw workOrderNotFoundError();
  }
  if (workOrder.buildingId !== work.buildingId) {
    throw vendorChecklistBuildingMismatchError();
  }

  return {
    vendorWorkId: work.id,
    workOrderId: workOrder.id,
    buildingId: workOrder.buildingId,
    clientId: workOrder.clientId,
  };
}

function isActiveBindingUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint === 'vendor_checklist_binding_active_unique'
  );
}

export async function createVendorChecklistBinding(
  input: CreateVendorChecklistBindingInput,
  userId: string,
): Promise<PublicVendorChecklistBinding> {
  const context = await resolveVendorWorkContext(input.vendorWorkId);
  await contextAccessService.assertBuildingAccess(userId, context.buildingId);

  const template = await assertChecklistTemplate(input.checklistTemplateId);
  if (template.client_id !== context.clientId) {
    throw vendorChecklistBuildingMismatchError();
  }

  const existing =
    await vendorChecklistBindingRepository.findActiveByVendorWorkAndTemplate(
      context.vendorWorkId,
      template.id,
    );
  if (existing) {
    throw vendorChecklistBindingAlreadyExistsError();
  }

  const newBinding: NewVendorChecklistBinding = {
    clientId: context.clientId,
    vendorWorkId: context.vendorWorkId,
    checklistTemplateId: template.id,
    buildingId: context.buildingId,
    workOrderId: context.workOrderId,
    createdByUserId: userId,
  };

  try {
    const record = await vendorChecklistBindingRepository.create(newBinding);
    await recordOperationalEvent({
      clientId: context.clientId,
      eventType: 'VENDOR_CHECKLIST_BINDING_CREATED',
      entityType: 'VENDOR_WORK',
      entityId: context.vendorWorkId,
      actorUserId: userId,
      buildingId: context.buildingId,
      vendorWorkId: context.vendorWorkId,
      summary: 'Vendor checklist binding created',
      metadata: {
        checklistBindingId: record.id,
        checklistTemplateId: record.checklistTemplateId,
        workOrderId: record.workOrderId,
      },
    });
    return toPublicVendorChecklistBinding(record);
  } catch (error) {
    if (isActiveBindingUniqueViolation(error)) {
      throw vendorChecklistBindingAlreadyExistsError();
    }
    throw error;
  }
}

export async function getVendorChecklistBinding(
  bindingId: string,
  userId: string,
): Promise<PublicVendorChecklistBinding> {
  const record = await vendorChecklistBindingRepository.findById(bindingId);
  if (!record) {
    throw vendorChecklistBindingNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, record.buildingId);
  return toPublicVendorChecklistBinding(record);
}

export async function listVendorChecklistBindings(
  filters: VendorChecklistBindingFilters,
  userId: string,
  accessibleBuildingIds: string[],
): Promise<PublicVendorChecklistBinding[]> {
  let effectiveFilters = filters;

  // A Vendor Work filter resolves to its Building so the repository stays
  // scoped to the caller's accessible Buildings.
  if (filters.vendorWorkId) {
    const work = await vendorWorkRepository.findById(filters.vendorWorkId);
    if (!work) {
      throw vendorWorkNotFoundError();
    }
    await contextAccessService.assertBuildingAccess(userId, work.buildingId);
    effectiveFilters = { ...filters, buildingId: work.buildingId };
  }

  const buildingIds =
    effectiveFilters.buildingId !== undefined
      ? [effectiveFilters.buildingId]
      : accessibleBuildingIds;

  if (buildingIds.length === 0) {
    return [];
  }

  const records = await vendorChecklistBindingRepository.list({
    vendorWorkId: effectiveFilters.vendorWorkId,
    vendorId: effectiveFilters.vendorId,
    buildingId: effectiveFilters.buildingId,
    buildingIds,
  });
  return records.map(toPublicVendorChecklistBinding);
}

/**
 * Starts the shared BE-07 checklist execution for an ACTIVE binding. The
 * execution row lives on BE-07's own `checklist_executions` table and keeps
 * all BE-07 lifecycle behaviour (start / responses / complete / cancel).
 */
export async function startVendorChecklistExecution(
  bindingId: string,
  userId: string,
): Promise<{ execution: PublicVendorChecklistExecution; created: boolean }> {
  const binding = await vendorChecklistBindingRepository.findById(bindingId);
  if (!binding) {
    throw vendorChecklistBindingNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, binding.buildingId);
  if (binding.status !== 'ACTIVE') {
    throw vendorChecklistBindingInactiveError();
  }

  if (binding.checklistExecutionId) {
    const existing = await vendorChecklistBindingRepository.findExecution(
      binding.checklistExecutionId,
    );
    if (existing) {
      return {
        execution: toPublicVendorChecklistExecution(existing, binding.id),
        created: false,
      };
    }
  }

  const template = await assertChecklistTemplate(binding.checklistTemplateId);

  const execution = await vendorChecklistBindingRepository.insertExecution({
    clientId: binding.clientId,
    checklistTemplateId: template.id,
  });
  await vendorChecklistBindingRepository.linkExecution(binding.id, execution.id);

  await recordOperationalEvent({
    clientId: binding.clientId,
    eventType: 'VENDOR_CHECKLIST_EXECUTION_STARTED',
    entityType: 'VENDOR_WORK',
    entityId: binding.vendorWorkId,
    actorUserId: userId,
    buildingId: binding.buildingId,
    vendorWorkId: binding.vendorWorkId,
    summary: 'Vendor checklist execution started',
    metadata: {
      checklistBindingId: binding.id,
      checklistExecutionId: execution.id,
      checklistTemplateId: template.id,
      workOrderId: binding.workOrderId,
    },
  });

  return {
    execution: toPublicVendorChecklistExecution(execution, binding.id),
    created: true,
  };
}

/** Resolves the Vendor Work / Building / Work Order / Template context an execution is tied to. */
export async function resolveVendorChecklistExecutionContext(
  executionId: string,
  userId: string,
): Promise<PublicVendorChecklistExecutionContext> {
  const row =
    await vendorChecklistBindingRepository.findExecutionContext(executionId);
  if (!row || !row.vendor_checklist_binding_id) {
    throw vendorChecklistExecutionNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(
    userId,
    row.building_id as string,
  );

  return {
    execution: {
      id: row.execution_id,
      checklistTemplateId: row.execution_template_id,
      vendorChecklistBindingId: row.vendor_checklist_binding_id,
      status: row.execution_status,
      startedAt: row.execution_started_at
        ? row.execution_started_at.toISOString()
        : null,
      completedAt: row.execution_completed_at
        ? row.execution_completed_at.toISOString()
        : null,
      createdAt: row.execution_created_at.toISOString(),
      updatedAt: row.execution_updated_at.toISOString(),
    },
    vendorWork: {
      id: row.vendor_work_id as string,
      vendorId: row.vendor_id as string,
      status: row.vendor_work_status as string,
    },
    building: {
      id: row.building_id as string,
      code: row.building_code as string,
      name: row.building_name as string,
    },
    workOrder: {
      id: row.work_order_id as string,
      workOrderNumber: row.work_order_number as string,
      status: row.work_order_status as string,
    },
    template: {
      id: row.template_id as string,
      code: row.template_code as string,
      name: row.template_name as string,
      status: row.template_status as string,
    },
  };
}

function toPublicVendorChecklistExecution(
  execution: ExecutionRow,
  bindingId: string,
): PublicVendorChecklistExecution {
  return {
    id: execution.id,
    checklistTemplateId: execution.checklist_template_id,
    vendorChecklistBindingId: bindingId,
    status: execution.status,
    startedAt: execution.started_at ? execution.started_at.toISOString() : null,
    completedAt: execution.completed_at
      ? execution.completed_at.toISOString()
      : null,
    createdAt: execution.created_at.toISOString(),
    updatedAt: execution.updated_at.toISOString(),
  };
}

export const vendorChecklistBindingService = {
  createVendorChecklistBinding,
  getVendorChecklistBinding,
  listVendorChecklistBindings,
  resolveVendorChecklistExecutionContext,
  startVendorChecklistExecution,
  toPublicVendorChecklistBinding,
};
