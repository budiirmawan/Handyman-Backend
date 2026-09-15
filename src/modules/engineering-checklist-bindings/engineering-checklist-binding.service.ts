import { AppError } from '../../shared/errors';
import {
  assetNotFoundError,
  assetRepository,
  assetRetiredError,
  resolveAssetBuildingContext,
} from '../assets';
import { contextAccessService } from '../context-access';
import {
  functionalLocationNotFoundError,
  functionalLocationRepository,
} from '../functional-locations';
import { recordOperationalEvent } from '../operational-events';
import {
  engineeringChecklistAssetBuildingMismatchError,
  engineeringChecklistBindingAlreadyExistsError,
  engineeringChecklistBindingInactiveError,
  engineeringChecklistBindingNotFoundError,
  engineeringChecklistExecutionNotFoundError,
  engineeringChecklistLocationBuildingMismatchError,
  engineeringChecklistTemplateClientMismatchError,
  engineeringChecklistUomClientMismatchError,
  engineeringChecklistUomInactiveError,
} from './engineering-checklist-binding.errors';
import {
  engineeringChecklistBindingRepository,
  type ChecklistTemplateRow,
  type ExecutionContextRow,
  type ExecutionRow,
  type MeasurementItemRow,
} from './engineering-checklist-binding.repository';
import {
  type CreateEngineeringChecklistBindingInput,
  type EngineeringChecklistBindingRecord,
  type PublicEngineeringChecklistBinding,
  type PublicEngineeringChecklistExecutionContext,
  type PublicEngineeringChecklistExecution,
  type UpdateEngineeringChecklistBindingInput,
} from './engineering-checklist-binding.types';

/**
 * BE-10E — Engineering Checklist Binding service.
 *
 * Binds BE-07 Checklist Templates to an Engineering operational context (a
 * Building plus an optional Asset and/or Functional Location target) and
 * starts executions on the shared BE-07 checklist execution table. Workflow,
 * measurement, evidence, verification, and findings all remain owned by
 * BE-07 / BE-09 — this service only validates and records the binding.
 *
 * Validation order (pinned by tests):
 *   1. unknown Building              → 404 BUILDING_NOT_FOUND
 *   2. INACTIVE Building             → 400 BAD_REQUEST
 *   3. inaccessible Building         → 403 BUILDING_ACCESS_DENIED
 *   4. unknown template              → 404 NOT_FOUND
 *   5. non-ACTIVE template           → 400 BAD_REQUEST
 *   6. cross-Client template         → 400 ENGINEERING_CHECKLIST_TEMPLATE_CLIENT_MISMATCH
 *   7. unknown Asset                 → 404 ASSET_NOT_FOUND
 *   8. Asset of another Building     → 400 ENGINEERING_CHECKLIST_ASSET_BUILDING_MISMATCH
 *   9. non-ACTIVE Asset              → 409 ASSET_RETIRED / 400 BAD_REQUEST
 *  10. unknown Functional Location   → 404 FUNCTIONAL_LOCATION_NOT_FOUND
 *  11. Location of another Building  → 400 ENGINEERING_CHECKLIST_LOCATION_BUILDING_MISMATCH
 *  12. INACTIVE location             → 400 BAD_REQUEST
 *  13. measurement item UOM invalid  → 400 ..._UOM_INACTIVE / ..._UOM_CLIENT_MISMATCH
 *  14. duplicate ACTIVE binding      → 409 ENGINEERING_CHECKLIST_BINDING_ALREADY_EXISTS
 */
