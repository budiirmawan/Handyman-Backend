/**
 * BE-25F — Mobile QR Resolution Contract types.
 *
 * The mobile QR/identifier resolution contract: one identifier input resolves
 * to a discriminated target (ASSET today; the shape is ready for future
 * target types) with Building/Location context, Asset/Equipment context where
 * applicable, and available mobile context/actions. Composition over the
 * existing BE-05H Asset Identifier resolver and the BE-02G access authority —
 * no separate QR engine.
 */

export const MOBILE_QR_TARGET_TYPES = ['ASSET'] as const;

export type MobileQrTargetType = (typeof MOBILE_QR_TARGET_TYPES)[number];

/** Building / Location context of the resolved target. */
export type MobileQrBuilding = {
  id: string;
  code: string;
  name: string;
};

export type MobileQrFunctionalLocation = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: string;
};

export type MobileQrLocationContext = {
  building: MobileQrBuilding | null;
  functionalLocation: MobileQrFunctionalLocation | null;
};

/** Asset / Equipment context (ASSET target). */
export type MobileQrAssetContext = {
  id: string;
  assetCode: string;
  assetName: string;
  description: string | null;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  status: string;
  equipment: {
    id: string;
    equipmentCode: string;
    equipmentName: string;
    manufacturer: string | null;
    model: string | null;
    serialNumber: string | null;
    status: string;
  } | null;
};

/** Available mobile action/context hints for the resolved target. */
export type MobileQrAvailableActions = {
  /**
   * Asset-backed actions are intentionally limited to read-model hints.
   * Backend-authoritative workflow actions remain on the resource endpoints
   * (BE-09 findings, BE-08 work orders); nothing workflow-related is
   * invented here.
   */
  actions: string[];
};

/** The full mobile QR resolution contract. */
export type MobileQrResolution = {
  /** Opaque identifier value supplied by the scanner. */
  identifier: {
    id: string;
    identifierType: string;
    identifierValue: string;
  };
  /** Discriminated target of the scan (ASSET today). */
  targetType: MobileQrTargetType;
  /** Target reference id. */
  targetId: string;
  clientId: string;
  location: MobileQrLocationContext;
  asset: MobileQrAssetContext | null;
  available: MobileQrAvailableActions;
};
