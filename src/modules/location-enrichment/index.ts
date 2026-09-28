import type {
  LocationEnrichmentProvider,
  RegionalReferenceProvider,
} from './location-enrichment.types';
import {
  ApiCoIdLocationAdapter,
  type ApiCoIdLocationAdapterOptions,
} from './api-co-id-location.adapter';

export {
  REGIONAL_REFERENCE_RESULT_STATUSES,
  REVERSE_GEOCODE_RESULT_STATUSES,
} from './location-enrichment.types';
export type {
  IndonesiaRegionalFilter,
  LocationEnrichmentProvider,
  NormalizedRegionalReference,
  NormalizedReverseGeocodeAddress,
  RegionalReferenceLevel,
  RegionalReferenceProvider,
  RegionalReferencesResult,
  ReverseGeocodeInput,
  ReverseGeocodeResult,
} from './location-enrichment.types';
export {
  API_CO_ID_DEFAULTS,
  ApiCoIdLocationAdapter,
  createFetchApiCoIdTransport,
  readApiCoIdLocationConfig,
  sanitizeApiCoIdDetail,
} from './api-co-id-location.adapter';
export type {
  ApiCoIdHttpRequest,
  ApiCoIdHttpResponse,
  ApiCoIdHttpTransport,
  ApiCoIdLocationAdapterOptions,
  ApiCoIdLocationConfig,
} from './api-co-id-location.adapter';

/**
 * Composition root: consumers receive ONLY the provider-neutral
 * interfaces — the concrete adapter type never crosses this factory's
 * return type (PART 03C "domain depends on interfaces" rule).
 */
export type LocationEnrichmentProviders = {
  locationEnrichment: LocationEnrichmentProvider;
  regionalReference: RegionalReferenceProvider;
};

export function createLocationEnrichmentProviders(
  options?: ApiCoIdLocationAdapterOptions,
): LocationEnrichmentProviders {
  const adapter = new ApiCoIdLocationAdapter(options);
  return {
    locationEnrichment: adapter,
    regionalReference: adapter,
  };
}