export async function createEngineeringChecklistBinding(
  input: CreateEngineeringChecklistBindingInput,
  userId: string,
): Promise<PublicEngineeringChecklistBinding> {
  // 404 for an unknown Building first, then 403 for an inaccessible one
  // (mirrors the BE-05/06 resolution order).
  const { clientId, buildingStatus } = await resolveAssetBuildingContext(
    input.buildingId,
  );
  await contextAccessService.assertBuildingAccess(userId, input.buildingId);
  if (buildingStatus !== 'ACTIVE') {
    throw AppError.badRequest('Building is not active.');
  }

  const template = await assertChecklistTemplate(input.checklistTemplateId);
  if (template.client_id !== clientId) {
    throw engineeringChecklistTemplateClientMismatchError();
  }
  await assertMeasurementUoms(template.id, clientId);

  const assetId = await assertChecklistAsset(input.assetId ?? null, input.buildingId);
  const functionalLocationId = await assertChecklistLocation(
    input.functionalLocationId ?? null,
    input.buildingId,
  );

  try {
    const record = await engineeringChecklistBindingRepository.create({
      clientId,
      buildingId: input.buildingId,
      checklistTemplateId: template.id,
      assetId,
      functionalLocationId,
      status: input.status ?? 'ACTIVE',
      createdByUserId: userId,
    });
    return toPublicEngineeringChecklistBinding(record);
  } catch (error) {
    if (isActiveBindingUniqueViolation(error)) {
      throw engineeringChecklistBindingAlreadyExistsError();
    }
    throw error;
  }
}

export async function getEngineeringChecklistBinding(
  id: string,
  userId: string,
): Promise<PublicEngineeringChecklistBinding> {
  const record = await engineeringChecklistBindingRepository.findById(id);
  if (!record) {
    throw engineeringChecklistBindingNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, record.buildingId);
  return toPublicEngineeringChecklistBinding(record);
}

export async function listEngineeringChecklistBindings(
  filters: { buildingId?: string; assetId?: string },
  userId: string,
): Promise<PublicEngineeringChecklistBinding[]> {
  let records: EngineeringChecklistBindingRecord[];

  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(userId, filters.buildingId);
    records = await engineeringChecklistBindingRepository.listByBuildingId(
      filters.buildingId,
    );
  } else if (filters.assetId) {
    const asset = await assetRepository.findById(filters.assetId);
    if (!asset) {
      throw assetNotFoundError();
    }
    await contextAccessService.assertBuildingAccess(userId, asset.buildingId);
    records = await engineeringChecklistBindingRepository.listByAssetId(
      filters.assetId,
    );
  } else {
    const buildingIds = await contextAccessService.getAccessibleBuildingIds(userId);
    records = await engineeringChecklistBindingRepository.listByBuildingIds(
      buildingIds,
    );
  }

  return records.map(toPublicEngineeringChecklistBinding);
}

export async function updateEngineeringChecklistBinding(
  id: string,
  input: UpdateEngineeringChecklistBindingInput,
  userId: string,
): Promise<PublicEngineeringChecklistBinding> {
  const existing = await engineeringChecklistBindingRepository.findById(id);
  if (!existing) {
    throw engineeringChecklistBindingNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, existing.buildingId);

  const assetId =
    input.assetId !== undefined
      ? await assertChecklistAsset(input.assetId, existing.buildingId)
      : undefined;
  const functionalLocationId =
    input.functionalLocationId !== undefined
      ? await assertChecklistLocation(input.functionalLocationId, existing.buildingId)
      : undefined;

  // The binding must keep at least one operational target.
  const nextAssetId = assetId === undefined ? existing.assetId : assetId;
  const nextLocationId =
    functionalLocationId === undefined ? existing.functionalLocationId : functionalLocationId;
  if (nextAssetId === null && nextLocationId === null) {
    throw AppError.badRequest('A checklist binding requires at least one target.');
  }

  try {
    const updated = await engineeringChecklistBindingRepository.update(id, {
      ...(assetId === undefined ? {} : { assetId }),
      ...(functionalLocationId === undefined ? {} : { functionalLocationId }),
      ...(input.status === undefined ? {} : { status: input.status }),
    });
    if (!updated) {
      throw engineeringChecklistBindingNotFoundError();
    }
    return toPublicEngineeringChecklistBinding(updated);
  } catch (error) {
    if (isActiveBindingUniqueViolation(error)) {
      throw engineeringChecklistBindingAlreadyExistsError();
    }
    throw error;
  }
}

