/**
 * CR-HM-FIELD-OPERATIONS-01 PART 04 — bounded HTTP projections for the
 * approved G-2 / G-3 configuration surfaces.
 *
 * Deliberately ABSENT from every projection:
 *   - `opaque_code_hash` (secret material, never leaves storage);
 *   - `clientId` (internal realm binding, derived server-side);
 *   - `createdByUserId` (internal actor metadata; the operational-event
 *     journal is the audited actor record).
 */

export type ArrivalLocationIdentifierView = {
  id: string;
  buildingId: string;
  floorId: string | null;
  areaId: string | null;
  roomId: string | null;
  spaceId: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  createdAt: string;
  updatedAt: string;
};

/**
 * Registration result: the registry projection PLUS the generated opaque
 * value. The raw value crosses this boundary EXACTLY ONCE and is
 * unrecoverable afterwards (hash at rest).
 */
export type ArrivalLocationIdentifierIssuedView =
  ArrivalLocationIdentifierView & { opaqueCode: string };

export type BuildingGeofencePolicyView = {
  id: string;
  buildingId: string;
  referenceLatitude: number;
  referenceLongitude: number;
  geofenceRadiusMeters: number;
  maxAccuracyMeters: number;
  maxLocationAgeSeconds: number;
  status: 'ACTIVE' | 'INACTIVE';
  effectiveFrom: string;
  createdAt: string;
  updatedAt: string;
};
