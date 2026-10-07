import {
  assetCategoryClientMismatchError,
  assetCategoryInactiveError,
  assetCategoryNotFoundError,
  assetCategoryRepository,
} from '../asset-categories';
import {
  assetTypeCategoryMismatchError,
  assetTypeInactiveError,
  assetTypeNotFoundError,
  assetTypeRepository,
} from '../asset-types';
import {
  changedFieldNames,
  diffFields,
  recordAssetHistory,
} from '../asset-history';
import { buildingNotFoundError, buildingRepository } from '../buildings';
import {
  functionalLocationNotFoundError,
  functionalLocationRepository,
} from '../functional-locations';
import {
  resolveBuildingContext,
  resolveFunctionalLocationContext,
  type OperationalContext,
} from '../structure-context';
import { propertyNotFoundError, propertyRepository } from '../properties';
import {
  assetBuildingInactiveError,
  assetCodeAlreadyExistsError,
  assetLocationBuildingMismatchError,
  assetLocationInactiveError,
  assetNotFoundError,
  assetRetiredError,
  assetSerialNumberAlreadyExistsError,
  assetStatusTransitionNotAllowedError,
} from './asset.errors';
import { assetRepository } from './asset.repository';
import {
  ASSET_STATUS_TRANSITIONS,
  isAllowedAssetStatusTransition,
  isTerminalAssetStatus,
} from './asset.types';
import type {
  AssetLifecycleStatus,
  AssetRecord,
  AssetStatus,
  CreateAssetInput,
  PublicAsset,
  UpdateAssetInput,
  UpdateAssetLocationInput,
  UpdateAssetStatusInput,
} from './asset.types';

export function toPublicAsset(record: AssetRecord): PublicAsset {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    assetCategoryId: record.assetCategoryId,
    assetTypeId: record.assetTypeId,
    functionalLocationId: record.functionalLocationId,
    assetCode: record.assetCode,
    assetName: record.assetName,
    description: record.description,
    manufacturer: record.manufacturer,
    model: record.model,
    serialNumber: record.serialNumber,
    status: record.status,
    previousStatus: record.previousStatus,
    statusChangedAt: toIsoString(record.statusChangedAt),
    statusReason: record.statusReason,
  };
}

function toIsoString(value: Date | null): string | null {
  return value ? new Date(value).toISOString() : null;
}

/**
 * Resolves the Client that authoritatively owns a Building
 * (Building → Property → Client, BE-02).
 *
 * This is the ONLY place an Asset obtains its `client_id`. A caller-supplied
 * client id is never accepted, so the denormalized `assets.client_id` can
 * never contradict Building ownership.
 */
export async function resolveAssetBuildingContext(buildingId: string): Promise<{
  clientId: string;
  buildingStatus: string;
}> {
  const building = await buildingRepository.findById(buildingId);
  if (!building) {
    throw buildingNotFoundError();
  }

  const property = await propertyRepository.findById(building.propertyId);
  if (!property) {
    // A Building always points at a real Property (enforced by FK), so this is
    // a data-integrity fault rather than a caller error.
    throw propertyNotFoundError();
  }

  return { clientId: property.clientId, buildingStatus: building.status };
}

/**
 * Registers an Asset under a Building. The owning Client is derived, never
 * supplied.
 *
 * Validation order (pinned by tests):
 *   1. unknown Building                     → 404 BUILDING_NOT_FOUND
 *   2. INACTIVE Building                    → 400 BUILDING_NOT_AVAILABLE
 *   3. duplicate asset code for Client      → 409 ASSET_CODE_ALREADY_EXISTS
 *   4. duplicate serial number for Client   → 409 ASSET_SERIAL_NUMBER_ALREADY_EXISTS
 *
 * The `(client_id, asset_code)` unique constraint and the partial
 * `(client_id, serial_number)` unique index remain the final authority — they
 * also cover the race between the pre-check and the INSERT.
 */