/**
 * Starts the shared BE-07 checklist execution for an ACTIVE binding. The
 * execution row lives on BE-07's own `checklist_executions` table and keeps
 * all BE-07 lifecycle behaviour (start / responses / complete / cancel).
 */
export async function startEngineeringChecklistExecution(
  bindingId: string,
  userId: string,
): Promise<PublicEngineeringChecklistExecution> {
  const binding = await engineeringChecklistBindingRepository.findById(bindingId);
  if (!binding) {
    throw engineeringChecklistBindingNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, binding.buildingId);
  if (binding.status !== 'ACTIVE') {
    throw engineeringChecklistBindingInactiveError();
  }

  const template = await engineeringChecklistBindingRepository.findChecklistTemplate(
    binding.checklistTemplateId,
  );
  if (!template) {
    throw AppError.notFound('Checklist template not found.');
  }
  if (template.status !== 'ACTIVE') {
    throw AppError.badRequest('Checklist template is not active.');
  }

  const execution = await engineeringChecklistBindingRepository.insertExecution({
    bindingId: binding.id,
    clientId: binding.clientId,
    checklistTemplateId: template.id,
  });

  await recordOperationalEvent({
    clientId: binding.clientId,
    eventType: 'ENGINEERING_CHECKLIST_EXECUTION_STARTED',
    entityType: 'CHECKLIST_EXECUTION',
    entityId: execution.id,
    actorUserId: userId,
    buildingId: binding.buildingId,
    summary: `Engineering checklist execution started for binding ${binding.id}`,
    metadata: {
      engineeringChecklistBindingId: binding.id,
      checklistTemplateId: template.id,
      assetId: binding.assetId,
      functionalLocationId: binding.functionalLocationId,
    },
  });

  return toPublicEngineeringChecklistExecution(execution, binding.id);
}

/** Resolves the Building / Template / Asset / Location context an execution is tied to. */
export async function resolveEngineeringChecklistExecutionContext(
  executionId: string,
  userId: string,
): Promise<PublicEngineeringChecklistExecutionContext> {
  const row = await engineeringChecklistBindingRepository.findExecutionContext(
    executionId,
  );
  if (!row || !row.engineering_checklist_binding_id) {
    throw engineeringChecklistExecutionNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, row.building_id as string);

  return {
    execution: {
      id: row.execution_id,
      checklistTemplateId: row.execution_template_id,
      engineeringChecklistBindingId: row.engineering_checklist_binding_id,
      status: row.execution_status,
      startedAt: row.execution_started_at ? row.execution_started_at.toISOString() : null,
      completedAt: row.execution_completed_at
        ? row.execution_completed_at.toISOString()
        : null,
      createdAt: row.execution_created_at.toISOString(),
      updatedAt: row.execution_updated_at.toISOString(),
    },
    building: {
      id: row.building_id as string,
      code: row.building_code as string,
      name: row.building_name as string,
    },
    template: {
      id: row.template_id as string,
      code: row.template_code as string,
      name: row.template_name as string,
      status: row.template_status as string,
    },
    asset: row.asset_id
      ? {
          id: row.asset_id,
          assetCode: row.asset_code as string,
          assetName: row.asset_name as string,
          status: row.asset_status as string,
        }
      : null,
    functionalLocation: row.functional_location_id
      ? {
          id: row.functional_location_id,
          code: row.functional_location_code as string,
          name: row.functional_location_name as string,
          status: row.functional_location_status as string,
        }
      : null,
  };
}

/** BE-07 rule, unchanged: only an ACTIVE template can be bound/executed. */
async function assertChecklistTemplate(
  templateId: string,
): Promise<ChecklistTemplateRow> {
  const template = await engineeringChecklistBindingRepository.findChecklistTemplate(
    templateId,
  );
  if (!template) {
    throw AppError.notFound('Checklist template not found.');
  }
  if (template.status !== 'ACTIVE') {
    throw AppError.badRequest('Checklist template is not active.');
  }
  return template;
}

