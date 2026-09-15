import { AppError } from '../../shared/errors';
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
  logSheetBindingAlreadyExistsError,
  logSheetBindingInactiveError,
  logSheetBindingNotFoundError,
  logSheetExecutionNotFoundError,
  logSheetLocationBuildingMismatchError,
  logSheetTemplateClientMismatchError,
  logSheetUomClientMismatchError,
  logSheetUomInactiveError,
  logSheetVersionTemplateMismatchError,
} from './log-sheet-binding.errors';
import {
  logSheetBindingRepository,
  type ExecutionContextRow,
  type ExecutionRow,
  type LogSheetTemplateRow,
  type LogSheetVersionRow,
  type MeasurementFieldRow,
} from './log-sheet-binding.repository';
import {
  type CreateLogSheetBindingInput,
  type LogSheetBindingRecord,
  type PublicLogSheetBinding,
  type PublicLogSheetExecutionContext,
  type PublicLogSheetExecution,
  type UpdateLogSheetBindingInput,
} from './log-sheet-binding.types';

/**
 * BE-10D — Equipment Log Sheet Binding service.
 *
 * Binds BE-05 Assets to BE-07 Form Templates (log sheet definitions) and
 * starts executions on the shared BE-07 Form Instance. Log rows are BE-07
 * responses — this service only validates and records the binding and reads
 * execution history back. No log sheet form, measurement, or execution
 * engine exists here.
 *
 * Validation order (pinned by tests):
 *   1. unknown Asset                 → 404 ASSET_NOT_FOUND
 *   2. inaccessible Asset Building   → 403 BUILDING_ACCESS_DENIED
 *   3. non-ACTIVE Asset              → 409 ASSET_RETIRED / 400 BAD_REQUEST
 *   4. unknown template              → 404 NOT_FOUND
 *   5. non-ACTIVE template           → 400 BAD_REQUEST
 *   6. cross-Client template         → 400 LOG_SHEET_TEMPLATE_CLIENT_MISMATCH
 *   7. unknown version               → 404 NOT_FOUND
 *   8. version of another template   → 400 LOG_SHEET_VERSION_TEMPLATE_MISMATCH
 *   9. non-PUBLISHED version         → 400 BAD_REQUEST
 *  10. version contains no fields    → 400 BAD_REQUEST
 *  11. measurement field UOM invalid → 400 LOG_SHEET_UOM_INACTIVE / CLIENT_MISMATCH
 *  12. unknown / cross-Building /
 *      INACTIVE Functional Location  → 404 / 400 / 400
 *  13. duplicate ACTIVE binding      → 409 LOG_SHEET_BINDING_ALREADY_EXISTS
 */
export async function createLogSheetBinding(
  input: CreateLogSheetBindingInput,
  userId: string,
): Promise<PublicLogSheetBinding> {
  const asset = await assetRepository.findById(input.assetId);
  if (!asset) {
    throw assetNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, asset.buildingId);
  assertOperationalAsset(asset.status);

  const template = await assertLogSheetTemplate(input.formTemplateId);
  const { clientId } = await resolveAssetBuildingContext(asset.buildingId);
  if (template.client_id !== clientId) {
    throw logSheetTemplateClientMismatchError();
  }

  const versionId = await assertLogSheetVersion(
    input.formTemplateVersionId ?? null,
    template,
    clientId,
  );

  const functionalLocationId = await assertLogSheetLocation(
    input.functionalLocationId ?? null,
    asset.buildingId,
  );

  const existing = await logSheetBindingRepository.findActiveByAssetAndTemplate(
    asset.id,
    template.id,
  );
  if (existing) {
    throw logSheetBindingAlreadyExistsError();
  }

  try {
    const record = await logSheetBindingRepository.create({
      clientId,
      buildingId: asset.buildingId,
      assetId: asset.id,
      formTemplateId: template.id,
      formTemplateVersionId: versionId,
      functionalLocationId,
      status: input.status ?? 'ACTIVE',
      createdByUserId: userId,
    });
    return toPublicLogSheetBinding(record);
  } catch (error) {
    if (isActiveBindingUniqueViolation(error)) {
      throw logSheetBindingAlreadyExistsError();
    }
    throw error;
  }
}

export async function getLogSheetBinding(
  id: string,
  userId: string,
): Promise<PublicLogSheetBinding> {
  const record = await logSheetBindingRepository.findById(id);
  if (!record) {
    throw logSheetBindingNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, record.buildingId);
  return toPublicLogSheetBinding(record);
}

export async function listLogSheetBindingsByAsset(
  assetId: string,
  userId: string,
): Promise<PublicLogSheetBinding[]> {
  const asset = await assetRepository.findById(assetId);
  if (!asset) {
    throw assetNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, asset.buildingId);
  const records = await logSheetBindingRepository.listByAssetId(assetId);
  return records.map(toPublicLogSheetBinding);
}

export async function listLogSheetBindingsByBuilding(
  buildingId: string,
  userId: string,
): Promise<PublicLogSheetBinding[]> {
  const building = await buildingService.getBuildingById(buildingId);
  await contextAccessService.assertBuildingAccess(userId, building.id);
  const records = await logSheetBindingRepository.listByBuildingId(building.id);
  return records.map(toPublicLogSheetBinding);
}

