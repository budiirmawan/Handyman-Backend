/**
 * BE-05A — Asset domain types.
 *
 * An Asset is a MANAGED PHYSICAL OBJECT registered against exactly one
 * Building and owned by exactly one Client
 * (Client → Property → Building → Asset). `clientId` is DERIVED by the
 * service through Building → Property → Client — it is never accepted from
 * the API consumer.
 *
 * An Asset is NOT a Functional Location, Equipment Profile, Work Order, or
 * Checklist. BE-05A carries master data; BE-05B adds OPTIONAL classification
 * references (`assetCategoryId` / `assetTypeId`); BE-05C adds the OPTIONAL
 * `functionalLocationId` binding, from which the finer hierarchy
 * (Floor → Area → Room → Space) is RESOLVED via BE-04H rather than stored.
 * Still absent: equipment profile, warranty, certification, QR identifier,
 * and history — each is a later BE-05 PART.
 *
 * BE-05E defines the controlled lifecycle:
 * `ACTIVE | INACTIVE | UNDER_MAINTENANCE | RETIRED`. This is master/state
 * data only — `UNDER_MAINTENANCE` is a STATE, not a maintenance workflow.
 */
export const ASSET_STATUSES = [
  'ACTIVE',
  'INACTIVE',
  'UNDER_MAINTENANCE',
  'RETIRED',
] as const;

export type AssetStatus = (typeof ASSET_STATUSES)[number];

export function isAssetStatus(value: unknown): value is AssetStatus {
  return (
    typeof value === 'string' &&
    (ASSET_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * BE-05E — the explicit, closed transition table. Deliberately a small
 * lookup rather than a generic workflow engine (no states table, no rule
 * DSL, no dynamic configuration).
 *
 *   ACTIVE            → INACTIVE, UNDER_MAINTENANCE, RETIRED
 *   INACTIVE          → ACTIVE, RETIRED
 *   UNDER_MAINTENANCE → ACTIVE, INACTIVE
 *   RETIRED           → (terminal: no automatic reactivation)
 *
 * An asset under maintenance may be deactivated (e.g. the repair is
 * abandoned) but never retired directly — it must first return to a settled
 * ACTIVE/INACTIVE state, so retirement is always a deliberate decision.
 */
export const ASSET_STATUS_TRANSITIONS: Readonly<
  Record<AssetStatus, readonly AssetStatus[]>
> = {
  ACTIVE: ['INACTIVE', 'UNDER_MAINTENANCE', 'RETIRED'],
  INACTIVE: ['ACTIVE', 'RETIRED'],
  UNDER_MAINTENANCE: ['ACTIVE', 'INACTIVE'],
  RETIRED: [],
};

/** True when `from → to` is an allowed lifecycle transition. */
export function isAllowedAssetStatusTransition(
  from: AssetStatus,
  to: AssetStatus,
): boolean {
  return ASSET_STATUS_TRANSITIONS[from].includes(to);
}

/** A RETIRED asset is terminal: it accepts no further lifecycle change. */
export function isTerminalAssetStatus(status: AssetStatus): boolean {
  return ASSET_STATUS_TRANSITIONS[status].length === 0;
}

/**
 * Statuses an Asset may be REGISTERED with.
 *
 * A newly registered Asset must start in a state it can still move out of.
 * `UNDER_MAINTENANCE` is a transition an existing Asset enters, and
 * `RETIRED` is terminal — registering directly into either would produce an
 * Asset that never legitimately passed through the BE-05E lifecycle (and, in
 * the RETIRED case, one that is permanently frozen the moment it is created).
 */
export const ASSET_REGISTRABLE_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type AssetRegistrableStatus =
  (typeof ASSET_REGISTRABLE_STATUSES)[number];

export function isRegistrableAssetStatus(
  value: unknown,
): value is AssetRegistrableStatus {
  return (
    typeof value === 'string' &&
    (ASSET_REGISTRABLE_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type AssetRecord = {
  id: string;
  /** Owning Client, derived through Building → Property → Client. */
  clientId: string;
  buildingId: string;
  /** Optional BE-05B classification. NULL = unclassified Asset. */
  assetCategoryId: string | null;
  /** Optional BE-05B classification; always beneath `assetCategoryId`. */
  assetTypeId: string | null;
  /**
   * Optional BE-05C location binding. NULL = Building-level only. The
   * Functional Location always resolves to this Asset's own Building.
   */
  functionalLocationId: string | null;
  assetCode: string;
  assetName: string;
  description: string | null;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  status: AssetStatus;
  /**
   * BE-05E history readiness: the state this asset moved FROM, when it
   * moved, and why. Preserved on the record so a status change is never a
   * destructive overwrite. The append-only history table itself is BE-05I.
   */
  previousStatus: AssetStatus | null;
  statusChangedAt: Date | null;
  statusReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicAsset = {
  id: string;
  clientId: string;
  buildingId: string;
  assetCategoryId: string | null;
  assetTypeId: string | null;
  functionalLocationId: string | null;
  assetCode: string;
  assetName: string;
  description: string | null;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  status: AssetStatus;
  previousStatus: AssetStatus | null;
  statusChangedAt: string | null;
  statusReason: string | null;
};

/** Input supplied by the API consumer when registering an Asset. */
export type CreateAssetInput = {
  buildingId: string;
  assetCode: string;
  assetName: string;
  description?: string;
  manufacturer?: string;
  model?: string;
  serialNumber?: string;
  /** Registration is limited to a non-terminal starting state. */
  status?: AssetRegistrableStatus;
};

/** Fully-resolved asset data ready for persistence. */
export type NewAsset = {
  clientId: string;
  buildingId: string;
  assetCategoryId: string | null;
  assetTypeId: string | null;
  functionalLocationId: string | null;
  assetCode: string;
  assetName: string;
  description: string | null;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  status: AssetStatus;
};

/**
 * Partial update input (PATCH /assets/:id).
 *
 * `buildingId` and `assetCode` are deliberately immutable: an Asset never
 * migrates between Buildings in BE-05A, and its code is the stable registry
 * identifier later PARTs (QR / history) will reference. Nullable text fields
 * accept explicit null to clear the value.
 *
 * Classification (BE-05B) is assigned through this same PATCH: a UUID sets
 * the reference, an explicit null clears it.
 */
export type UpdateAssetInput = {
  assetName?: string;
  assetCategoryId?: string | null;
  assetTypeId?: string | null;
  /** BE-05C: a UUID binds the Asset to a Functional Location; null clears. */
  functionalLocationId?: string | null;
  description?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  status?: AssetStatus;
};

/**
 * BE-05E lifecycle transition input (PATCH /assets/:assetId/status).
 *
 * `reason` is optional free text preserved with the transition for later
 * Asset History (BE-05I).
 */
export type UpdateAssetStatusInput = {
  status: AssetStatus;
  reason?: string | null;
};

/** The current lifecycle state of one Asset, plus its allowed next moves. */
export type AssetLifecycleStatus = {
  assetId: string;
  status: AssetStatus;
  previousStatus: AssetStatus | null;
  statusChangedAt: string | null;
  statusReason: string | null;
  /** Backend-provided available transitions; the UI never recomputes these. */
  allowedTransitions: AssetStatus[];
  isTerminal: boolean;
};

/**
 * BE-05C location-binding input (PATCH /assets/:id/location).
 *
 * Only the Functional Location may be bound: the finer hierarchy is resolved
 * from BE-04, never supplied by the caller. An explicit null clears the
 * binding back to Building level.
 */
export type UpdateAssetLocationInput = {
  functionalLocationId: string | null;
};