/** BE-05 lifecycle governs asset eligibility: only ACTIVE assets bind. */
async function assertChecklistAsset(
  assetId: string | null,
  buildingId: string,
): Promise<string | null> {
  if (assetId === null) {
    return null;
  }
  const asset = await assetRepository.findById(assetId);
  if (!asset) {
    throw assetNotFoundError();
  }
  if (asset.buildingId !== buildingId) {
    throw engineeringChecklistAssetBuildingMismatchError();
  }
  if (asset.status === 'RETIRED') {
    throw assetRetiredError();
  }
  if (asset.status !== 'ACTIVE') {
    throw AppError.badRequest(
      'Assets must be ACTIVE to receive engineering checklist bindings.',
    );
  }
  return asset.id;
}

/**
 * Validates an optional BE-04 Functional Location target (same rules as the
 * other BE-10 bindings: exists, same Building, ACTIVE).
 */
async function assertChecklistLocation(
  functionalLocationId: string | null,
  buildingId: string,
): Promise<string | null> {
  if (functionalLocationId === null) {
    return null;
  }
  const location = await functionalLocationRepository.findById(
    functionalLocationId,
  );
  if (!location) {
    throw functionalLocationNotFoundError();
  }
  if (location.buildingId !== buildingId) {
    throw engineeringChecklistLocationBuildingMismatchError();
  }
  if (location.status !== 'ACTIVE') {
    throw AppError.badRequest(
      'Inactive functional locations cannot receive engineering checklist bindings.',
    );
  }
  return location.id;
}

/** Every configured measurement item must use a valid, same-Client, ACTIVE UOM. */
async function assertMeasurementUoms(
  templateId: string,
  clientId: string,
): Promise<void> {
  const items = await engineeringChecklistBindingRepository.listTemplateMeasurementItems(
    templateId,
  );
  for (const item of items) {
    await assertMeasurementItemUom(item, clientId);
  }
}

async function assertMeasurementItemUom(
  item: MeasurementItemRow,
  clientId: string,
): Promise<void> {
  if (!item.uom_id) {
    return;
  }
  const uom = await engineeringChecklistBindingRepository.findUom(item.uom_id);
  if (!uom) {
    throw AppError.notFound('UOM not found.');
  }
  if (uom.status !== 'ACTIVE') {
    throw engineeringChecklistUomInactiveError();
  }
  if (uom.client_id !== clientId) {
    throw engineeringChecklistUomClientMismatchError();
  }
}

function isActiveBindingUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint === 'engineering_checklist_binding_active_unique'
  );
}

export function toPublicEngineeringChecklistBinding(
  record: EngineeringChecklistBindingRecord,
): PublicEngineeringChecklistBinding {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    checklistTemplateId: record.checklistTemplateId,
    assetId: record.assetId,
    functionalLocationId: record.functionalLocationId,
    status: record.status,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function toPublicEngineeringChecklistExecution(
  execution: ExecutionRow,
  bindingId: string,
): PublicEngineeringChecklistExecution {
  return {
    id: execution.id,
    checklistTemplateId: execution.checklist_template_id,
    engineeringChecklistBindingId: bindingId,
    status: execution.status,
    startedAt: execution.started_at ? execution.started_at.toISOString() : null,
    completedAt: execution.completed_at
      ? execution.completed_at.toISOString()
      : null,
    createdAt: execution.created_at.toISOString(),
    updatedAt: execution.updated_at.toISOString(),
  };
}

export const engineeringChecklistBindingService = {
  createEngineeringChecklistBinding,
  getEngineeringChecklistBinding,
  listEngineeringChecklistBindings,
  resolveEngineeringChecklistExecutionContext,
  startEngineeringChecklistExecution,
  updateEngineeringChecklistBinding,
};