export async function updateLogSheetBinding(
  id: string,
  input: UpdateLogSheetBindingInput,
  userId: string,
): Promise<PublicLogSheetBinding> {
  const existing = await logSheetBindingRepository.findById(id);
  if (!existing) {
    throw logSheetBindingNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, existing.buildingId);

  const template = await logSheetBindingRepository.findTemplate(
    existing.formTemplateId,
  );

  const versionId =
    input.formTemplateVersionId !== undefined
      ? await assertLogSheetVersion(
          input.formTemplateVersionId,
          template ?? undefined,
          existing.clientId,
        )
      : undefined;

  const functionalLocationId =
    input.functionalLocationId !== undefined
      ? await assertLogSheetLocation(
          input.functionalLocationId,
          existing.buildingId,
        )
      : undefined;

  try {
    const updated = await logSheetBindingRepository.update(id, {
      ...(versionId === undefined ? {} : { formTemplateVersionId: versionId }),
      ...(functionalLocationId === undefined ? {} : { functionalLocationId }),
      ...(input.status === undefined ? {} : { status: input.status }),
    });
    if (!updated) {
      throw logSheetBindingNotFoundError();
    }
    return toPublicLogSheetBinding(updated);
  } catch (error) {
    if (isActiveBindingUniqueViolation(error)) {
      throw logSheetBindingAlreadyExistsError();
    }
    throw error;
  }
}

/**
 * Starts the shared BE-07 form instance for an ACTIVE binding. The instance
 * lives on BE-07's own `form_instances` table and keeps all BE-07 lifecycle
 * behaviour (start / responses / complete / cancel).
 */
export async function startLogSheetExecution(
  bindingId: string,
  userId: string,
): Promise<PublicLogSheetExecution> {
  const binding = await logSheetBindingRepository.findById(bindingId);
  if (!binding) {
    throw logSheetBindingNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, binding.buildingId);
  if (binding.status !== 'ACTIVE') {
    throw logSheetBindingInactiveError();
  }

  const template = await logSheetBindingRepository.findTemplate(
    binding.formTemplateId,
  );
  if (!template || template.status !== 'ACTIVE') {
    throw AppError.badRequest('Log sheet template is not active.');
  }

  let version = binding.formTemplateVersionId
    ? await logSheetBindingRepository.findVersion(binding.formTemplateVersionId)
    : null;
  if (!version && !binding.formTemplateVersionId) {
    const latest = await logSheetBindingRepository.findLatestPublishedVersion(
      binding.formTemplateId,
    );
    version = latest
      ? {
          id: latest.id,
          form_template_id: binding.formTemplateId,
          version_number: latest.versionNumber,
          status: 'PUBLISHED',
          client_id: binding.clientId,
        }
      : null;
  }
  if (!version) {
    throw AppError.badRequest('No published template version exists for the log sheet template.');
  }
  if (version.form_template_id !== binding.formTemplateId) {
    throw logSheetVersionTemplateMismatchError();
  }
  if (version.status !== 'PUBLISHED') {
    throw AppError.badRequest('Only published template versions can start log sheet executions.');
  }

  const execution = await logSheetBindingRepository.insertExecution({
    bindingId: binding.id,
    clientId: binding.clientId,
    versionId: version.id,
  });

  await recordOperationalEvent({
    clientId: binding.clientId,
    eventType: 'LOG_SHEET_EXECUTION_STARTED',
    entityType: 'FORM_INSTANCE',
    entityId: execution.id,
    actorUserId: userId,
    buildingId: binding.buildingId,
    summary: `Log sheet execution started for asset ${binding.assetId}`,
    metadata: {
      logSheetBindingId: binding.id,
      assetId: binding.assetId,
      formTemplateId: binding.formTemplateId,
      formTemplateVersionId: version.id,
    },
  });

  return toPublicLogSheetExecution(execution, binding.id);
}

/** Historical execution references for a binding (BE-07 instances). */
export async function listLogSheetExecutions(
  bindingId: string,
  userId: string,
): Promise<PublicLogSheetExecution[]> {
  const binding = await logSheetBindingRepository.findById(bindingId);
  if (!binding) {
    throw logSheetBindingNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, binding.buildingId);
  const executions = await logSheetBindingRepository.listExecutionsByBinding(
    binding.id,
  );
  return executions.map((execution) =>
    toPublicLogSheetExecution(execution, binding.id),
  );
}

