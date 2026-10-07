/**
 * CR-HM-07 Arrival Verification PART 02 — expected-location +
 * opaque QR location-identifier types. QR is a SIGNAL ONLY; the
 * comparison result is NEVER an arrival VERIFIED/FAILED verdict,
 * and no geofence/GPS/challenge semantics exist here.
 */

/** Location chain shape shared by scope snapshot + identifiers. */
export interface HandymanLocationChain {
  buildingId: string;
  floorId: string | null;
  areaId: string | null;
  roomId: string | null;
  spaceId: string | null;
}

/** Authoritative expected location (immutable CR-HM-06 snapshot). */
export type HandymanExpectedArrivalLocation = HandymanLocationChain;

export const HANDYMAN_ARRIVAL_LOCATION_IDENTIFIER_STATUSES =
  ['ACTIVE', 'INACTIVE'] as const;

export type HandymanArrivalLocationIdentifierStatus =
  (typeof HANDYMAN_ARRIVAL_LOCATION_IDENTIFIER_STATUSES)[number];

export interface HandymanArrivalLocationIdentifierRecord
  extends HandymanLocationChain {
  id: string;
  clientId: string;
  opaqueCodeHash: string;
  status: HandymanArrivalLocationIdentifierStatus;
  createdAt: Date;
  updatedAt: Date;
}

/** Public shape: serialized; the hash NEVER leaves storage. */
export interface PublicHandymanArrivalLocationIdentifier
  extends HandymanLocationChain {
  id: string;
  clientId: string;
  status: HandymanArrivalLocationIdentifierStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * Registry creation result: the RAW opaque value crosses exactly
 * this boundary once (printed onto/into the physical tag by the
 * operator); only its SHA-256 hash is persisted.
 */
export interface HandymanArrivalLocationIdentifierCreateResult {
  identifier: PublicHandymanArrivalLocationIdentifier;
  value: string;
}

/** Caller supplies ONLY the location chain (status/hash are server-side). */
export interface CreateHandymanArrivalLocationIdentifierInput {
  buildingId: string;
  floorId?: string | null;
  areaId?: string | null;
  roomId?: string | null;
  spaceId?: string | null;
}

/**
 * Bounded QR comparison signals (governance §G). UNKNOWN covers
 * unknown hashes AND cross-Client codes (non-enumerating firewall);
 * INACTIVE reports a deactivated identifier; MATCH/MISMATCH compare
 * against the expected snapshot's most-specific level. NONE of
 * these is an arrival verdict.
 */
export const HANDYMAN_ARRIVAL_QR_SIGNALS =
  ['MATCH', 'MISMATCH', 'UNKNOWN', 'INACTIVE'] as const;

export type HandymanArrivalQrSignalKind =
  (typeof HANDYMAN_ARRIVAL_QR_SIGNALS)[number];

export interface HandymanArrivalQrSignal {
  signal: HandymanArrivalQrSignalKind;
  identifierId: string | null;
  location: HandymanLocationChain | null;
}

export interface ResolveHandymanArrivalQrSignalInput {
  executionScopeId: string;
  rawValue: string;
}
