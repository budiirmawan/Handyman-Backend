import { AppError } from '../../shared/errors';
import { getPool } from '../../database';
import {
  assetNotFoundError,
  assetRepository,
  assetRetiredError,
  resolveAssetBuildingContext,
} from '../assets';
import { buildingService } from '../buildings';
import { contextAccessService } from '../context-access';
import {
  functionalLocationNotFoundError,
  functionalLocationRepository,
} from '../functional-locations';
import { recordOperationalEvent } from '../operational-events';
import {
  inspectionBindingAlreadyExistsError,
  inspectionBindingInactiveError,
  inspectionBindingNotFoundError,
  inspectionExecutionNotFoundError,
  inspectionLocationBuildingMismatchError,
  inspectionTemplateClientMismatchError,
} from './inspection-binding.errors';
import {
  inspectionBindingRepository,
  type ExecutionContextRow,
} from './inspection-binding.repository';
import {
  type CreateInspectionBindingInput,
  type InspectionBindingRecord,
  type PublicInspectionBinding,
  type PublicInspectionExecutionContext,
  type PublicInspectionExecution,
  type UpdateInspectionBindingInput,
} from './inspection-binding.types';

type ChecklistTemplateRow = {
  id: string;
  client_id: string;
  status: string;
};

/**
 * BE-10B — Equipment Inspection Binding service.
 *
 * Binds BE-05 Assets to BE-07 Checklist Templates and starts executions on
 * the shared BE-07 execution table. Workflow, evidence, verification, and
 * findings all remain owned by BE-07 / BE-08 / BE-09 — this service only
 * validates and records the binding.
 *
 * Validation order (pinned by tests):
 *   1. unknown Asset                → 404 ASSET_NOT_FOUND
 *   2. inaccessible Asset Building  → 403 BUILDING_ACCESS_DENIED
 *   3. non-ACTIVE Asset             → 409 ASSET_RETIRED / 400 BAD_REQUEST
 *   4. unknown template             → 404 NOT_FOUND
 *   5. non-ACTIVE template          → 400 BAD_REQUEST
 *   6. cross-Client template        → 400 INSPECTION_TEMPLATE_CLIENT_MISMATCH
 *   7. unknown Functional Location  → 404 FUNCTIONAL_LOCATION_NOT_FOUND
 *   8. cross-Building location      → 400 INSPECTION_LOCATION_BUILDING_MISMATCH
 *   9. INACTIVE location            → 400 BAD_REQUEST
 *  10. duplicate ACTIVE binding     → 409 INSPECTION_BINDING_ALREADY_EXISTS
 */
export async function createInspectionBinding(
  input: CreateInspectionBindingInput,
  userId: string,
): Promise<PublicInspectionBinding> {
  const asset = await assetRepository.findById(input.assetId);
  if (!asset) {
    throw assetNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, asset.buildingId);
  assertOperationalAsset(asset.status);

  const template = await findChecklistTemplate(input.checklistTemplateId);
  assertUsableTemplate(template);

  const { clientId } = await resolveAssetBuildingContext(asset.buildingId);
  if (template.client_id !== clientId) {
    throw inspectionTemplateClientMismatchError();
  }

  const functionalLocationId = await assertInspectionLocation(
    input.functionalLocationId ?? null,
    asset.buildingId,
  );

  const existing = await inspectionBindingRepository.findActiveByAssetAndTemplate(
    asset.id,
    template.id,
  );
  if (existing) {
    throw inspectionBindingAlreadyExistsError();
  }

  try {
    const record = await inspectionBindingRepository.create({
      clientId,
      buildingId: asset.buildingId,
      assetId: asset.id,
      checklistTemplateId: template.id,
      functionalLocationId,
      status: input.status ?? 'ACTIVE',
      createdByUserId: userId,
    });
    return toPublicInspectionBinding(record);
  } catch (error) {
    if (isActiveBindingUniqueViolation(error)) {
      throw inspectionBindingAlreadyExistsError();
    }
    throw error;
  }
}

export async function getInspectionBinding(
  id: string,
  userId: string,
): Promise<PublicInspectionBinding> {
  const record = await inspectionBindingRepository.findById(id);
  if (!record) {
    throw inspectionBindingNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, record.buildingId);
  return toPublicInspectionBinding(record);
}

export async function listInspectionBindingsByAsset(
  assetId: string,
  userId: string,
): Promise<PublicInspectionBinding[]> {
  const asset = await assetRepository.findById(assetId);
  if (!asset) {
    throw assetNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, asset.buildingId);
  const records = await inspectionBindingRepository.listByAssetId(assetId);
  return records.map(toPublicInspectionBinding);
}

export async function listInspectionBindingsByBuilding(
  buildingId: string,
  userId: string,
): Promise<PublicInspectionBinding[]> {
  const building = await buildingService.getBuildingById(buildingId);
  await contextAccessService.assertBuildingAccess(userId, building.id);
  const records = await inspectionBindingRepository.listByBuildingId(building.id);
  return records.map(toPublicInspectionBinding);
}

export async function updateInspectionBinding(
  id: string,
  input: UpdateInspectionBindingInput,
  userId: string,
): Promise<PublicInspectionBinding> {
  const record = await inspectionBindingRepository.findById(id);
  if (!record) {
    throw inspectionBindingNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, record.buildingId);

  const functionalLocationId =
    input.functionalLocationId !== undefined
      ? await assertInspectionLocation(input.functionalLocationId, record.buildingId)
      : undefined;

  try {
    const updated = await inspectionBindingRepository.update(id, {
      ...(functionalLocationId === undefined ? {} : { functionalLocationId }),
      ...(input.status === undefined ? {} : { status: input.status }),
    });
    if (!updated) {
      throw inspectionBindingNotFoundError();
    }
    return toPublicInspectionBinding(updated);
  } catch (error) {
    if (isActiveBindingUniqueViolation(error)) {
      throw inspectionBindingAlreadyExistsError();
    }
    throw error;
  }
}