/** Resolves the Asset / Building / template context a log sheet execution is tied to. */
export async function resolveLogSheetExecutionContext(
  executionId: string,
  userId: string,
): Promise<PublicLogSheetExecutionContext> {
  const row = await logSheetBindingRepository.findExecutionContext(executionId);
  if (!row || !row.log_sheet_binding_id) {
    throw logSheetExecutionNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, row.building_id as string);

  return {
    execution: {
      id: row.execution_id,
      formTemplateVersionId: row.execution_version_id,
      logSheetBindingId: row.log_sheet_binding_id,
      status: row.execution_status,
      startedAt: row.execution_started_at ? row.execution_started_at.toISOString() : null,
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
    template: {
      id: row.template_id as string,
      code: row.template_code as string,
      name: row.template_name as string,
    },
    version: {
      id: row.execution_version_id,
      versionNumber: row.version_number as number,
      status: row.version_status as string,
    },
  };
}

/** BE-05 lifecycle governs binding eligibility: only ACTIVE assets bind. */
function assertOperationalAsset(status: string): void {
  if (status === 'RETIRED') {
    throw assetRetiredError();
  }
  if (status !== 'ACTIVE') {
    throw AppError.badRequest(
      'Assets must be ACTIVE to receive log sheet bindings.',
    );
  }
}

/** BE-07 rule, unchanged: only an ACTIVE template can be bound/executed. */
async function assertLogSheetTemplate(
  templateId: string,
): Promise<LogSheetTemplateRow> {
  const template = await logSheetBindingRepository.findTemplate(templateId);
  if (!template) {
    throw AppError.notFound('Log sheet template not found.');
  }
  if (template.status !== 'ACTIVE') {
    throw AppError.badRequest('Log sheet template is not active.');
  }
  return template;
}

/**
 * Validates the optional bound Template Version: exists, belongs to the
 * template, PUBLISHED, contains fields, and every configured measurement
 * field references a valid, same-Client, ACTIVE UOM. When no version is
 * supplied, the template's own ACTIVE measurement fields are checked and
 * NULL is returned (the latest published version is resolved at execution
 * start).
 */
async function assertLogSheetVersion(
  versionId: string | null,
  template: LogSheetTemplateRow | undefined,
  clientId: string,
): Promise<string | null> {
  if (!versionId) {
    if (template) {
      const templateFields =
        await logSheetBindingRepository.listTemplateMeasurementFields(
          template.id,
        );
      await assertMeasurementUoms(templateFields, clientId);
    }
    return null;
  }

  const version = await logSheetBindingRepository.findVersion(versionId);
  if (!version) {
    throw AppError.notFound('Form template version not found.');
  }
  if (template && version.form_template_id !== template.id) {
    throw logSheetVersionTemplateMismatchError();
  }
  if (version.status !== 'PUBLISHED') {
    throw AppError.badRequest('Only published template versions can be bound.');
  }
  const fieldCount = await logSheetBindingRepository.countVersionFields(
    version.id,
  );
  if (fieldCount === 0) {
    throw AppError.badRequest('Selected version contains no fields.');
  }
  const versionFields =
    await logSheetBindingRepository.listVersionMeasurementFields(version.id);
  await assertMeasurementUoms(versionFields, clientId);
  return version.id;
}

/** Every configured measurement field must use a valid, same-Client, ACTIVE UOM. */
async function assertMeasurementUoms(
  fields: MeasurementFieldRow[],
  clientId: string,
): Promise<void> {
  for (const field of fields) {
    if (!field.uom_id) {
      continue;
    }
    const uom = await logSheetBindingRepository.findUom(field.uom_id);
    if (!uom) {
      throw AppError.notFound('UOM not found.');
    }
    if (uom.status !== 'ACTIVE') {
      throw logSheetUomInactiveError();
    }
    if (uom.client_id !== clientId) {
      throw logSheetUomClientMismatchError();
    }
  }
}

/**
 * Validates an optional BE-04 Functional Location refinement (same rules as
 * BE-10B/BE-10C: exists, same Building, ACTIVE).
 */
async function assertLogSheetLocation(
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
    throw logSheetLocationBuildingMismatchError();
  }
  if (location.status !== 'ACTIVE') {
    throw AppError.badRequest(
      'Inactive functional locations cannot receive log sheet bindings.',
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
    candidate.constraint === 'log_sheet_binding_active_unique'
  );
}

export function toPublicLogSheetBinding(
  record: LogSheetBindingRecord,
): PublicLogSheetBinding {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    assetId: record.assetId,
    formTemplateId: record.formTemplateId,
    formTemplateVersionId: record.formTemplateVersionId,
    functionalLocationId: record.functionalLocationId,
    status: record.status,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function toPublicLogSheetExecution(
  execution: ExecutionRow,
  bindingId: string,
): PublicLogSheetExecution {
  return {
    id: execution.id,
    formTemplateVersionId: execution.form_template_version_id,
    logSheetBindingId: bindingId,
    status: execution.status,
    startedAt: execution.started_at ? execution.started_at.toISOString() : null,
    completedAt: execution.completed_at
      ? execution.completed_at.toISOString()
      : null,
    createdAt: execution.created_at.toISOString(),
    updatedAt: execution.updated_at.toISOString(),
  };
}

export const logSheetBindingService = {
  createLogSheetBinding,
  getLogSheetBinding,
  listLogSheetBindingsByAsset,
  listLogSheetBindingsByBuilding,
  listLogSheetExecutions,
  resolveLogSheetExecutionContext,
  startLogSheetExecution,
  updateLogSheetBinding,
};
