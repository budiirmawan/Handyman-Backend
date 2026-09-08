import { assetNotFoundError, assetRepository } from '../assets';
import {
  changedFieldNames,
  diffFields,
  recordAssetHistory,
} from '../asset-history';
import { AppError } from '../../shared/errors';
import {
  equipmentProfileAlreadyExistsError,
  equipmentProfileCodeAlreadyExistsError,
  equipmentProfileNotFoundError,
} from './equipment-profile.errors';
import { equipmentProfileRepository } from './equipment-profile.repository';
import type {
  CreateEquipmentProfileInput,
  EquipmentProfileRecord,
  PublicEquipmentProfile,
  UpdateEquipmentProfileInput,
  UpdateEquipmentProfileStatusInput,
} from './equipment-profile.types';
import {
  assertCapacityHasUnit,
  assertCommissioningAfterInstallation,
  type ValidationDetail,
} from './equipment-profile.validation';

/** Calendar dates are exposed as `YYYY-MM-DD`, never as instants. */
function toDateString(value: Date | null): string | null {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

export function toPublicEquipmentProfile(
  record: EquipmentProfileRecord,
): PublicEquipmentProfile {
  return {
    id: record.id,
    assetId: record.assetId,
    equipmentCode: record.equipmentCode,
    equipmentName: record.equipmentName,
    manufacturer: record.manufacturer,
    model: record.model,
    serialNumber: record.serialNumber,
    specification: record.specification,
    capacity: record.capacity,
    unitOfMeasure: record.unitOfMeasure,
    installationDate: toDateString(record.installationDate),
    commissioningDate: toDateString(record.commissioningDate),
    status: record.status,
  };
}

/**
 * Loads the Asset that owns the Profile. The Asset registry (BE-05A) is the
 * single source of Client / Building context — the Profile duplicates
 * neither. Building isolation itself is enforced at the API layer against
 * the returned `buildingId`.
 */
async function requireAsset(assetId: string) {
  const asset = await assetRepository.findById(assetId);
  if (!asset) {
    throw assetNotFoundError();
  }
  return asset;
}

/**
 * Creates the Equipment Profile of one Asset.
 *
 * Validation order (pinned by tests):
 *   1. unknown Asset                       → 404 ASSET_NOT_FOUND
 *   2. Asset already has a Profile         → 409 EQUIPMENT_PROFILE_ALREADY_EXISTS
 *   3. duplicate code within the Client    → 409 EQUIPMENT_PROFILE_CODE_ALREADY_EXISTS
 *
 * The `UNIQUE (asset_id)` constraint remains the final authority for rule 2 —
 * it also covers the race between the pre-check and the INSERT.
 */
export async function createEquipmentProfile(
  input: CreateEquipmentProfileInput,
  actorUserId?: string | null,
): Promise<PublicEquipmentProfile> {
  const asset = await requireAsset(input.assetId);

  const existing = await equipmentProfileRepository.findByAssetId(
    input.assetId,
  );
  if (existing) {
    throw equipmentProfileAlreadyExistsError();
  }

  const duplicateCode = await equipmentProfileRepository.findByCodeForClient(
    asset.clientId,
    input.equipmentCode,
  );
  if (duplicateCode) {
    throw equipmentProfileCodeAlreadyExistsError();
  }

  try {
    const record = await equipmentProfileRepository.createEquipmentProfile({
      assetId: input.assetId,
      equipmentCode: input.equipmentCode,
      equipmentName: input.equipmentName,
      manufacturer: input.manufacturer ?? null,
      model: input.model ?? null,
      serialNumber: input.serialNumber ?? null,
      specification: input.specification ?? null,
      capacity: input.capacity ?? null,
      unitOfMeasure: input.unitOfMeasure ?? null,
      installationDate: input.installationDate ?? null,
      commissioningDate: input.commissioningDate ?? null,
      status: input.status ?? 'ACTIVE',
    });

    await recordAssetHistory({
      assetId: input.assetId,
      eventType: 'EQUIPMENT_PROFILE_CREATED',
      actorUserId,
      summary: `Equipment profile ${record.equipmentCode} created`,
      metadata: {
        equipmentProfileId: record.id,
        equipmentCode: record.equipmentCode,
        equipmentName: record.equipmentName,
      },
    });

    return toPublicEquipmentProfile(record);
  } catch (error) {
    if (isProfilePerAssetUniqueViolation(error)) {
      throw equipmentProfileAlreadyExistsError();
    }
    throw error;
  }
}

export async function getEquipmentProfileByAssetId(
  assetId: string,
): Promise<PublicEquipmentProfile> {
  const record = await equipmentProfileRepository.findByAssetId(assetId);
  if (!record) {
    throw equipmentProfileNotFoundError();
  }
  return toPublicEquipmentProfile(record);
}

/**
 * Partially updates the technical detail of one Equipment Profile.
 *
 * `assetId` and `equipmentCode` are immutable. Cross-field technical rules
 * (capacity requires a unit; commissioning cannot precede installation) are
 * re-checked against the MERGED result, so a partial update can never leave
 * an inconsistent sheet — the DB CHECK constraints are the final backstop.
 */
export async function updateEquipmentProfile(
  assetId: string,
  input: UpdateEquipmentProfileInput,
  actorUserId?: string | null,
): Promise<PublicEquipmentProfile> {
  await requireAsset(assetId);

  const existing = await equipmentProfileRepository.findByAssetId(assetId);
  if (!existing) {
    throw equipmentProfileNotFoundError();
  }

  const details: ValidationDetail[] = [];

  const nextCapacity =
    input.capacity === undefined ? existing.capacity : input.capacity;
  const nextUnitOfMeasure =
    input.unitOfMeasure === undefined
      ? existing.unitOfMeasure
      : input.unitOfMeasure;
  const nextInstallationDate =
    input.installationDate === undefined
      ? toDateString(existing.installationDate)
      : input.installationDate;
  const nextCommissioningDate =
    input.commissioningDate === undefined
      ? toDateString(existing.commissioningDate)
      : input.commissioningDate;

  assertCapacityHasUnit(nextCapacity, nextUnitOfMeasure, details);
  assertCommissioningAfterInstallation(
    nextInstallationDate,
    nextCommissioningDate,
    details,
  );

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  const record = await equipmentProfileRepository.updateEquipmentProfile(
    assetId,
    input,
  );

  const changes = diffFields(
    existing as unknown as Record<string, unknown>,
    input as Record<string, unknown>,
  );
  if (Object.keys(changes).length > 0) {
    await recordAssetHistory({
      assetId,
      eventType: 'EQUIPMENT_PROFILE_UPDATED',
      actorUserId,
      summary: `Equipment profile updated: ${changedFieldNames(changes).join(', ')}`,
      metadata: { equipmentProfileId: existing.id, ...changes },
    });
  }

  return toPublicEquipmentProfile(record as EquipmentProfileRecord);
}

/**
 * Activates or deactivates an Equipment Profile. Deactivating is not a
 * delete and does NOT free the one-profile-per-Asset slot: the technical
 * sheet is retained for history and may be reactivated.
 *
 * This is status only — no lifecycle workflow, transitions, or available
 * actions (BE-05E).
 */
export async function updateEquipmentProfileStatus(
  assetId: string,
  input: UpdateEquipmentProfileStatusInput,
): Promise<PublicEquipmentProfile> {
  await requireAsset(assetId);

  const existing = await equipmentProfileRepository.findByAssetId(assetId);
  if (!existing) {
    throw equipmentProfileNotFoundError();
  }

  const record = await equipmentProfileRepository.updateStatus(
    assetId,
    input.status,
  );
  return toPublicEquipmentProfile(record as EquipmentProfileRecord);
}

function isProfilePerAssetUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint === 'equipment_profiles_asset_id_unique'
  );
}

export const equipmentProfileService = {
  createEquipmentProfile,
  getEquipmentProfileByAssetId,
  toPublicEquipmentProfile,
  updateEquipmentProfile,
  updateEquipmentProfileStatus,
};