/**
 * Starts the shared BE-07 checklist execution for an ACTIVE binding. The
 * execution row lives on BE-07's own `checklist_executions` table and keeps
 * all BE-07 lifecycle behaviour (start / responses / complete / cancel).
 */
export async function startInspectionExecution(
  bindingId: string,
  userId: string,
): Promise<PublicInspectionExecution> {
  const binding = await inspectionBindingRepository.findById(bindingId);
  if (!binding) {
    throw inspectionBindingNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, binding.buildingId);
  if (binding.status !== 'ACTIVE') {
    throw inspectionBindingInactiveError();
  }

  const template = await findChecklistTemplate(binding.checklistTemplateId);
  assertUsableTemplate(template);

  const execution = await inspectionBindingRepository.insertExecution({
    bindingId: binding.id,
    clientId: binding.clientId,
    checklistTemplateId: template.id,
  });

  await recordOperationalEvent({
    clientId: binding.clientId,
    eventType: 'INSPECTION_EXECUTION_STARTED',
    entityType: 'CHECKLIST_EXECUTION',
    entityId: execution.id,
    actorUserId: userId,
    buildingId: binding.buildingId,
    summary: `Inspection execution started for asset ${binding.assetId}`,
    metadata: {
      inspectionBindingId: binding.id,
      assetId: binding.assetId,
      checklistTemplateId: template.id,
    },
  });

  return {
    id: execution.id,
    checklistTemplateId: execution.checklist_template_id,
    inspectionBindingId: execution.inspection_binding_id as string,
    status: execution.status,
    startedAt: execution.started_at ? execution.started_at.toISOString() : null,
    completedAt: execution.completed_at
      ? execution.completed_at.toISOString()
      : null,
    createdAt: execution.created_at.toISOString(),
    updatedAt: execution.updated_at.toISOString(),
  };
}

/** Resolves the Asset / Building context an inspection execution is tied to. */
export async function resolveInspectionExecutionContext(
  executionId: string,
  userId: string,
): Promise<PublicInspectionExecutionContext> {
  const row = await inspectionBindingRepository.findExecutionContext(executionId);
  if (!row || !row.inspection_binding_id) {
    throw inspectionExecutionNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, row.building_id as string);

  return toPublicInspectionExecutionContext(row);
}

/** BE-05 lifecycle governs binding eligibility: only ACTIVE assets bind. */
function assertOperationalAsset(status: string): void {
  if (status === 'RETIRED') {
    throw assetRetiredError();
  }
  if (status !== 'ACTIVE') {
    throw AppError.badRequest(
      'Assets must be ACTIVE to receive inspection bindings.',
    );
  }
}

async function findChecklistTemplate(
  templateId: string,
): Promise<ChecklistTemplateRow> {
  const result = await getPool().query<ChecklistTemplateRow>(
    `SELECT id, client_id, status FROM checklist_templates WHERE id = $1`,
    [templateId],
  );
  if (!result.rows[0]) {
    throw AppError.notFound('Checklist template not found.');
  }
  return result.rows[0];
}

/** BE-07 rule, unchanged: only an ACTIVE template can be executed/bound. */
function assertUsableTemplate(template: ChecklistTemplateRow): void {
  if (template.status !== 'ACTIVE') {
    throw AppError.badRequest('Checklist template is not active.');
  }
}

/**
 * Validates an optional BE-04 Functional Location refinement: it must exist,
 * sit in the Asset's own Building (cross-Building binding is rejected), and
 * be ACTIVE (the BE-04 convention for receiving new bindings).
 */
async function assertInspectionLocation(
  functionalLocationId: string | null,
  assetBuildingId: string,
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
  if (location.buildingId !== assetBuildingId) {
    throw inspectionLocationBuildingMismatchError();
  }
  if (location.status !== 'ACTIVE') {
    throw AppError.badRequest(
      'Inactive functional locations cannot receive inspection bindings.',
    );
  }
  return location.id;
}

function isActiveBindingUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint === 'inspection_binding_active_unique'
  );
}

export function toPublicInspectionBinding(
  record: InspectionBindingRecord,
): PublicInspectionBinding {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    assetId: record.assetId,
    checklistTemplateId: record.checklistTemplateId,
    functionalLocationId: record.functionalLocationId,
    status: record.status,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function toPublicInspectionExecutionContext(
  row: ExecutionContextRow,
): PublicInspectionExecutionContext {
  return {
    execution: {
      id: row.execution_id,
      checklistTemplateId: row.execution_checklist_template_id,
      inspectionBindingId: row.inspection_binding_id as string,
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
    asset: {
      id: row.asset_id as string,
      assetCode: row.asset_code as string,
      assetName: row.asset_name as string,
      status: row.asset_status as string,
    },
    building: {
      id: row.building_id as string,
      code: row.building_code as string,
      name: row.building_name as string,
    },
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

export const inspectionBindingService = {
  createInspectionBinding,
  getInspectionBinding,
  listInspectionBindingsByAsset,
  listInspectionBindingsByBuilding,
  resolveInspectionExecutionContext,
  startInspectionExecution,
  updateInspectionBinding,
};
