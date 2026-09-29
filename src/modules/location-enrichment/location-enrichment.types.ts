/**
 * CR-HM-07 Arrival Verification PART 03C — provider-neutral external
 * location enrichment (OPTIONAL_CORROBORATION / REFERENCE_NORMALIZATION
 * roles only, per the FROZEN geospatial authority decision).
 *
 * Domain/application code depends ONLY on the two interfaces below —
 * `LocationEnrichmentProvider` (reverse geocoding corroboration) and
 * `RegionalReferenceProvider` (Indonesia regional reference
 * normalization) — never on a concrete provider adapter.
 *
 * Hard scope walls (decision §8–§11):
 *   - never chooses the expected Building (scope snapshot remains the
 *     PART 02 authority);
 *   - never writes building reference coordinates or radius/accuracy/
 *     freshness policy (PART 03B per-Building policy remains authority);
 *   - never calculates an authoritative geofence and never converts any
 *     INSIDE/OUTSIDE signal into an arrival VERIFIED/FAILED verdict;
 *   - no database, no persistence, no migration, no HTTP exposure.
 *
 * Provider outcomes are BOUNDED provider-neutral result objects (never
 * thrown across the boundary, never contain raw provider payloads,
 * headers, URLs, or secret material).
 */

// ---------------------------------------------------------------------------
// Reverse geocoding — OPTIONAL_CORROBORATION
// ---------------------------------------------------------------------------

/** Validated device coordinates consumed for enrichment. */
export type ReverseGeocodeInput = {
  latitude: number;
  longitude: number;
};

/**
 * Bounded internal DTO. Only these keys ever cross the boundary; the
 * raw provider response (envelope flags, extratags, bounding boxes,
 * echoed coordinates, raw field names) never does.
 */
export type NormalizedReverseGeocodeAddress = {
  displayName: string | null;
  road: string | null;
  /** Kelurahan / subdistrict / suburb level. */
  village: string | null;
  /** Kecamatan level. */
  district: string | null;
  /** Kabupaten / Kota (regency/city) level. */
  regency: string | null;
  /** Province / region level. */
  province: string | null;
  postalCode: string | null;
  country: string | null;
  /** Provider reference identifier (preserved verbatim as text). */
  providerPlaceId: string | null;
};

export type ReverseGeocodeResult =
  | {
      status: 'AVAILABLE';
      address: NormalizedReverseGeocodeAddress;
    }
  | {
      /** Timeout / network / 5xx / malformed provider payload. */
      status: 'REVERSE_GEOCODE_UNAVAILABLE';
      /** Sanitized short detail (never secrets/headers/body). */
      detail: string;
    }
  | {
      /** 401/403 — bounded provider configuration/auth failure. */
      status: 'REVERSE_GEOCODE_AUTH_FAILURE';
      detail: string;
    };

export const REVERSE_GEOCODE_RESULT_STATUSES = [
  'AVAILABLE',
  'REVERSE_GEOCODE_UNAVAILABLE',
  'REVERSE_GEOCODE_AUTH_FAILURE',
] as const;

export interface LocationEnrichmentProvider {
  /**
   * Reverse-geocodes ALREADY VALIDATED device coordinates into the
   * bounded internal DTO. OPTIONAL_CORROBORATION only: the result is
   * display/corroboration data and can never alter expected-location,
   * geospatial-policy, geofence, or arrival outcome authorities.
   */
  reverseGeocode(input: ReverseGeocodeInput): Promise<ReverseGeocodeResult>;
}

// ---------------------------------------------------------------------------
// Indonesia regional reference — REFERENCE_NORMALIZATION
// ---------------------------------------------------------------------------

export type RegionalReferenceLevel =
  | 'province'
  | 'regency'
  | 'district'
  | 'village'
  | 'postal_code';

/**
 * Bounded normalized regional reference. The provider regional code is
 * PRESERVED as the reference identifier (`code`); hierarchy fields are
 * informational normalization context only and are NEVER copied into
 * Building/floor/area/room/space authorities.
 */
export type NormalizedRegionalReference = {
  level: RegionalReferenceLevel;
  /** Provider regional code, preserved verbatim as identifier. */
  code: string;
  name: string;
  provinceCode: string | null;
  province: string | null;
  regencyCode: string | null;
  regency: string | null;
  districtCode: string | null;
  district: string | null;
  villageCode: string | null;
  village: string | null;
  /** Village-attached postal codes (main reference level only). */
  postalCodes: string[];
  /** Primary postal code when level is `postal_code`. */
  postalCode: string | null;
};

export type IndonesiaRegionalFilter = {
  /** Case-insensitive partial-name filter. */
  name?: string;
  provinceCode?: string;
  regencyCode?: string;
  districtCode?: string;
  /** Postal-code filter (villages / postal-codes endpoints). */
  postalCode?: string;
};

export type RegionalReferencesResult =
  | {
      status: 'AVAILABLE';
      references: NormalizedRegionalReference[];
    }
  | {
      status: 'REGIONAL_REFERENCE_UNAVAILABLE';
      detail: string;
    }
  | {
      status: 'REGIONAL_REFERENCE_AUTH_FAILURE';
      detail: string;
    };

export const REGIONAL_REFERENCE_RESULT_STATUSES = [
  'AVAILABLE',
  'REGIONAL_REFERENCE_UNAVAILABLE',
  'REGIONAL_REFERENCE_AUTH_FAILURE',
] as const;

export interface RegionalReferenceProvider {
  listIndonesiaProvinces(
    filter?: IndonesiaRegionalFilter,
  ): Promise<RegionalReferencesResult>;
  listIndonesiaRegencies(
    filter?: IndonesiaRegionalFilter,
  ): Promise<RegionalReferencesResult>;
  listIndonesiaDistricts(
    filter?: IndonesiaRegionalFilter,
  ): Promise<RegionalReferencesResult>;
  listIndonesiaVillages(
    filter?: IndonesiaRegionalFilter,
  ): Promise<RegionalReferencesResult>;
  listIndonesiaPostalCodes(
    filter?: IndonesiaRegionalFilter,
  ): Promise<RegionalReferencesResult>;
}
