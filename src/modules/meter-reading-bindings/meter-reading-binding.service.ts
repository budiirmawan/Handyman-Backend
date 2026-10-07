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
  meterReadingBindingAlreadyExistsError,
  meterReadingBindingInactiveError,
  meterReadingBindingNotFoundError,
  meterReadingExecutionNotFoundError,
  meterReadingFieldClientMismatchError,
  meterReadingLocationBuildingMismatchError,
  meterReadingOutOfRangeError,
  meterReadingUomClientMismatchError,
  meterReadingUomInactiveError,
} from './meter-reading-binding.errors';
import {
  meterReadingBindingRepository,
  type ExecutionContextRow,
  type ReadingFieldRow,
  type UomRow,
} from './meter-reading-binding.repository';
import {
  type CreateMeterReadingBindingInput,
  type MeterReadingBindingRecord,
  type PublicMeterReading,
  type PublicMeterReadingBinding,
  type PublicMeterReadingContext,
  type PublicMeterReadingExecution,
  type UpdateMeterReadingBindingInput,
} from './meter-reading-binding.types';

/**
 * BE-10C — Meter Reading Binding service.
 *
 * Binds BE-05 Assets to BE-07 numeric Form Fields (meter-reading
 * definitions), starts readings on the shared BE-07 Form Instance, and
 * submits numeric readings into BE-07's own `form_responses` store. No
 * second response or measurement service exists; UOM / min / max /
 * precision remain BE-07's measurement configuration, tightened (never
 * widened) per binding.
 *
 * Validation order (pinned by tests):
 *   1. unknown Asset                → 404 ASSET_NOT_FOUND
 *   2. inaccessible Asset Building  → 403 BUILDING_ACCESS_DENIED
 *   3. non-ACTIVE Asset             → 409 ASSET_RETIRED / 400 BAD_REQUEST
 *   4. unknown reading field        → 404 NOT_FOUND
 *   5. non-NUMBER / INACTIVE field  → 400 BAD_REQUEST
 *   6. cross-Client field           → 400 METER_READING_FIELD_CLIENT_MISMATCH
 *   7. missing / unknown UOM        → 400 BAD_REQUEST / 404 NOT_FOUND
 *   8. INACTIVE UOM                 → 400 METER_READING_UOM_INACTIVE
 *   9. cross-Client UOM             → 400 METER_READING_UOM_CLIENT_MISMATCH
 *  10. range widening beyond field  → 400 BAD_REQUEST
 *  11. unknown / cross-Building /
 *      INACTIVE Functional Location → 404 / 400 / 400
 *  12. duplicate ACTIVE binding     → 409 METER_READING_BINDING_ALREADY_EXISTS
 */
export async function createMeterReadingBinding(
  input: CreateMeterReadingBindingInput,
  userId: string,
): Promise<PublicMeterReadingBinding> {
  const asset = await assetRepository.findById(input.assetId);
  if (!asset) {
    throw assetNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, asset.buildingId);
  assertOperationalAsset(asset.status);

  const field = await assertReadingField(input.formFieldId);
  const { clientId } = await resolveAssetBuildingContext(asset.buildingId);
  if (field.client_id !== clientId) {
    throw meterReadingFieldClientMismatchError();
  }

  const uom = await resolveUom(input.uomId ?? field.uom_id, clientId);
  const functionalLocationId = await assertReadingLocation(
    input.functionalLocationId ?? null,
    asset.buildingId,
  );

  const { minimumValue, maximumValue } = assertEffectiveRange(
    input.minimumValue,
    input.maximumValue,
    field,
  );

  const existing = await meterReadingBindingRepository.findActiveByAssetAndField(
    asset.id,
    field.id,
  );
  if (existing) {
    throw meterReadingBindingAlreadyExistsError();
  }

  try {
    const record = await meterReadingBindingRepository.create({
      clientId,
      buildingId: asset.buildingId,
      assetId: asset.id,
      formFieldId: field.id,
      uomId: uom.id,
      functionalLocationId,
      minimumValue,
      maximumValue,
      status: input.status ?? 'ACTIVE',
      createdByUserId: userId,
    });
    return toPublicMeterReadingBinding(record);
  } catch (error) {
    if (isActiveBindingUniqueViolation(error)) {
      throw meterReadingBindingAlreadyExistsError();
    }
    throw error;
  }
}

export async function getMeterReadingBinding(
  id: string,
  userId: string,
): Promise<PublicMeterReadingBinding> {
  const record = await meterReadingBindingRepository.findById(id);
  if (!record) {
    throw meterReadingBindingNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, record.buildingId);
  return toPublicMeterReadingBinding(record);
}