export async function createAsset(
  input: CreateAssetInput,
  actorUserId?: string | null,
): Promise<PublicAsset> {
  const { clientId, buildingStatus } = await resolveAssetBuildingContext(
    input.buildingId,
  );
  if (buildingStatus !== 'ACTIVE') {
    throw assetBuildingInactiveError();
  }

  const existing = await assetRepository.findByCodeForClient(
    clientId,
    input.assetCode,
  );
  if (existing) {
    throw assetCodeAlreadyExistsError();
  }

  const serialNumber = input.serialNumber ?? null;
  if (serialNumber !== null) {
    const duplicateSerial = await assetRepository.findBySerialNumberForClient(
      clientId,
      serialNumber,
    );
    if (duplicateSerial) {
      throw assetSerialNumberAlreadyExistsError();
    }
  }

  try {
    const record = await assetRepository.createAsset({
      clientId,
      buildingId: input.buildingId,
      // Classification (BE-05B) is assigned through PATCH /assets/:id, never
      // at registration time.
      assetCategoryId: null,
      assetTypeId: null,
      // Location binding (BE-05C) is assigned through PATCH
      // /assets/:id/location, never at registration time. An Asset starts
      // Building-level only.
      functionalLocationId: null,
      assetCode: input.assetCode,
      assetName: input.assetName,
      description: input.description ?? null,
      manufacturer: input.manufacturer ?? null,
      model: input.model ?? null,
      serialNumber,
      status: input.status ?? 'ACTIVE',
    });

    await recordAssetHistory({
      assetId: record.id,
      eventType: 'ASSET_CREATED',
      actorUserId,
      summary: `Asset ${record.assetCode} registered`,
      metadata: {
        assetCode: record.assetCode,
        assetName: record.assetName,
        buildingId: record.buildingId,
        status: record.status,
      },
    });

    return toPublicAsset(record);
  } catch (error) {
    if (isAssetCodeUniqueViolation(error)) {
      throw assetCodeAlreadyExistsError();
    }
    if (isAssetSerialNumberUniqueViolation(error)) {
      throw assetSerialNumberAlreadyExistsError();
    }
    throw error;
  }
}

export async function getAssetById(id: string): Promise<PublicAsset> {
  const record = await assetRepository.findById(id);
  if (!record) {
    throw assetNotFoundError();
  }

  return toPublicAsset(record);
}

/**
 * Lists the Assets registered in a Building, optionally filtered by status.
 * Building access itself is enforced at the route/controller layer (BE-02).
 */
export async function listAssetsByBuilding(
  buildingId: string,
  status?: AssetStatus,
): Promise<PublicAsset[]> {
  const records = await assetRepository.listByBuilding(buildingId, status);
  return records.map(toPublicAsset);
}

/**
 * Validates the BE-05B classification the Asset will carry AFTER the patch is
 * applied, so a partial update can never leave an inconsistent pair.
 *
 * Rules (pinned by tests):
 *   1. unknown Category                       → 404 ASSET_CATEGORY_NOT_FOUND
 *   2. Category of a different Client         → 400 ASSET_CATEGORY_CLIENT_MISMATCH
 *      (checked BEFORE status, so a foreign Client's reference-data
 *      lifecycle is never probeable)
 *   3. newly assigned INACTIVE Category       → 400 ASSET_CATEGORY_INACTIVE
 *   4. unknown Type                           → 404 ASSET_TYPE_NOT_FOUND
 *   5. Type not under the effective Category  → 400 ASSET_TYPE_CATEGORY_MISMATCH
 *      (a Type without any Category is the same violation)
 *   6. newly assigned INACTIVE Type           → 400 ASSET_TYPE_INACTIVE
 *
 * Inactive handling matches the BE-04E Room Type precedent: EXISTING
 * classifications survive deactivation untouched; only NEW assignments are
 * refused. Assets without classification remain valid — both references stay
 * optional.
 */
async function assertAssetClassification(
  existing: AssetRecord,
  input: UpdateAssetInput,
): Promise<void> {
  const categoryChanged = input.assetCategoryId !== undefined;
  const typeChanged = input.assetTypeId !== undefined;
  if (!categoryChanged && !typeChanged) {
    return;
  }

  const effectiveCategoryId = categoryChanged
    ? input.assetCategoryId
    : existing.assetCategoryId;
  const effectiveTypeId = typeChanged ? input.assetTypeId : existing.assetTypeId;

  if (effectiveCategoryId) {
    const category = await assetCategoryRepository.findById(
      effectiveCategoryId,
    );
    if (!category) {
      throw assetCategoryNotFoundError();
    }
    if (category.clientId !== existing.clientId) {
      throw assetCategoryClientMismatchError();
    }
    if (
      category.status !== 'ACTIVE' &&
      effectiveCategoryId !== existing.assetCategoryId
    ) {
      throw assetCategoryInactiveError();
    }
  }

  if (effectiveTypeId) {
    const assetType = await assetTypeRepository.findById(effectiveTypeId);
    if (!assetType) {
      throw assetTypeNotFoundError();
    }
    // A Type is only meaningful beneath its own Category; this also rejects a
    // Type assigned with no Category at all, and a Type belonging to another
    // Client (its Category could not have passed the check above).
    if (assetType.assetCategoryId !== effectiveCategoryId) {
      throw assetTypeCategoryMismatchError();
    }
    if (
      assetType.status !== 'ACTIVE' &&
      effectiveTypeId !== existing.assetTypeId
    ) {
      throw assetTypeInactiveError();
    }
  }
}

