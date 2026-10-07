import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { ConfigError, resetAppConfigCache } from '../src/config';
import { resolveWhatsAppAdapter } from '../src/modules/whatsapp-delivery';
import {
  META_WHATSAPP_DEFAULTS,
  MetaWhatsAppAdapter,
  classifyMetaWhatsAppError,
  parseMetaWhatsAppTemplateMap,
  readMetaWhatsAppConfig,
  type MetaWhatsAppConfig,
  type MetaWhatsAppHttpRequest,
  type MetaWhatsAppHttpResponse,
  type MetaWhatsAppHttpTransport,
} from '../src/modules/whatsapp-delivery';
import { classifyProviderResult } from '../src/shared/provider-result';

/**
 * CR-BE-NOTIFY-PROV-01 PART 06 — Meta WhatsApp Business Cloud API adapter
 * (focused tests).
 *
 * Validates the gated provider adapter WITHOUT any external network:
 *   - boundary config reading/validation (token never in errors),
 *   - approved-template mapping requirement for business-initiated sends,
 *   - request construction through a MOCK HTTP transport (Bearer token in
 *     the header only, never in the body or errors),
 *   - Meta HTTP/error-code → PART 01 taxonomy mapping (retryable contract),
 *   - resolver wiring for WHATSAPP_PROVIDER=meta (the test-environment guard
 *     still blocks real providers under NODE_ENV=test).
 */

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'NODE_ENV',
  'WHATSAPP_PROVIDER',
  'WHATSAPP_META_ACCESS_TOKEN',
  'WHATSAPP_META_PHONE_NUMBER_ID',
  'WHATSAPP_META_API_BASE_URL',
  'WHATSAPP_META_API_VERSION',
  'WHATSAPP_META_TEMPLATE_MAP',
];

function snapshotEnv(): void {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  resetAppConfigCache();
}

afterEach(() => {
  restoreEnv();
});

function testConfig(overrides: Partial<MetaWhatsAppConfig> = {}): MetaWhatsAppConfig {
  return {
    accessToken: 'EAAG_SECRET_TOKEN_VALUE',
    phoneNumberId: '106543210987654',
    apiBaseUrl: META_WHATSAPP_DEFAULTS.apiBaseUrl,
    apiVersion: META_WHATSAPP_DEFAULTS.apiVersion,
    timeoutMs: META_WHATSAPP_DEFAULTS.timeoutMs,
    templateMap: {
      PROV06_WA: { name: 'work_order_assigned', language: 'en_US' },
    },
    ...overrides,
  };
}

/** Scripted mock HTTP transport — records requests, returns the response. */
function mockTransport(response: MetaWhatsAppHttpResponse | { throw: unknown }): {
  transport: MetaWhatsAppHttpTransport;
  calls: MetaWhatsAppHttpRequest[];
} {
  const calls: MetaWhatsAppHttpRequest[] = [];
  return {
    calls,
    transport: async (request: MetaWhatsAppHttpRequest) => {
      calls.push(request);
      if ('throw' in response) {
        throw response.throw;
      }
      return response;
    },
  };
}

describe('CR-BE-NOTIFY-PROV-01 PART 06 — Meta boundary configuration', () => {
  it('reads required keys and applies governed defaults', () => {
    snapshotEnv();
    const config = readMetaWhatsAppConfig({
      WHATSAPP_META_ACCESS_TOKEN: ' token-abc ',
      WHATSAPP_META_PHONE_NUMBER_ID: ' 12345 ',
    });
    assert.equal(config.accessToken, 'token-abc');
    assert.equal(config.phoneNumberId, '12345');
    assert.equal(config.apiBaseUrl, META_WHATSAPP_DEFAULTS.apiBaseUrl);
    assert.equal(config.apiVersion, META_WHATSAPP_DEFAULTS.apiVersion);
    assert.equal(config.timeoutMs, META_WHATSAPP_DEFAULTS.timeoutMs);
    assert.deepEqual(config.templateMap, {});
  });

  it('fails fast on missing required keys — field NAMES only, never the token', () => {
    assert.throws(
      () => readMetaWhatsAppConfig({ WHATSAPP_META_PHONE_NUMBER_ID: '1' }),
      (error: unknown) =>
        error instanceof ConfigError &&
        error.message.includes('WHATSAPP_META_ACCESS_TOKEN') &&
        !error.message.includes('EAAG'),
    );
    assert.throws(
      () => readMetaWhatsAppConfig({ WHATSAPP_META_ACCESS_TOKEN: 'x' }),
      (error: unknown) =>
        error instanceof ConfigError &&
        error.message.includes('WHATSAPP_META_PHONE_NUMBER_ID'),
    );
  });

  it('parses the approved-template map (shorthand + object forms)', () => {
    const map = parseMetaWhatsAppTemplateMap(
      JSON.stringify({
        KEY_A: 'approved_a',
        KEY_B: { name: 'approved_b', language: 'id_ID' },
        KEY_C: { name: 'approved_c' },
      }),
    );
    assert.deepEqual(map.KEY_A, { name: 'approved_a', language: 'en_US' });
    assert.deepEqual(map.KEY_B, { name: 'approved_b', language: 'id_ID' });
    assert.deepEqual(map.KEY_C, { name: 'approved_c', language: 'en_US' });
    assert.deepEqual(parseMetaWhatsAppTemplateMap(undefined), {});
    assert.deepEqual(parseMetaWhatsAppTemplateMap(''), {});
  });

  it('rejects malformed template maps at the boundary', () => {
    assert.throws(() => parseMetaWhatsAppTemplateMap('{not-json'),
      (e: unknown) => e instanceof ConfigError);
    assert.throws(() => parseMetaWhatsAppTemplateMap('[1,2]'),
      (e: unknown) => e instanceof ConfigError);
    assert.throws(() => parseMetaWhatsAppTemplateMap('{"K":{"language":"en_US"}}'),
      (e: unknown) => e instanceof ConfigError);
  });
});