export async function listMeterReadingBindingsByAsset(
  assetId: string,
  userId: string,
): Promise<PublicMeterReadingBinding[]> {
  const asset = await assetRepository.findById(assetId);
  if (!asset) {
    throw assetNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, asset.buildingId);
  const records = await meterReadingBindingRepository.listByAssetId(assetId);
  return records.map(toPublicMeterReadingBinding);
}

export async function listMeterReadingBindingsByBuilding(
  buildingId: string,
  userId: string,
): Promise<PublicMeterReadingBinding[]> {
  const building = await buildingService.getBuildingById(buildingId);
  await contextAccessService.assertBuildingAccess(userId, building.id);
  const records = await meterReadingBindingRepository.listByBuildingId(building.id);
  return records.map(toPublicMeterReadingBinding);
}

export async function updateMeterReadingBinding(
  id: string,
  input: UpdateMeterReadingBindingInput,
  userId: string,
): Promise<PublicMeterReadingBinding> {
  const existing = await meterReadingBindingRepository.findById(id);
  if (!existing) {
    throw meterReadingBindingNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, existing.buildingId);

  const field = await assertReadingField(existing.formFieldId);

  let uomId: string | undefined;
  if (input.uomId !== undefined) {
    const uom = await resolveUom(input.uomId, existing.clientId);
    uomId = uom.id;
  }

  const functionalLocationId =
    input.functionalLocationId !== undefined
      ? await assertReadingLocation(
          input.functionalLocationId,
          existing.buildingId,
        )
      : undefined;

  const minimumValue =
    input.minimumValue !== undefined ? input.minimumValue : toNumber(existing.minimumValue);
  const maximumValue =
    input.maximumValue !== undefined ? input.maximumValue : toNumber(existing.maximumValue);
  if (minimumValue !== null && maximumValue !== null && minimumValue > maximumValue) {
    throw AppError.badRequest('minimumValue must not exceed maximumValue.');
  }
  // The binding may tighten, never widen, the BE-07 configured field range.
  const fieldMin = toNumber(field.minimum_value);
  const fieldMax = toNumber(field.maximum_value);
  if (fieldMin !== null && minimumValue !== null && minimumValue < fieldMin) {
    throw AppError.badRequest('Binding minimumValue must not be below the field minimum.');
  }
  if (fieldMax !== null && maximumValue !== null && maximumValue > fieldMax) {
    throw AppError.badRequest('Binding maximumValue must not exceed the field maximum.');
  }

  try {
    const updated = await meterReadingBindingRepository.update(id, {
      ...(uomId === undefined ? {} : { uomId }),
      ...(functionalLocationId === undefined ? {} : { functionalLocationId }),
      ...(input.minimumValue === undefined ? {} : { minimumValue: input.minimumValue }),
      ...(input.maximumValue === undefined ? {} : { maximumValue: input.maximumValue }),
      ...(input.status === undefined ? {} : { status: input.status }),
    });
    if (!updated) {
      throw meterReadingBindingNotFoundError();
    }
    return toPublicMeterReadingBinding(updated);
  } catch (error) {
    if (isActiveBindingUniqueViolation(error)) {
      throw meterReadingBindingAlreadyExistsError();
    }
    throw error;
  }
}

/**
 * Starts the shared BE-07 form instance for an ACTIVE binding. The instance
 * lives on BE-07's own `form_instances` table and keeps all BE-07 lifecycle
 * behaviour (start / responses / complete / cancel).
 */
export async function startMeterReadingExecution(
  bindingId: string,
  userId: string,
): Promise<PublicMeterReadingExecution> {
  const binding = await meterReadingBindingRepository.findById(bindingId);
  if (!binding) {
    throw meterReadingBindingNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, binding.buildingId);
  if (binding.status !== 'ACTIVE') {
    throw meterReadingBindingInactiveError();
  }

  const field = await assertReadingField(binding.formFieldId);
  const version = await meterReadingBindingRepository.findLatestPublishedVersion(
    field.template_id,
  );
  if (!version) {
    throw AppError.badRequest('No published template version exists for the reading field.');
  }
  const versionField = await meterReadingBindingRepository.findVersionField(
    version.id,
    field.id,
  );
  if (!versionField) {
    throw AppError.badRequest('Published version does not contain the reading field.');
  }

  const execution = await meterReadingBindingRepository.insertExecution({
    bindingId: binding.id,
    clientId: binding.clientId,
    versionId: version.id,
  });

  await recordOperationalEvent({
    clientId: binding.clientId,
    eventType: 'METER_READING_EXECUTION_STARTED',
    entityType: 'FORM_INSTANCE',
    entityId: execution.id,
    actorUserId: userId,
    buildingId: binding.buildingId,
    summary: `Meter reading execution started for asset ${binding.assetId}`,
    metadata: {
      meterReadingBindingId: binding.id,
      assetId: binding.assetId,
      formFieldId: binding.formFieldId,
      uomId: binding.uomId,
    },
  });

  return toPublicMeterReadingExecution(execution, binding.id);
}