/**
 * BE-05C — validates a Functional Location before it is bound to an Asset.
 *
 * The BE-04 structure is the ONLY authority for where a location sits: the
 * caller supplies a Functional Location id and nothing else, and the
 * Building is read from the stored record — never from the request. The
 * finer hierarchy is resolved, never trusted.
 *
 * Rules (pinned by tests):
 *   1. unknown Functional Location        → 404 FUNCTIONAL_LOCATION_NOT_FOUND
 *   2. location of a different Building   → 400 ASSET_LOCATION_BUILDING_MISMATCH
 *      (this also rejects every cross-Client binding, since a Building
 *      belongs to exactly one Client through Property)
 *   3. newly bound INACTIVE location on
 *      an ACTIVE Asset                    → 400 ASSET_LOCATION_INACTIVE
 *
 * Inactive handling mirrors BE-05B classification: an EXISTING binding
 * survives the location being deactivated; only NEW bindings are refused,
 * and only for an Asset that is itself ACTIVE.
 */
async function assertAssetLocationBinding(
  existing: AssetRecord,
  functionalLocationId: string,
  nextStatus: AssetStatus,
): Promise<void> {
  const location = await functionalLocationRepository.findById(
    functionalLocationId,
  );
  if (!location) {
    throw functionalLocationNotFoundError();
  }

  if (location.buildingId !== existing.buildingId) {
    throw assetLocationBuildingMismatchError();
  }

  if (
    location.status !== 'ACTIVE' &&
    nextStatus === 'ACTIVE' &&
    functionalLocationId !== existing.functionalLocationId
  ) {
    throw assetLocationInactiveError();
  }
}

/**
 * Resolves the authoritative operational location context of an Asset.
 *
 * The finer hierarchy is NEVER stored on the Asset: it is projected here
 * through the BE-04H resolver
 * (`Client → Property → [Campus] → Building → Floor → Area → Room → Space →
 * Functional Location`), so Asset location context can never drift from the
 * Building Digital Structure.
 *
 * An Asset with no Functional Location resolves to Building-level context
 * only — the minimum direct reference it already carries.
 *
 * `resolveFunctionalLocationContext` additionally raises
 * HIERARCHY_INCONSISTENT when a stored location's Space chain contradicts its
 * own Building, so hierarchy consistency is inherited rather than re-checked.
 */
export async function resolveAssetLocationContext(
  id: string,
): Promise<OperationalContext> {
  const record = await assetRepository.findById(id);
  if (!record) {
    throw assetNotFoundError();
  }

  if (!record.functionalLocationId) {
    return resolveBuildingContext(record.buildingId);
  }

  return resolveFunctionalLocationContext(record.functionalLocationId);
}

/**
 * BE-05C — binds, rebinds, or clears an Asset's Functional Location.
 *
 * Clearing (`null`) is always allowed: the Asset falls back to Building-level
 * context, which is the minimum direct reference it already carries. Assets
 * are never deleted or moved between Buildings here.
 */
export async function updateAssetLocation(
  id: string,
  input: UpdateAssetLocationInput,
  actorUserId?: string | null,
): Promise<PublicAsset> {
  const existing = await assetRepository.findById(id);
  if (!existing) {
    throw assetNotFoundError();
  }

  if (input.functionalLocationId !== null) {
    await assertAssetLocationBinding(
      existing,
      input.functionalLocationId,
      existing.status,
    );
  }

  const record = await assetRepository.updateAsset(id, {
    functionalLocationId: input.functionalLocationId,
  });

  if (input.functionalLocationId !== existing.functionalLocationId) {
    await recordAssetHistory({
      assetId: id,
      eventType: 'ASSET_LOCATION_CHANGED',
      actorUserId,
      summary:
        input.functionalLocationId === null
          ? 'Asset location binding cleared'
          : 'Asset bound to functional location',
      metadata: {
        from: existing.functionalLocationId,
        to: input.functionalLocationId,
      },
    });
  }

  return toPublicAsset(record as AssetRecord);
}

