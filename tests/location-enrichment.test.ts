import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  ApiCoIdLocationAdapter,
  createLocationEnrichmentProviders,
  readApiCoIdLocationConfig,
  sanitizeApiCoIdDetail,
} from '../src/modules/location-enrichment';
import type {
  ApiCoIdHttpRequest,
  ApiCoIdHttpResponse,
  ApiCoIdLocationConfig,
} from '../src/modules/location-enrichment';
import { ConfigError } from '../src/config';

/**
 * CR-HM-07 PART 03C — API.CO.ID location adapter (provider-neutral
 * external location enrichment). Ten cases prove: contract-correct
 * requests (host/path/query/x-api-co-id header), bounded DTO
 * normalization, raw-payload containment, Indonesia regional hierarchy
 * + postal-code normalization with preserved provider identifiers,
 * bounded unavailable/auth outcomes (timeout, network, 5xx, malformed,
 * 401/403) with secret containment, and STRUCTURAL proof that
 * enrichment can never mutate expected-location / geospatial-policy /
 * geofence / verdict / challenge / QR / work-session / attendance /
 * payment-BAST / FM authorities (the module has zero database and zero
 * arrival-module coupling). No live network: an injected transport is
 * used everywhere (repo webhook/meta-whatsa adapter pattern).
 */

const CONFIG: ApiCoIdLocationConfig = {
  apiKey: 'TESTSECRET_API_CO_ID_KEY_9f7c2e',
  apiBaseUrl: 'https://use.api.co.id',
  timeoutMs: 1_234,
};

type Captured = { requests: ApiCoIdHttpRequest[] };

function fakeTransport(
  responder: (req: ApiCoIdHttpRequest) => Promise<ApiCoIdHttpResponse>,
): { transport: (r: ApiCoIdHttpRequest) => Promise<ApiCoIdHttpResponse>;
  captured: Captured } {
  const captured: Captured = { requests: [] };
  return {
    captured,
    transport: async (req) => {
      captured.requests.push(req);
      return responder(req);
    },
  };
}

function jsonResponse(body: unknown, status = 200): ApiCoIdHttpResponse {
  return { status, bodyText: JSON.stringify(body) };
}

const REVERSE_GEOCODE_PAYLOAD = {
  is_success: true,
  message: 'Success',
  data: {
    place_id: 54_637_009,
    display_name:
      'Jalan RS. Mata Aini, Karet, Setiabudi, Jakarta Selatan, DKI Jakarta, 12910, Indonesia',
    lat: '-6.2145938',
    lon: '106.8289057',
    address: {
      road: 'Jalan RS. Mata Aini',
      kelurahan: 'Karet',
      kecamatan: 'Setiabudi',
      regency: 'Jakarta Selatan',
      province: 'DKI Jakarta',
      postcode: '12910',
      country: 'Indonesia',
    },
    extratags: { lanes: '1', surface: 'asphalt' },
    boundingbox: ['-6.2149649', '-6.2134748', '106.8288502', '106.8291525'],
  },
};

const MODULE_DIR = join(__dirname, '..', 'src', 'modules',
  'location-enrichment');