/**
 * Submits the numeric reading into BE-07's own `form_responses` store.
 * Measurement rules (configured min/max/precision from the binding and the
 * BE-07 field) are enforced here — backend authority — using the same table
 * and upsert idiom as BE-07's response save.
 */
export async function submitMeterReading(
  executionId: string,
  userId: string,
  input: { value: number; notes: string | null },
): Promise<PublicMeterReading> {
  const execution = await meterReadingBindingRepository.findExecution(executionId);
  if (!execution || !execution.meter_reading_binding_id) {
    throw meterReadingExecutionNotFoundError();
  }
  const binding = await meterReadingBindingRepository.findById(
    execution.meter_reading_binding_id,
  );
  if (!binding) {
    throw meterReadingBindingNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, binding.buildingId);

  if (execution.status === 'COMPLETED' || execution.status === 'CANCELLED') {
    throw AppError.badRequest('Terminal instances cannot be modified.');
  }

  const field = await assertReadingField(binding.formFieldId);
  const versionField = await meterReadingBindingRepository.findVersionField(
    execution.form_template_version_id,
    binding.formFieldId,
  );
  if (!versionField) {
    throw AppError.badRequest('Execution version does not contain the reading field.');
  }

  if (field.decimal_precision !== null) {
    const decimals = countDecimals(input.value);
    if (decimals > field.decimal_precision) {
      throw AppError.badRequest(
        `Reading exceeds the configured decimal precision (${field.decimal_precision}).`,
      );
    }
  }

  const minimumValue = toNumber(binding.minimumValue) ?? toNumber(field.minimum_value);
  const maximumValue = toNumber(binding.maximumValue) ?? toNumber(field.maximum_value);
  if (
    (minimumValue !== null && input.value < minimumValue) ||
    (maximumValue !== null && input.value > maximumValue)
  ) {
    throw meterReadingOutOfRangeError(input.value, minimumValue, maximumValue);
  }

  const written = await meterReadingBindingRepository.upsertReadingResponse({
    formInstanceId: execution.id,
    versionFieldId: versionField.id,
    value: input.value,
  });

  const uom = await meterReadingBindingRepository.findUom(binding.uomId);

  await recordOperationalEvent({
    clientId: binding.clientId,
    eventType: 'METER_READING_SUBMITTED',
    entityType: 'FORM_INSTANCE',
    entityId: execution.id,
    actorUserId: userId,
    buildingId: binding.buildingId,
    summary: `Meter reading submitted for asset ${binding.assetId}`,
    metadata: {
      meterReadingBindingId: binding.id,
      assetId: binding.assetId,
      uomId: binding.uomId,
      value: input.value,
    },
  });

  return {
    executionId: execution.id,
    formInstanceId: execution.id,
    versionFieldId: versionField.id,
    value: written.value,
    uom: {
      id: binding.uomId,
      code: uom?.code ?? '',
      symbol: uom?.symbol ?? '',
    },
    minimumValue,
    maximumValue,
    notes: input.notes,
    submittedAt: written.updatedAt.toISOString(),
  };
}