describe('CR-BE-NOTIFY-PROV-01 PART 06 — Meta send through the mock transport', () => {
  it('sends an approved-template message for a mapped templateKey', async () => {
    const { transport, calls } = mockTransport({
      status: 200,
      body: JSON.stringify({ messages: [{ id: 'wamid.HBgLMTIzNDU2Nzg5MA' }] }),
    });
    const adapter = new MetaWhatsAppAdapter({ config: testConfig(), transport });

    const result = await adapter.send({
      to: '+628123456789',
      message: 'Captured message for John.',
      templateKey: 'PROV06_WA',
    });

    assert.equal(result.status, 'SENT');
    assert.equal(result.providerMessageId, 'wamid.HBgLMTIzNDU2Nzg5MA');
    assert.equal(result.providerReference, result.providerMessageId);

    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      `${META_WHATSAPP_DEFAULTS.apiBaseUrl}/${META_WHATSAPP_DEFAULTS.apiVersion}/106543210987654/messages`,
    );
    assert.equal(calls[0].headers.Authorization, 'Bearer EAAG_SECRET_TOKEN_VALUE');
    const payload = JSON.parse(calls[0].body);
    assert.deepEqual(payload, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '+628123456789',
      type: 'template',
      template: {
        name: 'work_order_assigned',
        language: { code: 'en_US' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: 'Captured message for John.' }] },
        ],
      },
    });
    // The token never appears in the request body.
    assert.ok(!calls[0].body.includes('EAAG_SECRET_TOKEN_VALUE'));
  });

  it('sends a session text message when no templateKey is present', async () => {
    const { transport, calls } = mockTransport({ status: 200, body: '{"messages":[{"id":"wamid.X"}]}' });
    const adapter = new MetaWhatsAppAdapter({ config: testConfig(), transport });

    const result = await adapter.send({ to: '+628123456789', message: 'Session reply.' });
    assert.equal(result.status, 'SENT');
    assert.equal(JSON.parse(calls[0].body).type, 'text');
    assert.deepEqual(JSON.parse(calls[0].body).text, { body: 'Session reply.' });
  });

  it('rejects permanently WITHOUT an HTTP call when the approved-template mapping is missing', async () => {
    const { transport, calls } = mockTransport({ status: 200, body: '{}' });
    const adapter = new MetaWhatsAppAdapter({ config: testConfig(), transport });

    const result = await adapter.send({
      to: '+628123456789',
      message: 'm',
      templateKey: 'UNMAPPED_TEMPLATE',
    });
    assert.equal(result.status, 'FAILED');
    assert.equal(result.retryable, false);
    assert.match(result.error as string, /UNMAPPED_TEMPLATE/);
    assert.equal(classifyProviderResult(result), 'REJECTED_PERMANENT');
    assert.equal(calls.length, 0);
  });

  it('maps Meta failures through the taxonomy', async () => {
    const cases: Array<{
      response: MetaWhatsAppHttpResponse;
      retryable: boolean;
      outcome: 'REJECTED_RETRYABLE' | 'REJECTED_PERMANENT';
    }> = [
      // Rate limiting / server errors → retryable.
      { response: { status: 429, body: '{"error":{"message":"Too many calls","code":4}}' }, retryable: true, outcome: 'REJECTED_RETRYABLE' },
      { response: { status: 503, body: '' }, retryable: true, outcome: 'REJECTED_RETRYABLE' },
      // Auth failures → permanent.
      { response: { status: 401, body: '{"error":{"message":"Invalid OAuth access token","code":190}}' }, retryable: false, outcome: 'REJECTED_PERMANENT' },
      { response: { status: 403, body: '{"error":{"message":"Permission denied","code":200}}' }, retryable: false, outcome: 'REJECTED_PERMANENT' },
      // Message-policy rejects → permanent.
      { response: { status: 400, body: '{"error":{"message":"Re-engagement message failed","code":131047}}' }, retryable: false, outcome: 'REJECTED_PERMANENT' },
      { response: { status: 400, body: '{"error":{"message":"Message undeliverable","code":131026}}' }, retryable: false, outcome: 'REJECTED_PERMANENT' },
      // Meta throttling family (130xxx) → retryable.
      { response: { status: 400, body: '{"error":{"message":"Throughput limit exceeded","code":130429}}' }, retryable: true, outcome: 'REJECTED_RETRYABLE' },
    ];

    for (const testCase of cases) {
      const { transport } = mockTransport(testCase.response);
      const adapter = new MetaWhatsAppAdapter({ config: testConfig(), transport });
      const result = await adapter.send({ to: '+628123456789', message: 'm' });
      assert.equal(result.status, 'FAILED');
      assert.equal(result.retryable, testCase.retryable);
      assert.equal(classifyProviderResult(result), testCase.outcome);
    }
  });

  it('treats network failures as retryable and sanitizes credential-like error text', async () => {
    const { transport } = mockTransport({
      throw: new Error('fetch failed token=EAAG_SECRET_TOKEN_VALUE'),
    });
    const adapter = new MetaWhatsAppAdapter({ config: testConfig(), transport });

    const result = await adapter.send({ to: '+628123456789', message: 'm' });
    assert.equal(result.status, 'FAILED');
    assert.equal(result.retryable, true);
    assert.ok(!(result.error as string).includes('EAAG_SECRET_TOKEN_VALUE'));
    assert.match(result.error as string, /\[REDACTED\]/);
    assert.equal(classifyProviderResult(result), 'REJECTED_RETRYABLE');
  });

  it('accepts a 2xx with an unparsable body (SENT, no provider message id)', async () => {
    const { transport } = mockTransport({ status: 200, body: 'not json' });
    const adapter = new MetaWhatsAppAdapter({ config: testConfig(), transport });
    const result = await adapter.send({ to: '+628123456789', message: 'm' });
    assert.equal(result.status, 'SENT');
    assert.equal(result.providerMessageId, null);
  });
});

