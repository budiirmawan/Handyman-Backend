import { ConfigError } from '../../config';
import type {
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

/**
 * CR-HM-07 PART 03C — API.CO.ID concrete adapter (host
 * `https://use.api.co.id`) implementing BOTH provider-neutral
 * interfaces. This file OWNS: HTTP, the `x-api-co-id` authentication
 * header, provider response parsing, and provider-specific error
 * mapping. Everything leaving this file is the bounded provider-neutral
 * DTO/result — never the raw payload, never the transport, never the
 * API key.
 *
 * Transport mirrors the repo's meta-whatsapp/webhook pattern: built-in
 * fetch + AbortController bounded timeout, injectable transport seam
 * (tests never touch the network), redirects disabled, and detail
 * strings built from controlled parts then credential-sanitized.
 *
 * Roles (FROZEN decision): reverse geocoding = OPTIONAL_CORROBORATION;
 * Indonesia regional = REFERENCE_NORMALIZATION. No authority mutation
 * anywhere below — this module has no database access at all.
 */

// ---------------------------------------------------------------------------
// Configuration (boundary read; key is a server-side secret)
// ---------------------------------------------------------------------------

export type ApiCoIdLocationConfig = {
  /** Server-side secret. NEVER returned, logged, or embedded in output. */
  apiKey: string;
  apiBaseUrl: string;
  timeoutMs: number;
};

export const API_CO_ID_DEFAULTS = {
  apiBaseUrl: 'https://use.api.co.id',
  timeoutMs: 5_000,
} as const;

/**
 * Reads the API.CO.ID adapter configuration from the environment at
 * adapter CONSTRUCTION only. `API_CO_ID_API_KEY` is required; the error
 * names the FIELD only — the credential value never appears anywhere.
 */
export function readApiCoIdLocationConfig(
  env: NodeJS.ProcessEnv = process.env,
): ApiCoIdLocationConfig {
  const apiKey = (env.API_CO_ID_API_KEY ?? '').trim();
  if (apiKey.length === 0) {
    throw new ConfigError(
      'Invalid configuration: API_CO_ID_API_KEY is required for the API.CO.ID location adapter.',
    );
  }
  const apiBaseUrl = (env.API_CO_ID_BASE_URL ?? API_CO_ID_DEFAULTS.apiBaseUrl)
    .trim()
    .replace(/\/+$/, '');
  if (!/^https:\/\//.test(apiBaseUrl)) {
    throw new ConfigError(
      'Invalid configuration: API_CO_ID_BASE_URL must be an https:// URL.',
    );
  }
  const rawTimeout = env.API_CO_ID_TIMEOUT_MS;
  let timeoutMs: number = API_CO_ID_DEFAULTS.timeoutMs;
  if (rawTimeout !== undefined && rawTimeout.trim() !== '') {
    const parsed = Number(rawTimeout);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 30_000) {
      throw new ConfigError(
        'Invalid configuration: API_CO_ID_TIMEOUT_MS must be an integer 1..30000.',
      );
    }
    timeoutMs = parsed;
  }
  return { apiKey, apiBaseUrl, timeoutMs };
}

// ---------------------------------------------------------------------------
// Transport (bounded timeout; injectable seam; body text only)
// ---------------------------------------------------------------------------

export type ApiCoIdHttpRequest = {
  url: string;
  /** Headers ALWAYS include `x-api-co-id` (server-side only). */
  headers: Record<string, string>;
  timeoutMs: number;
};

export type ApiCoIdHttpResponse = {
  status: number;
  /** Raw body text; the ADAPTER parses and bounds it. */
  bodyText: string;
};

export type ApiCoIdHttpTransport = (
  request: ApiCoIdHttpRequest,
) => Promise<ApiCoIdHttpResponse>;

/**
 * Production transport: built-in fetch, bounded AbortController timeout,
 * redirects DISABLED (`redirect: 'manual'` — following would reopen the
 * outbound SSRF surface; a 3xx classifies as UNAVAILABLE).
 */
export function createFetchApiCoIdTransport(): ApiCoIdHttpTransport {
  return async (
    request: ApiCoIdHttpRequest,
  ): Promise<ApiCoIdHttpResponse> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      const response = await fetch(request.url, {
        method: 'GET',
        headers: { accept: 'application/json', ...request.headers },
        redirect: 'manual',
        signal: controller.signal,
      });
      return { status: response.status, bodyText: await response.text() };
    } finally {
      clearTimeout(timer);
    }
  };
}

// ---------------------------------------------------------------------------
// Sanitization — errors/details contain controlled parts ONLY and are
// passed through credential-redacting truncation as defense in depth.
// ---------------------------------------------------------------------------