/** Resolves the Asset / Building / UOM context a reading execution is tied to. */
export async function resolveMeterReadingContext(
  executionId: string,
  userId: string,
): Promise<PublicMeterReadingContext> {
  const row = await meterReadingBindingRepository.findExecutionContext(executionId);
  if (!row || !row.meter_reading_binding_id) {
    throw meterReadingExecutionNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, row.building_id as string);

  return {
    execution: {
      id: row.execution_id,
      formTemplateVersionId: row.execution_version_id,
      meterReadingBindingId: row.meter_reading_binding_id,
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
    uom: {
      id: row.uom_id as string,
      code: row.uom_code as string,
      name: row.uom_name as string,
      symbol: row.uom_symbol as string,
    },
    // Effective range: the binding's tightening, falling back to the BE-07
    // field's own configured measurement range.
    minimumValue:
      toNumber(row.binding_minimum_value) ?? toNumber(row.field_minimum_value),
    maximumValue:
      toNumber(row.binding_maximum_value) ?? toNumber(row.field_maximum_value),
    currentValue:
      row.current_value === null || row.current_value === undefined
        ? null
        : Number(row.current_value),
  };
}

/** BE-05 lifecycle governs binding eligibility: only ACTIVE assets bind. */
function assertOperationalAsset(status: string): void {
  if (status === 'RETIRED') {
    throw assetRetiredError();
  }
  if (status !== 'ACTIVE') {
    throw AppError.badRequest(
      'Assets must be ACTIVE to receive meter reading bindings.',
    );
  }
}

/** The reading field must exist, be NUMBER, and be ACTIVE (BE-07 rules). */
async function assertReadingField(formFieldId: string): Promise<ReadingFieldRow> {
  const field = await meterReadingBindingRepository.findReadingField(formFieldId);
  if (!field) {
    throw AppError.notFound('Reading field not found.');
  }
  if (field.field_type !== 'NUMBER') {
    throw AppError.badRequest('Reading field must be numeric (NUMBER).');
  }
  if (field.status !== 'ACTIVE') {
    throw AppError.badRequest('Reading field is not active.');
  }
  return field;
}

async function resolveUom(
  uomId: string | null,
  clientId: string,
): Promise<UomRow> {
  if (!uomId) {
    throw AppError.badRequest('Reading field has no unit of measure configured.');
  }
  const uom = await meterReadingBindingRepository.findUom(uomId);
  if (!uom) {
    throw AppError.notFound('UOM not found.');
  }
  if (uom.status !== 'ACTIVE') {
    throw meterReadingUomInactiveError();
  }
  if (uom.client_id !== clientId) {
    throw meterReadingUomClientMismatchError();
  }
  return uom;
}

/**
 * Validates an optional BE-04 Functional Location refinement (same rules as
 * BE-10B: exists, same Building, ACTIVE).
 */
async function assertReadingLocation(
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
    throw meterReadingLocationBuildingMismatchError();
  }
  if (location.status !== 'ACTIVE') {
    throw AppError.badRequest(
      'Inactive functional locations cannot receive meter reading bindings.',
    );
  }
  return location.id;
}

/**
 * The binding may tighten, never widen, the BE-07 configured field range.
 * Returns the effective (normalized to number | null) range to store.
 */
function assertEffectiveRange(
  minimumValue: number | undefined,
  maximumValue: number | undefined,
  field: ReadingFieldRow,
): { minimumValue: number | null; maximumValue: number | null } {
  const fieldMin = toNumber(field.minimum_value);
  const fieldMax = toNumber(field.maximum_value);

  const minimum = minimumValue ?? null;
  const maximum = maximumValue ?? null;

  if (minimum !== null && fieldMin !== null && minimum < fieldMin) {
    throw AppError.badRequest('Binding minimumValue must not be below the field minimum.');
  }
  if (maximum !== null && fieldMax !== null && maximum > fieldMax) {
    throw AppError.badRequest('Binding maximumValue must not exceed the field maximum.');
  }
  if (minimum !== null && maximum !== null && minimum > maximum) {
    throw AppError.badRequest('minimumValue must not exceed maximumValue.');
  }

  return { minimumValue: minimum, maximumValue: maximum };
}

/** pg NUMERIC arrives as a string; normalize to number | null. */
function toNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return Number(value);
}

/** Decimal places of a plain-decimal number (scientific notation is rare in meter readings). */
function countDecimals(value: number): number {
  const text = String(value);
  const fraction = text.split('.')[1];
  return fraction ? fraction.length : 0;
}

function isActiveBindingUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint === 'meter_reading_binding_active_unique'
  );
}

export function toPublicMeterReadingBinding(
  record: MeterReadingBindingRecord,
): PublicMeterReadingBinding {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    assetId: record.assetId,
    formFieldId: record.formFieldId,
    uomId: record.uomId,
    functionalLocationId: record.functionalLocationId,
    minimumValue: toNumber(record.minimumValue),
    maximumValue: toNumber(record.maximumValue),
    status: record.status,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function toPublicMeterReadingExecution(
  execution: { id: string; form_template_version_id: string; status: string; started_at: Date | null; completed_at: Date | null; created_at: Date; updated_at: Date },
  bindingId: string,
): PublicMeterReadingExecution {
  return {
    id: execution.id,
    formTemplateVersionId: execution.form_template_version_id,
    meterReadingBindingId: bindingId,
    status: execution.status,
    startedAt: execution.started_at ? execution.started_at.toISOString() : null,
    completedAt: execution.completed_at
      ? execution.completed_at.toISOString()
      : null,
    createdAt: execution.created_at.toISOString(),
    updatedAt: execution.updated_at.toISOString(),
  };
}

export const meterReadingBindingService = {
  createMeterReadingBinding,
  getMeterReadingBinding,
  listMeterReadingBindingsByAsset,
  listMeterReadingBindingsByBuilding,
  resolveMeterReadingContext,
  startMeterReadingExecution,
  submitMeterReading,
  updateMeterReadingBinding,
};