describe('CR-BE-NOTIFY-PROV-01 PART 06 — Meta error classifier', () => {
  it('classifies network/timeout, HTTP families, and Meta code families', () => {
    assert.equal(classifyMetaWhatsAppError({ message: 'x', network: true }).retryable, true);
    assert.equal(classifyMetaWhatsAppError({ message: 'x', status: 429 }).retryable, true);
    assert.equal(classifyMetaWhatsAppError({ message: 'x', status: 500 }).retryable, true);
    assert.equal(classifyMetaWhatsAppError({ message: 'x', status: 401 }).retryable, false);
    assert.equal(classifyMetaWhatsAppError({ message: 'x', status: 403 }).retryable, false);
    assert.equal(classifyMetaWhatsAppError({ message: 'x', status: 400, code: 131051 }).retryable, false);
    assert.equal(classifyMetaWhatsAppError({ message: 'x', status: 400, code: 130001 }).retryable, true);
    // Unclassified (no status, not network) → retryable within the budget.
    assert.equal(classifyMetaWhatsAppError({ message: 'x' }).retryable, true);
  });
});

describe('CR-BE-NOTIFY-PROV-01 PART 06 — resolver wiring', () => {
  it('still blocks meta under NODE_ENV=test (credential-less providers only)', () => {
    snapshotEnv();
    process.env.NODE_ENV = 'test';
    process.env.WHATSAPP_PROVIDER = 'meta';
    resetAppConfigCache();
    assert.throws(
      () => resolveWhatsAppAdapter(),
      (error: unknown) =>
        error instanceof ConfigError &&
        error.message.includes('test environment') &&
        error.message.includes('noop, capture'),
    );
  });

  it('resolves the meta adapter outside the test environment with valid boundary config', () => {
    snapshotEnv();
    process.env.NODE_ENV = 'development';
    process.env.WHATSAPP_PROVIDER = 'meta';
    process.env.WHATSAPP_META_ACCESS_TOKEN = 'EAAG_TEST_ONLY';
    process.env.WHATSAPP_META_PHONE_NUMBER_ID = '106543210987654';
    resetAppConfigCache();

    // Construction validates config but performs NO HTTP request (send was
    // never called), so this wiring test stays network-free.
    const adapter = resolveWhatsAppAdapter();
    assert.equal(adapter.provider, 'meta');
  });

  it('fails fast at resolution when the Meta boundary config is incomplete', () => {
    snapshotEnv();
    process.env.NODE_ENV = 'development';
    process.env.WHATSAPP_PROVIDER = 'meta';
    delete process.env.WHATSAPP_META_ACCESS_TOKEN;
    delete process.env.WHATSAPP_META_PHONE_NUMBER_ID;
    resetAppConfigCache();
    assert.throws(() => resolveWhatsAppAdapter(), (e: unknown) => e instanceof ConfigError);
  });

  it('lists meta among available providers for unimplemented discriminators', () => {
    snapshotEnv();
    process.env.NODE_ENV = 'development';
    process.env.WHATSAPP_PROVIDER = 'twilio';
    resetAppConfigCache();
    assert.throws(
      () => resolveWhatsAppAdapter(),
      (error: unknown) =>
        error instanceof ConfigError &&
        error.message.includes('no WhatsApp adapter is implemented') &&
        error.message.includes('noop, capture, meta'),
    );
  });
});
