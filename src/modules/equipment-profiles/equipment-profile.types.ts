/**
 * BE-05D — Equipment Profile domain types.
 *
 * An Equipment Profile is the TECHNICAL detail sheet attached to exactly one
 * existing Asset (Asset → Equipment Profile). It extends the Asset registry
 * with engineering data and the nameplate identity as recorded on the
 * equipment itself.
 *
 * Client / Building ownership is NOT duplicated: it is derived through
 * Equipment Profile → Asset → Building → Property → Client. Location is not
 * duplicated either — it is resolved via the Asset's BE-05C binding.
 *
 * An Equipment Profile is NOT a lifecycle workflow, warranty, certification,
 * QR identifier, history entry, PM plan, breakdown, work order, or checklist.
 */
export const EQUIPMENT_PROFILE_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type EquipmentProfileStatus =
  (typeof EQUIPMENT_PROFILE_STATUSES)[number];

export function isEquipmentProfileStatus(
  value: unknown,
): value is EquipmentProfileStatus {
  return (
    typeof value === 'string' &&
    (EQUIPMENT_PROFILE_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type EquipmentProfileRecord = {
  id: string;
  assetId: string;
  equipmentCode: string;
  equipmentName: string;
  /** Nameplate identity as recorded on the equipment. */
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  specification: string | null;
  /** Physical magnitude; never negative, always paired with a unit. */
  capacity: number | null;
  unitOfMeasure: string | null;
  installationDate: Date | null;
  commissioningDate: Date | null;
  status: EquipmentProfileStatus;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Safe public representation exposed through the API. Dates are serialized
 * as `YYYY-MM-DD` because installation / commissioning are calendar dates,
 * not instants.
 */
export type PublicEquipmentProfile = {
  id: string;
  assetId: string;
  equipmentCode: string;
  equipmentName: string;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  specification: string | null;
  capacity: number | null;
  unitOfMeasure: string | null;
  installationDate: string | null;
  commissioningDate: string | null;
  status: EquipmentProfileStatus;
};

/** Input supplied by the API consumer when creating an Equipment Profile. */
export type CreateEquipmentProfileInput = {
  assetId: string;
  equipmentCode: string;
  equipmentName: string;
  manufacturer?: string;
  model?: string;
  serialNumber?: string;
  specification?: string;
  capacity?: number;
  unitOfMeasure?: string;
  installationDate?: string;
  commissioningDate?: string;
  status?: EquipmentProfileStatus;
};

/** Fully-resolved equipment profile data ready for persistence. */
export type NewEquipmentProfile = {
  assetId: string;
  equipmentCode: string;
  equipmentName: string;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  specification: string | null;
  capacity: number | null;
  unitOfMeasure: string | null;
  installationDate: string | null;
  commissioningDate: string | null;
  status: EquipmentProfileStatus;
};

/**
 * Partial update input (PATCH /assets/:assetId/equipment-profile).
 *
 * `assetId` and `equipmentCode` are deliberately immutable: a Profile never
 * migrates between Assets (that would silently re-home its derived Client
 * ownership), and its code is the stable technical identifier.
 * Nullable fields accept an explicit null to clear the value.
 */
export type UpdateEquipmentProfileInput = {
  equipmentName?: string;
  manufacturer?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  specification?: string | null;
  capacity?: number | null;
  unitOfMeasure?: string | null;
  installationDate?: string | null;
  commissioningDate?: string | null;
  status?: EquipmentProfileStatus;
};

/** Status-only update input (service-level lifecycle operation). */
export type UpdateEquipmentProfileStatusInput = {
  status: EquipmentProfileStatus;
};