/**
 * Partially updates Asset master data, BE-05B classification, and BE-05C
 * location binding.
 *
 * `buildingId` and `assetCode` are immutable in BE-05A. A new serial number is
 * re-checked for Client-wide uniqueness; an explicit null clears it.
 * Classification references are validated as a consistent pair.
 */
export async function updateAsset(
  id: string,
  input: UpdateAssetInput,
  actorUserId?: string | null,
): Promise<PublicAsset> {
  const existing = await assetRepository.findById(id);
  if (!existing) {
    throw assetNotFoundError();
  }

  // A status supplied through the general master-data PATCH must obey the
  // exact same BE-05E lifecycle rules as the dedicated endpoint — there is
  // no side door around the transition table.
  if (input.status !== undefined && input.status !== existing.status) {
    assertAssetStatusTransition(existing.status, input.status);
  }

  await assertAssetClassification(existing, input);

  if (
    input.functionalLocationId !== undefined &&
    input.functionalLocationId !== null
  ) {
    await assertAssetLocationBinding(
      existing,
      input.functionalLocationId,
      input.status ?? existing.status,
    );
  }

  if (
    input.serialNumber !== undefined &&
    input.serialNumber !== null &&
    input.serialNumber !== existing.serialNumber
  ) {
    const duplicateSerial = await assetRepository.findBySerialNumberForClient(
      existing.clientId,
      input.serialNumber,
    );
    if (duplicateSerial) {
      throw assetSerialNumberAlreadyExistsError();
    }
  }

  // A status change is applied ONLY through the guarded lifecycle path, so
  // it stays traceable (previous status / timestamp) no matter which
  // endpoint requested it. The master-data write therefore excludes it.
  const { status: requestedStatus, ...masterData } = input;
  const isTransition =
    requestedStatus !== undefined && requestedStatus !== existing.status;

  try {
    const record = await assetRepository.updateAsset(id, masterData);

    await recordAssetUpdateHistory(existing, masterData, actorUserId);

    if (isTransition) {
      const transitioned = await assetRepository.updateStatusFrom(
        id,
        existing.status,
        requestedStatus,
        null,
      );
      if (!transitioned) {
        throw assetStatusTransitionNotAllowedError(
          existing.status,
          requestedStatus,
        );
      }

      await recordAssetHistory({
        assetId: id,
        eventType: 'ASSET_STATUS_CHANGED',
        actorUserId,
        summary: `Asset status changed from ${existing.status} to ${requestedStatus}`,
        metadata: { from: existing.status, to: requestedStatus },
      });

      return toPublicAsset(transitioned);
    }

    return toPublicAsset(record as AssetRecord);
  } catch (error) {
    if (isAssetSerialNumberUniqueViolation(error)) {
      throw assetSerialNumberAlreadyExistsError();
    }
    throw error;
  }
}

/**
 * BE-05I — splits one master-data patch into the history events it really
 * represents: a classification change is recorded as its own event, so the
 * timeline reads meaningfully instead of collapsing everything into a
 * generic "updated".
 */
async function recordAssetUpdateHistory(
  existing: AssetRecord,
  masterData: Omit<UpdateAssetInput, 'status'>,
  actorUserId?: string | null,
): Promise<void> {
  const {
    assetCategoryId,
    assetTypeId,
    functionalLocationId,
    ...plainFields
  } = masterData;

  const classificationChanges = diffFields(
    existing as unknown as Record<string, unknown>,
    { assetCategoryId, assetTypeId } as Record<string, unknown>,
  );
  if (Object.keys(classificationChanges).length > 0) {
    await recordAssetHistory({
      assetId: existing.id,
      eventType: 'ASSET_CLASSIFICATION_CHANGED',
      actorUserId,
      summary: 'Asset classification changed',
      metadata: classificationChanges,
    });
  }

  const locationChanges = diffFields(
    existing as unknown as Record<string, unknown>,
    { functionalLocationId } as Record<string, unknown>,
  );
  if (Object.keys(locationChanges).length > 0) {
    await recordAssetHistory({
      assetId: existing.id,
      eventType: 'ASSET_LOCATION_CHANGED',
      actorUserId,
      summary: 'Asset location binding changed',
      metadata: locationChanges,
    });
  }

  const masterChanges = diffFields(
    existing as unknown as Record<string, unknown>,
    plainFields as Record<string, unknown>,
  );
  if (Object.keys(masterChanges).length > 0) {
    await recordAssetHistory({
      assetId: existing.id,
      eventType: 'ASSET_UPDATED',
      actorUserId,
      summary: `Asset master data updated: ${changedFieldNames(masterChanges).join(', ')}`,
      metadata: masterChanges,
    });
  }
}