const MAX_DETAIL_LENGTH = 160;
const SECRET_PATTERN =
  /(bearer\s+[A-Za-z0-9._~+/-]+=*|x-api-co-id\s*[:=]\s*\S+|(password|passwd|pwd|secret|api[_-]?key|token|auth[_-]?token)\s*[:=]\s*[^,;"'\s]+)/gi;

export function sanitizeApiCoIdDetail(message: string): string {
  const redacted = message.replace(SECRET_PATTERN, '[REDACTED]');
  return redacted.length > MAX_DETAIL_LENGTH
    ? `${redacted.slice(0, MAX_DETAIL_LENGTH)}…`
    : redacted;
}

// ---------------------------------------------------------------------------
// Provider payload parsing → bounded internal DTOs (raw never escapes)
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : null;
}

function asIdText(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  return asText(value);
}

function normalizeReverseGeocode(
  payload: Record<string, unknown>,
): NormalizedReverseGeocodeAddress | null {
  const data = asRecord(payload.data);
  if (!data) return null;
  const address = asRecord(data.address) ?? {};
  return {
    displayName: asText(data.display_name) ?? asText(data.displayName),
    road: asText(address.road) ?? asText(address.street),
    village:
      asText(address.kelurahan) ??
      asText(address.village) ??
      asText(address.suburb),
    district: asText(address.kecamatan) ?? asText(address.district),
    regency:
      asText(address.regency) ??
      asText(address.kota) ??
      asText(address.city),
    province:
      asText(address.province) ??
      asText(address.state) ??
      asText(address.region),
    postalCode: asText(address.postcode) ?? asText(address.postal_code),
    country: asText(address.country),
    providerPlaceId: asIdText(data.place_id) ?? asText(data.placeId),
  };
}

function dataItems(payload: Record<string, unknown>): unknown[] {
  const raw = payload.data;
  if (Array.isArray(raw)) return raw;
  const single = asRecord(raw);
  return single ? [single] : [];
}

function normalizeRegionalItem(
  level: RegionalReferenceLevel,
  item: Record<string, unknown>,
): NormalizedRegionalReference | null {
  // Each level's own code: the item's `code`, else the endpoint-specific
  // filter fields (postal-codes endpoint carries `postal_code`).
  const code =
    level === 'postal_code'
      ? asText(item.postal_code) ?? asText(item.code)
      : asText(item.code);
  const name = asText(item.name) ?? (level === 'postal_code' ? code : null);
  if (!code || !name) return null;
  const postalCodes = Array.isArray(item.postal_codes)
    ? item.postal_codes
        .map((x) => asText(x))
        .filter((x): x is string => x !== null)
    : [];
  const reference: NormalizedRegionalReference = {
    level,
    code,
    name,
    provinceCode: asText(item.province_code),
    province: asText(item.province),
    regencyCode: asText(item.regency_code),
    regency: asText(item.regency),
    districtCode: asText(item.district_code),
    district: asText(item.district),
    villageCode: asText(item.village_code),
    village: asText(item.village),
    postalCodes,
    postalCode: null,
  };
  // Self-hierarchy fill: an item's own level maps its code/name onto the
  // matching hierarchy slot unless the provider sent explicit fields.
  if (level === 'province') {
    reference.provinceCode ??= code;
    reference.province ??= name;
  } else if (level === 'regency') {
    reference.regencyCode ??= code;
    reference.regency ??= name;
  } else if (level === 'district') {
    reference.districtCode ??= code;
    reference.district ??= name;
  } else if (level === 'village') {
    reference.villageCode ??= code;
    reference.village ??= name;
  } else {
    reference.postalCode = code;
  }
  return reference;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export type ApiCoIdLocationAdapterOptions = {
  /** Boundary config; defaults to `readApiCoIdLocationConfig()`. */
  config?: ApiCoIdLocationConfig;
  /** HTTP transport; defaults to the bounded-fetch production transport. */
  transport?: ApiCoIdHttpTransport;
};

export class ApiCoIdLocationAdapter
  implements LocationEnrichmentProvider, RegionalReferenceProvider
{
  /** Provider discriminator (non-secret identification only). */
  readonly provider = 'api-co-id';

  private readonly config: ApiCoIdLocationConfig;
  private readonly transport: ApiCoIdHttpTransport;

  constructor(options: ApiCoIdLocationAdapterOptions = {}) {
    this.config = options.config ?? readApiCoIdLocationConfig();
    if (this.config.apiKey.trim().length === 0) {
      throw new ConfigError(
        'Invalid configuration: API_CO_ID_API_KEY is required for the API.CO.ID location adapter.',
      );
    }
    this.transport = options.transport ?? createFetchApiCoIdTransport();
  }

  /** Builds the provider URL; the API key is NEVER a query parameter. */
  private url(path: string, query: Record<string, string>): string {
    const url = new URL(`${this.config.apiBaseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  /** Bounded GET; outcome status + payload (never thrown). */
  private async getJson(
    path: string,
    query: Record<string, string>,
  ): Promise<
    | { ok: true; payload: Record<string, unknown> }
    | { ok: false; mode: 'auth' | 'unavailable'; detail: string }
  > {
    let response: ApiCoIdHttpResponse;
    try {
      response = await this.transport({
        url: this.url(path, query),
        headers: { 'x-api-co-id': this.config.apiKey },
        timeoutMs: this.config.timeoutMs,
      });
    } catch (error) {
      const name = (error as { name?: string }).name ?? 'ERROR';
      const detail =
        name === 'AbortError'
          ? `HTTP_TIMEOUT_${this.config.timeoutMs}ms`
          : `NETWORK_${name}`;
      return { ok: false, mode: 'unavailable', detail: sanitizeApiCoIdDetail(detail) };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        mode: 'auth',
        detail: `HTTP_${response.status}`,
      };
    }
    if (response.status < 200 || response.status >= 300) {
      return {
        ok: false,
        mode: 'unavailable',
        detail: sanitizeApiCoIdDetail(`HTTP_${response.status}`),
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.bodyText);
    } catch {
      return { ok: false, mode: 'unavailable', detail: 'MALFORMED_JSON' };
    }
    const payload = asRecord(parsed);
    if (!payload || payload.is_success === false) {
      return { ok: false, mode: 'unavailable', detail: 'MALFORMED_PAYLOAD' };
    }
    return { ok: true, payload };
  }

  // -- LocationEnrichmentProvider -----------------------------------------

  async reverseGeocode(
    input: ReverseGeocodeInput,
  ): Promise<ReverseGeocodeResult> {
    const lat = Number(input.latitude);
    const lon = Number(input.longitude);
    if (
      !Number.isFinite(lat) ||
      lat < -90 ||
      lat > 90 ||
      !Number.isFinite(lon) ||
      lon < -180 ||
      lon > 180
    ) {
      throw new Error('LOCATION_ENRICHMENT_INPUT_INVALID:reverse-geocode');
    }
    const out = await this.getJson('/location/reverse-geocode', {
      lat: String(lat),
      lon: String(lon),
    });
    if (!out.ok) {
      return out.mode === 'auth'
        ? {
            status: 'REVERSE_GEOCODE_AUTH_FAILURE',
            detail: sanitizeApiCoIdDetail(out.detail),
          }
        : {
            status: 'REVERSE_GEOCODE_UNAVAILABLE',
            detail: sanitizeApiCoIdDetail(out.detail),
          };
    }
    if (out.payload.is_success !== true) {
      return { status: 'REVERSE_GEOCODE_UNAVAILABLE', detail: 'MALFORMED_PAYLOAD' };
    }
    const address = normalizeReverseGeocode(out.payload);
    if (!address) {
      return { status: 'REVERSE_GEOCODE_UNAVAILABLE', detail: 'MALFORMED_PAYLOAD' };
    }
    return { status: 'AVAILABLE', address };
  }

  // -- RegionalReferenceProvider ------------------------------------------

  private async regional(
    path: string,
    level: RegionalReferenceLevel,
    filter: IndonesiaRegionalFilter = {},
  ): Promise<RegionalReferencesResult> {
    const query: Record<string, string> = {};
    if (filter.name !== undefined) query.name = filter.name;
    if (filter.provinceCode !== undefined) {
      query.province_code = filter.provinceCode;
    }
    if (filter.regencyCode !== undefined) {
      query.regency_code = filter.regencyCode;
    }
    if (filter.districtCode !== undefined) {
      query.district_code = filter.districtCode;
    }
    if (filter.postalCode !== undefined) {
      query.postal_code = filter.postalCode;
    }
    const out = await this.getJson(`/regional/indonesia/${path}`, query);
    if (!out.ok) {
      return out.mode === 'auth'
        ? {
            status: 'REGIONAL_REFERENCE_AUTH_FAILURE',
            detail: sanitizeApiCoIdDetail(out.detail),
          }
        : {
            status: 'REGIONAL_REFERENCE_UNAVAILABLE',
            detail: sanitizeApiCoIdDetail(out.detail),
          };
    }
    if (out.payload.is_success !== true) {
      return { status: 'REGIONAL_REFERENCE_UNAVAILABLE', detail: 'MALFORMED_PAYLOAD' };
    }
    const references: NormalizedRegionalReference[] = [];
    for (const raw of dataItems(out.payload)) {
      const item = asRecord(raw);
      if (!item) continue;
      const normalized = normalizeRegionalItem(level, item);
      if (normalized) references.push(normalized);
    }
    return { status: 'AVAILABLE', references };
  }

  listIndonesiaProvinces(
    filter: IndonesiaRegionalFilter = {},
  ): Promise<RegionalReferencesResult> {
    return this.regional('provinces', 'province', filter);
  }

  listIndonesiaRegencies(
    filter: IndonesiaRegionalFilter = {},
  ): Promise<RegionalReferencesResult> {
    return this.regional('regencies', 'regency', filter);
  }

  listIndonesiaDistricts(
    filter: IndonesiaRegionalFilter = {},
  ): Promise<RegionalReferencesResult> {
    return this.regional('districts', 'district', filter);
  }

  listIndonesiaVillages(
    filter: IndonesiaRegionalFilter = {},
  ): Promise<RegionalReferencesResult> {
    return this.regional('villages', 'village', filter);
  }

  listIndonesiaPostalCodes(
    filter: IndonesiaRegionalFilter = {},
  ): Promise<RegionalReferencesResult> {
    return this.regional('postal-codes', 'postal_code', filter);
  }
}