function moduleSources(): { file: string; source: string }[] {
  return readdirSync(MODULE_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((file) => ({
      file,
      source: readFileSync(join(MODULE_DIR, file), 'utf8'),
    }))
    .filter((x) => statSync(join(MODULE_DIR, x.file)).isFile());
}

describe('CR-HM-07 PART 03C — API.CO.ID location adapter', () => {
  it('1: adapter sends lat/lon query + x-api-co-id header exactly', async () => {
    const { transport, captured } = fakeTransport(async () =>
      jsonResponse(REVERSE_GEOCODE_PAYLOAD));
    const adapter = new ApiCoIdLocationAdapter({ config: CONFIG, transport });
    await adapter.reverseGeocode({ latitude: -6.2, longitude: 106.816666 });
    assert.equal(captured.requests.length, 1);
    const req = captured.requests[0];
    const url = new URL(req.url);
    assert.equal(`${url.protocol}//${url.host}`, 'https://use.api.co.id');
    assert.equal(url.pathname, '/location/reverse-geocode');
    assert.equal(url.searchParams.get('lat'), '-6.2');
    assert.equal(url.searchParams.get('lon'), '106.816666');
    assert.equal(url.searchParams.get('key'), null,
      'API key must never be a query parameter');
    assert.equal(Object.keys(req.headers).join(','), 'x-api-co-id',
      'exactly one auth header');
    assert.equal(req.headers['x-api-co-id'], CONFIG.apiKey);
    assert.equal(req.timeoutMs, 1_234, 'bounded timeout propagated');
    // Invalid caller coordinates fail closed before any transport call.
    const before = captured.requests.length;
    await assert.rejects(
      () => adapter.reverseGeocode({ latitude: 91, longitude: 0 }),
      /LOCATION_ENRICHMENT_INPUT_INVALID/,
    );
    assert.equal(captured.requests.length, before,
      'no provider call for invalid input');
  });

  it('2: reverse-geocode success normalizes bounded internal DTO', async () => {
    const { transport } = fakeTransport(async () =>
      jsonResponse(REVERSE_GEOCODE_PAYLOAD));
    const adapter = new ApiCoIdLocationAdapter({ config: CONFIG, transport });
    const result = await adapter.reverseGeocode({
      latitude: -6.2145938,
      longitude: 106.8289057,
    });
    assert.equal(result.status, 'AVAILABLE');
    if (result.status !== 'AVAILABLE') return;
    assert.deepEqual(result.address, {
      displayName: REVERSE_GEOCODE_PAYLOAD.data.display_name,
      road: 'Jalan RS. Mata Aini',
      village: 'Karet',
      district: 'Setiabudi',
      regency: 'Jakarta Selatan',
      province: 'DKI Jakarta',
      postalCode: '12910',
      country: 'Indonesia',
      providerPlaceId: '54637009',
    });
  });

  it('3: raw provider payload is never exposed', async () => {
    const { transport } = fakeTransport(async () =>
      jsonResponse(REVERSE_GEOCODE_PAYLOAD));
    const adapter = new ApiCoIdLocationAdapter({ config: CONFIG, transport });
    const result = await adapter.reverseGeocode({
      latitude: -6.2, longitude: 106.8,
    });
    assert.deepEqual(Object.keys(result).sort(), ['address', 'status']);
    if (result.status !== 'AVAILABLE') return;
    assert.deepEqual(Object.keys(result.address).sort(), [
      'country', 'displayName', 'district', 'postalCode',
      'providerPlaceId', 'province', 'regency', 'road', 'village',
    ]);
    const raw = JSON.stringify(result);
    for (const leaked of [
      'boundingbox', 'extratags', 'is_success', 'display_name',
      'osm', '-6.2149649', 'lanes',
    ]) {
      assert.equal(raw.includes(leaked), false,
        `raw provider field leaked: ${leaked}`);
    }
  });

  it('4: province/regency/district/village normalization with hierarchy', async () => {
    const calls: string[] = [];
    const { transport, captured } = fakeTransport(async (req) => {
      const url = new URL(req.url);
      calls.push(`${url.pathname}?${url.searchParams.toString()}`);
      if (url.pathname === '/regional/indonesia/provinces') {
        return jsonResponse({ is_success: true, message: 'Success', data: [
          { code: '11', name: 'ACEH' },
          { code: '31', name: 'DKI JAKARTA' },
        ] });
      }
      if (url.pathname === '/regional/indonesia/regencies') {
        return jsonResponse({ is_success: true, message: 'Success', data: [
          { code: '1101', name: 'KABUPATEN SIMEULUE', province_code: '11',
            province: 'ACEH' },
        ] });
      }
      if (url.pathname === '/regional/indonesia/districts') {
        return jsonResponse({ is_success: true, message: 'Success',
          data: { code: '110101', name: 'TEUPAH SELATAN',
            regency_code: '1101', regency: 'KABUPATEN SIMEULUE',
            province_code: '11', province: 'ACEH' } });
      }
      return jsonResponse({ is_success: true, message: 'Success', data: [
        { code: '1101010001', name: 'LATIUNG', district_code: '110101',
          district: 'TEUPAH SELATAN', regency_code: '1101',
          regency: 'KABUPATEN SIMEULUE', province_code: '11',
          province: 'ACEH', postal_codes: ['23891'] },
      ] });
    });
    const adapter = new ApiCoIdLocationAdapter({ config: CONFIG, transport });
    const provinces = await adapter.listIndonesiaProvinces();
    assert.equal(provinces.status, 'AVAILABLE');
    if (provinces.status !== 'AVAILABLE') return;
    assert.deepEqual(provinces.references[0], {
      level: 'province', code: '11', name: 'ACEH',
      provinceCode: '11', province: 'ACEH',
      regencyCode: null, regency: null, districtCode: null,
      district: null, villageCode: null, village: null,
      postalCodes: [], postalCode: null,
    });
    assert.equal(provinces.references[1].code, '31');
    const regencies = await adapter.listIndonesiaRegencies({
      provinceCode: '11',
    });
    assert.equal(regencies.status, 'AVAILABLE');
    if (regencies.status !== 'AVAILABLE') return;
    assert.deepEqual(regencies.references[0], {
      level: 'regency', code: '1101', name: 'KABUPATEN SIMEULUE',
      provinceCode: '11', province: 'ACEH',
      regencyCode: '1101', regency: 'KABUPATEN SIMEULUE',
      districtCode: null, district: null, villageCode: null,
      village: null, postalCodes: [], postalCode: null,
    });
    const districts = await adapter.listIndonesiaDistricts({
      regencyCode: '1101',
    });
    assert.equal(districts.status, 'AVAILABLE');
    if (districts.status !== 'AVAILABLE') return;
    assert.equal(districts.references[0].code, '110101');
    assert.equal(districts.references[0].districtCode, '110101');
    assert.equal(districts.references[0].regencyCode, '1101');
    assert.equal(districts.references.length, 1,
      'single-object data normalizes as a one-item list');
    const villages = await adapter.listIndonesiaVillages({
      districtCode: '110101',
    });
    assert.equal(villages.status, 'AVAILABLE');
    if (villages.status !== 'AVAILABLE') return;
    assert.deepEqual(villages.references[0], {
      level: 'village', code: '1101010001', name: 'LATIUNG',
      provinceCode: '11', province: 'ACEH', regencyCode: '1101',
      regency: 'KABUPATEN SIMEULUE', districtCode: '110101',
      district: 'TEUPAH SELATAN', villageCode: '1101010001',
      village: 'LATIUNG', postalCodes: ['23891'], postalCode: null,
    });
    assert.deepEqual(calls.map((c) => c.split('?')[1] ?? ''), [
      '', 'province_code=11', 'regency_code=1101', 'district_code=110101',
    ], 'hierarchy filters map to provider query parameters');
  });

  it('5: postal-code references normalized with identifier preserved', async () => {
    const { transport, captured } = fakeTransport(async () =>
      jsonResponse({ is_success: true, message: 'Success', data: [
        { id: 1, postal_code: '23891', village_code: '1101010001',
          village: 'LATIUNG', district_code: '110101',
          district: 'TEUPAH SELATAN', regency_code: '1101',
          regency: 'KABUPATEN SIMEULUE', province_code: '11',
          province: 'ACEH' },
      ], paging: { page: 1, size: 100, total_item: 81_574,
        total_page: 816 } }));
    const adapter = new ApiCoIdLocationAdapter({ config: CONFIG, transport });
    const result = await adapter.listIndonesiaPostalCodes({
      postalCode: '23891',
    });
    assert.equal(result.status, 'AVAILABLE');
    if (result.status !== 'AVAILABLE') return;
    assert.deepEqual(result.references, [{
      level: 'postal_code', code: '23891', name: '23891',
      provinceCode: '11', province: 'ACEH', regencyCode: '1101',
      regency: 'KABUPATEN SIMEULUE', districtCode: '110101',
      district: 'TEUPAH SELATAN', villageCode: '1101010001',
      village: 'LATIUNG', postalCodes: [], postalCode: '23891',
    }]);
    const raw = JSON.stringify(result);
    assert.equal(raw.includes('total_item'), false,
      'paging envelope must not leak');
    assert.equal(raw.includes('"id"'), false, 'provider id not exposed');
    assert.ok(captured.requests[0].url.includes('postal_code=23891'));
    assert.ok(captured.requests[0].url.includes(
      '/regional/indonesia/postal-codes'));
  });

  it('6: timeout/network/5xx map to bounded UNAVAILABLE', async () => {
    const abortAbort = new ApiCoIdLocationAdapter({
      config: CONFIG,
      transport: async () => {
        const e = new Error('aborted'); e.name = 'AbortError'; throw e;
      },
    });
    const timeout = await abortAbort.reverseGeocode({
      latitude: -6.2, longitude: 106.8,
    });
    assert.deepEqual(timeout, {
      status: 'REVERSE_GEOCODE_UNAVAILABLE',
      detail: 'HTTP_TIMEOUT_1234ms',
    });
    const network = new ApiCoIdLocationAdapter({
      config: CONFIG,
      transport: async () => {
        throw new TypeError('fetch failed');
      },
    });
    assert.equal(
      (await network.reverseGeocode({ latitude: -6.2, longitude: 106.8 }))
        .status,
      'REVERSE_GEOCODE_UNAVAILABLE',
    );
    assert.equal(
      (await network.listIndonesiaProvinces()).status,
      'REGIONAL_REFERENCE_UNAVAILABLE',
    );
    const serverError = new ApiCoIdLocationAdapter({
      config: CONFIG,
      transport: async () => ({ status: 503, bodyText: '<html/>' }),
    });
    assert.deepEqual(await serverError.reverseGeocode({
      latitude: -6.2, longitude: 106.8,
    }), { status: 'REVERSE_GEOCODE_UNAVAILABLE', detail: 'HTTP_503' });
    const regional500 = await serverError.listIndonesiaDistricts();
    assert.deepEqual(regional500, {
      status: 'REGIONAL_REFERENCE_UNAVAILABLE', detail: 'HTTP_503',
    });
  });

  it('7: malformed provider responses map to bounded UNAVAILABLE', async () => {
    const badJson = new ApiCoIdLocationAdapter({
      config: CONFIG,
      transport: async () => ({ status: 200, bodyText: '<<not json>>' }),
    });
    assert.deepEqual(await badJson.reverseGeocode({
      latitude: -6.2, longitude: 106.8,
    }), { status: 'REVERSE_GEOCODE_UNAVAILABLE', detail: 'MALFORMED_JSON' });
    const failed = new ApiCoIdLocationAdapter({
      config: CONFIG,
      transport: async () =>
        jsonResponse({ is_success: false, message: 'FAILED', data: null }),
    });
    assert.deepEqual(await failed.listIndonesiaProvinces(), {
      status: 'REGIONAL_REFERENCE_UNAVAILABLE',
      detail: 'MALFORMED_PAYLOAD',
    });
    const wrongData = new ApiCoIdLocationAdapter({
      config: CONFIG,
      transport: async () =>
        jsonResponse({ is_success: true, message: 'ok', data: 'nope' }),
    });
    assert.deepEqual(
      await wrongData.reverseGeocode({ latitude: -6.2, longitude: 106.8 }),
      { status: 'REVERSE_GEOCODE_UNAVAILABLE', detail: 'MALFORMED_PAYLOAD' },
    );
    // Non-object regional items are dropped silently (bounded empty).
    const junkItems = new ApiCoIdLocationAdapter({
      config: CONFIG,
      transport: async () =>
        jsonResponse({ is_success: true, message: 'ok', data: [1, 'x'] }),
    });
    const junk = await junkItems.listIndonesiaVillages();
    assert.deepEqual(junk, { status: 'AVAILABLE', references: [] });
  });

  it('8: 401/403 are bounded auth failures; the API key is never exposed', async () => {
    const { transport } = fakeTransport(async () =>
      ({ status: 401, bodyText: '{"is_success":false}' }));
    const unauthorized = new ApiCoIdLocationAdapter({
      config: CONFIG, transport,
    });
    const rg = await unauthorized.reverseGeocode({
      latitude: -6.2, longitude: 106.8,
    });
    assert.deepEqual(rg, {
      status: 'REVERSE_GEOCODE_AUTH_FAILURE', detail: 'HTTP_401',
    });
    const reg = await unauthorized.listIndonesiaVillages();
    assert.deepEqual(reg, {
      status: 'REGIONAL_REFERENCE_AUTH_FAILURE', detail: 'HTTP_401',
    });
    const forbiddenAdapter = new ApiCoIdLocationAdapter({
      config: CONFIG,
      transport: async () => ({ status: 403, bodyText: 'forbidden' }),
    });
    assert.equal(
      (await forbiddenAdapter.listIndonesiaProvinces()).detail,
      'HTTP_403',
    );
    for (const outcome of [rg, reg]) {
      assert.equal(JSON.stringify(outcome).includes(CONFIG.apiKey), false,
        'auth failure must never leak the API key');
    }
    // Even when the transport error message CONTAINS the key, the
    // sanitizer redacts it before anything is returned.
    const leakyTransport = new ApiCoIdLocationAdapter({
      config: CONFIG,
      transport: async () => {
        throw new Error(`connect ECONNREFUSED x-api-co-id: ${CONFIG.apiKey}`);
      },
    });
    const leaky = await leakyTransport.reverseGeocode({
      latitude: -6.2, longitude: 106.8,
    });
    assert.equal(JSON.stringify(leaky).includes(CONFIG.apiKey), false,
      'transport error path must never leak the API key');
    assert.equal(leaky.status, 'REVERSE_GEOCODE_UNAVAILABLE');
    // Sanitizer unit-level: key-shaped fragments are redacted.
    const clean = sanitizeApiCoIdDetail(
      `boom api_key=${CONFIG.apiKey} token: ${CONFIG.apiKey}`);
    assert.equal(clean.includes(CONFIG.apiKey), false);
    assert.ok(clean.includes('[REDACTED]'));
    // Missing key at construction: ConfigError names the FIELD only.
    assert.throws(
      () => new ApiCoIdLocationAdapter({
        config: { ...CONFIG, apiKey: ' ' },
      }),
      (error: unknown) =>
        error instanceof ConfigError &&
        (error as Error).message.includes('API_CO_ID_API_KEY') &&
        !(error as Error).message.includes(CONFIG.apiKey),
    );
    assert.throws(
      () => readApiCoIdLocationConfig({
        API_CO_ID_API_KEY: 'x',
        API_CO_ID_BASE_URL: 'http://use.api.co.id',
      }),
      (error: unknown) =>
        error instanceof ConfigError &&
        (error as Error).message.includes('API_CO_ID_BASE_URL'),
    );
    assert.throws(
      () => readApiCoIdLocationConfig({}),
      (error: unknown) =>
        error instanceof ConfigError &&
        (error as Error).message.includes('API_CO_ID_API_KEY'),
    );
    assert.throws(
      () => readApiCoIdLocationConfig({
        API_CO_ID_API_KEY: 'x',
        API_CO_ID_TIMEOUT_MS: '0',
      }),
      (error: unknown) =>
        error instanceof ConfigError &&
        (error as Error).message.includes('API_CO_ID_TIMEOUT_MS'),
    );
  });

  it('9: enrichment cannot mutate expected location/policies/geofence/verdict', async () => {
    // Structural: the entire module has zero database and zero arrival-
    // authority coupling; it can only ever READ the network via the
    // injected transport.
    for (const { file, source } of moduleSources()) {
      assert.equal(
        /from\s+['"]\.\.?\/.+(arrival|geospatial|challenge|qr|check-in|attendance|payment|bast)/i
          .test(source),
        false,
        `forbidden authority import in ${file}`,
      );
      assert.equal(/\b(from|require)\b.*\b(database|pg)\b/i.test(source),
        false, `database import in ${file}`);
      assert.equal(/\bgetPool\b|\bwithTransaction\b/i.test(source), false,
        `persistence plumbing in ${file}`);
      assert.equal(/\b(INSERT|UPDATE|DELETE)\s+(INTO|FROM)\b/i.test(source),
        false, `write statement in ${file}`);
    }
    // Behavioral: provider payloads carrying authority-shaped extras
    // cannot leak INTO the bounded DTO.
    const { transport } = fakeTransport(async () => jsonResponse({
      is_success: true, message: 'Success',
      data: {
        ...REVERSE_GEOCODE_PAYLOAD.data,
        buildingId: '11111111-2222-3333-4444-555555555555',
        policyId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        geofenceRadiusMeters: 1,
        expectedLocation: { buildingId: 'spoofed' },
        signal: 'OUTSIDE',
        verdict: 'FAILED',
      },
    }));
    const adapter = new ApiCoIdLocationAdapter({ config: CONFIG, transport });
    const result = await adapter.reverseGeocode({
      latitude: -6.2, longitude: 106.8,
    });
    const raw = JSON.stringify(result);
    for (const injected of [
      'buildingId', 'policyId', 'geofenceRadius', 'expectedLocation',
      'verdict', 'signal', 'spoofed', 'FAILED', 'aaaaaaaa',
    ]) {
      assert.equal(raw.includes(injected), false,
        `authority-shaped field leaked into DTO: ${injected}`);
    }
    assert.equal(result.status, 'AVAILABLE',
      'extras do not break normalization for legitimate payloads');
    // Composition root returns ONLY the neutral interfaces.
    const providers = createLocationEnrichmentProviders({
      config: CONFIG, transport,
    });
    assert.deepEqual(Object.keys(providers).sort(), [
      'locationEnrichment', 'regionalReference',
    ]);
    assert.equal(typeof providers.locationEnrichment.reverseGeocode,
      'function');
    assert.equal(typeof providers.regionalReference.listIndonesiaProvinces,
      'function');
  });

  it('10: zero challenge/QR/work-session/attendance/payment/BAST/FM surfaces', async () => {
    // Construction performs NO transport call (no eager network).
    const { transport, captured } = fakeTransport(async () =>
      jsonResponse(REVERSE_GEOCODE_PAYLOAD));
    const adapter = new ApiCoIdLocationAdapter({ config: CONFIG, transport });
    assert.equal(captured.requests.length, 0,
      'no provider call at construction');
    void adapter;
    // Read-only production transport: the sole request method is GET.
    const adapterSource = readFileSync(
      join(MODULE_DIR, 'api-co-id-location.adapter.ts'), 'utf8');
    const methods = adapterSource.match(/method:\s*'([A-Z]+)'/g) ?? [];
    assert.deepEqual(methods, ["method: 'GET'"],
      'adapter issues read-only GET requests only');
    for (const { file, source } of moduleSources()) {
      for (const token of [
        'handyman-arrival', 'handyman-geospatial', 'work_session',
        'workorder', 'work_order', 'bast', 'attendance-record',
        'operational_events', 'evidence_submissions',
      ]) {
        assert.equal(source.includes(token), false,
          `forbidden side-effect token '${token}' in ${file}`);
      }
    }
    // Index surface is exactly the PART 03C contract — nothing else.
    const index = readFileSync(join(MODULE_DIR, 'index.ts'), 'utf8');
    const exported = [
      ...[...index.matchAll(/export\s+\{([^}]+)\}/gs)]
        .flatMap((m) => m[1].split(','))
        .map((s) => s.replace(/\/\*[^]*?\*\//g, '').trim())
        .filter((s) => s.length > 0 && !s.startsWith('type'))
        .map((s) => s.replace(/\s*\n\s*/g, '')),
      ...[...index.matchAll(/export\s+function\s+(\w+)/g)]
        .map((m) => m[1]),
    ].sort();
    assert.deepEqual(exported, [
      'API_CO_ID_DEFAULTS',
      'ApiCoIdLocationAdapter',
      'REGIONAL_REFERENCE_RESULT_STATUSES',
      'REVERSE_GEOCODE_RESULT_STATUSES',
      'createFetchApiCoIdTransport',
      'createLocationEnrichmentProviders',
      'readApiCoIdLocationConfig',
      'sanitizeApiCoIdDetail',
    ], 'module exports exactly the PART 03C contract');
    // Result taxonomies are the full bounded outcome space.
    const { REGIONAL_REFERENCE_RESULT_STATUSES,
      REVERSE_GEOCODE_RESULT_STATUSES } =
      await import('../src/modules/location-enrichment');
    assert.deepEqual([...REGIONAL_REFERENCE_RESULT_STATUSES].sort(), [
      'AVAILABLE', 'REGIONAL_REFERENCE_AUTH_FAILURE',
      'REGIONAL_REFERENCE_UNAVAILABLE',
    ]);
    assert.deepEqual([...REVERSE_GEOCODE_RESULT_STATUSES].sort(), [
      'AVAILABLE', 'REVERSE_GEOCODE_AUTH_FAILURE',
      'REVERSE_GEOCODE_UNAVAILABLE',
    ]);
  });
});