/**
 * BE-05E — validates one lifecycle transition against the explicit table.
 *
 * A RETIRED Asset is terminal and reports a dedicated error, so "you cannot
 * un-retire this" is distinguishable from a generic illegal move.
 * Re-applying the current status is a no-op rather than an error.
 */
export function assertAssetStatusTransition(
  from: AssetStatus,
  to: AssetStatus,
): void {
  if (from === to) {
    return;
  }

  if (isTerminalAssetStatus(from)) {
    throw assetRetiredError();
  }

  if (!isAllowedAssetStatusTransition(from, to)) {
    throw assetStatusTransitionNotAllowedError(from, to);
  }
}

/**
 * Returns the current lifecycle state of an Asset together with the
 * backend-resolved available transitions — the frontend consumes these
 * rather than recreating the rules locally.
 */
export async function getAssetLifecycleStatus(
  id: string,
): Promise<AssetLifecycleStatus> {
  const record = await assetRepository.findById(id);
  if (!record) {
    throw assetNotFoundError();
  }

  return {
    assetId: record.id,
    status: record.status,
    previousStatus: record.previousStatus,
    statusChangedAt: toIsoString(record.statusChangedAt),
    statusReason: record.statusReason,
    allowedTransitions: [...ASSET_STATUS_TRANSITIONS[record.status]],
    isTerminal: isTerminalAssetStatus(record.status),
  };
}

/**
 * BE-05E — changes an Asset's lifecycle status through the controlled
 * transition table.
 *
 * Validation order (pinned by tests):
 *   1. unknown Asset              → 404 ASSET_NOT_FOUND
 *   2. RETIRED Asset (terminal)   → 409 ASSET_RETIRED
 *   3. disallowed transition      → 409 ASSET_STATUS_TRANSITION_NOT_ALLOWED
 *
 * The Equipment Profile (BE-05D) is deliberately left untouched: retiring or
 * suspending an Asset does not delete or rewrite its technical sheet, which
 * remains readable for history. This is master/state data only — no
 * maintenance workflow is triggered.
 */
export async function updateAssetStatus(
  id: string,
  input: UpdateAssetStatusInput,
  actorUserId?: string | null,
): Promise<PublicAsset> {
  const existing = await assetRepository.findById(id);
  if (!existing) {
    throw assetNotFoundError();
  }

  assertAssetStatusTransition(existing.status, input.status);

  if (existing.status === input.status) {
    return toPublicAsset(existing);
  }

  const record = await assetRepository.updateStatusFrom(
    id,
    existing.status,
    input.status,
    input.reason ?? null,
  );

  // Lost the optimistic race: another request already moved this Asset.
  if (!record) {
    throw assetStatusTransitionNotAllowedError(existing.status, input.status);
  }

  await recordAssetHistory({
    assetId: id,
    eventType: 'ASSET_STATUS_CHANGED',
    actorUserId,
    summary: `Asset status changed from ${existing.status} to ${input.status}`,
    metadata: {
      from: existing.status,
      to: input.status,
      ...(input.reason ? { reason: input.reason } : {}),
    },
  });

  return toPublicAsset(record);
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23505' && candidate.constraint === constraint;
}

function isAssetCodeUniqueViolation(error: unknown): boolean {
  return isUniqueViolation(error, 'assets_client_asset_code_unique');
}

function isAssetSerialNumberUniqueViolation(error: unknown): boolean {
  return isUniqueViolation(error, 'assets_client_serial_number_unique');
}

export const assetService = {
  assertAssetStatusTransition,
  createAsset,
  getAssetById,
  getAssetLifecycleStatus,
  listAssetsByBuilding,
  resolveAssetBuildingContext,
  resolveAssetLocationContext,
  toPublicAsset,
  updateAsset,
  updateAssetLocation,
  updateAssetStatus,
};
