import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';
import { ConfigError, resetAppConfigCache } from '../src/config';
import {
  AVAILABLE_PUSH_PROVIDERS,
  CREDENTIAL_LESS_PUSH_PROVIDERS,
  CapturePushAdapter,
  NoopPushAdapter,
  PUSH_DELIVERY_OUTCOMES,
  PUSH_ERROR_CODES,
  PUSH_PAYLOAD_LIMITS,
  classifyPushResult,
  isPushDeliveryOutcome,
  isPushErrorCode,
  isRetryablePushOutcome,
  pushTokenFingerprint,
  resolvePushAdapter,
  validatePushPayload,
  type PushSendInput,
} from '../src/modules/push-delivery/push-adapter';
import {
  FCM_PUSH_DEFAULTS,
  FcmPushAdapter,
  buildFcmAssertion,
  classifyFcmError,
  normalizeFcmPrivateKey,
  parseFcmErrorBody,
  readFcmPushConfig,
  sanitizeFcmError,
  type FcmHttpRequest,
  type FcmHttpResponse,
  type FcmPushConfig,
} from '../src/modules/push-delivery/fcm-push-adapter';

/**
 * CR-BE-PUSH-01 PART 02 — provider adapter and secure configuration.
 *
 * These tests are DELIBERATELY database-free and network-free:
 *  - no PostgreSQL (PART 02 touches no table),
 *  - no outbound HTTP (the FCM transport is injected),
 *  - no real credential (the RSA key pair is generated in-process).
 *
 * They assert the four things PART 02 is accountable for:
 *  1. the adapter contract and its normalized taxonomy,
 *  2. the secure configuration boundary (credentials never reach AppConfig,
 *     never appear in an error, fail closed when missing),
 *  3. the FCM error → taxonomy mapping, including the narrow conditions under
 *     which a token may be declared dead,
 *  4. that the adapter performs NO side effect — it classifies and returns.
 */

// ---------------------------------------------------------------------------
// Environment scaffolding
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  'NODE_ENV',
  'PUSH_PROVIDER',
  'PUSH_FCM_PROJECT_ID',
  'PUSH_FCM_CLIENT_EMAIL',
  'PUSH_FCM_PRIVATE_KEY',
  'PUSH_FCM_API_BASE_URL',
  'PUSH_FCM_TOKEN_URI',
] as const;

let savedEnv: Record<string, string | undefined> = {};

function snapshotEnv(): void {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  savedEnv = {};
  resetAppConfigCache();
}

afterEach(restoreEnv);

// A real (throwaway) RSA key pair so signing is exercised for real without a
// real Google service account ever being involved.
const { privateKey: TEST_PRIVATE_KEY, publicKey: TEST_PUBLIC_KEY } = generateKeyPairSync(
  'rsa',
  {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  },
);

const TEST_CONFIG: FcmPushConfig = {
  projectId: 'asentra-test-project',
  clientEmail: 'push-sender@asentra-test-project.iam.gserviceaccount.com',
  privateKey: TEST_PRIVATE_KEY,
  apiBaseUrl: 'https://fcm.googleapis.com',
  tokenUri: 'https://oauth2.googleapis.com/token',
  timeoutMs: 20_000,
};

const VALID_INPUT: PushSendInput = {
  token: 'dEvIcE-ToKeN-0123456789abcdefghijklmnopqrstuvwxyz',
  platform: 'ANDROID',
  title: 'New assignment',
  body: 'You have a new patrol assignment.',
  data: {
    notificationId: '11111111-1111-4111-8111-111111111111',
    entityType: 'ASSIGNMENT',
    entityId: '22222222-2222-4222-8222-222222222222',
    eventType: 'ASSIGNMENT_CREATED',
  },
  deliveryId: '33333333-3333-4333-8333-333333333333',
};

/** Records every request so the test can assert the wire shape. */
function recordingTransport(
  responder: (request: FcmHttpRequest) => FcmHttpResponse | Promise<FcmHttpResponse>,
): { transport: (r: FcmHttpRequest) => Promise<FcmHttpResponse>; calls: FcmHttpRequest[] } {
  const calls: FcmHttpRequest[] = [];
  return {
    calls,
    transport: async (request: FcmHttpRequest) => {
      calls.push(request);
      return responder(request);
    },
  };
}

function fcmError(errorCode: string, status: string, message = 'rejected'): string {
  return JSON.stringify({
    error: {
      code: 400,
      message,
      status,
      details: [
        {
          '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
          errorCode,
        },
      ],
    },
  });
}

function adapterWith(
  responder: (request: FcmHttpRequest) => FcmHttpResponse | Promise<FcmHttpResponse>,
): { adapter: FcmPushAdapter; calls: FcmHttpRequest[] } {
  const { transport, calls } = recordingTransport(responder);
  return {
    calls,
    adapter: new FcmPushAdapter({
      config: TEST_CONFIG,
      transport,
      accessTokenProvider: async () => 'test-access-token',
    }),
  };
}

// ---------------------------------------------------------------------------
// 1. Adapter contract and taxonomy
// ---------------------------------------------------------------------------

describe('CR-BE-PUSH-01 PART 02 — adapter contract and taxonomy', () => {
  it('freezes the normalized error-code vocabulary', () => {
    assert.deepEqual(
      [...PUSH_ERROR_CODES],
      [
        'PAYLOAD_INVALID',
        'INVALID_REQUEST',
        'INVALID_TOKEN',
        'AUTHENTICATION_FAILED',
        'RATE_LIMITED',
        'PROVIDER_UNAVAILABLE',
        'NETWORK_ERROR',
        'UNKNOWN_ERROR',
      ],
    );
    assert.ok(isPushErrorCode('INVALID_TOKEN'));
    assert.ok(!isPushErrorCode('UNREGISTERED'), 'provider codes are not our codes');
  });

  it('freezes the four delivery outcomes the later parts branch on', () => {
    assert.deepEqual(
      [...PUSH_DELIVERY_OUTCOMES],
      ['ACCEPTED', 'REJECTED_RETRYABLE', 'REJECTED_PERMANENT', 'INVALID_TOKEN'],
    );
    assert.ok(isPushDeliveryOutcome('INVALID_TOKEN'));
    assert.ok(!isPushDeliveryOutcome('SENT'));
  });

  it('classifies results into outcomes and marks only retryable ones', () => {
    const sentAt = new Date();
    assert.equal(
      classifyPushResult({ status: 'SENT', provider: 'noop', sentAt }),
      'ACCEPTED',
    );
    assert.equal(
      classifyPushResult({
        status: 'FAILED',
        provider: 'fcm',
        errorCode: 'INVALID_TOKEN',
        tokenInvalid: true,
        retryable: false,
        sentAt,
      }),
      'INVALID_TOKEN',
    );
    assert.equal(
      classifyPushResult({
        status: 'FAILED',
        provider: 'fcm',
        errorCode: 'RATE_LIMITED',
        retryable: true,
        sentAt,
      }),
      'REJECTED_RETRYABLE',
    );
    assert.equal(
      classifyPushResult({
        status: 'FAILED',
        provider: 'fcm',
        errorCode: 'AUTHENTICATION_FAILED',
        retryable: false,
        sentAt,
      }),
      'REJECTED_PERMANENT',
    );
    // An unclassified FAILED result must never be silently permanent-dropped
    // without an explicit decision: absence of `retryable` is conservative
    // (permanent), which is the documented default.
    assert.equal(
      classifyPushResult({ status: 'FAILED', provider: 'fcm', sentAt }),
      'REJECTED_PERMANENT',
    );

    assert.ok(isRetryablePushOutcome('REJECTED_RETRYABLE'));
    assert.ok(!isRetryablePushOutcome('INVALID_TOKEN'));
    assert.ok(!isRetryablePushOutcome('REJECTED_PERMANENT'));
    assert.ok(!isRetryablePushOutcome('ACCEPTED'));
  });

  it('fingerprints device tokens instead of exposing them', () => {
    const token = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const fingerprint = pushTokenFingerprint(token);
    assert.ok(!fingerprint.includes(token), 'fingerprint must not contain the token');
    assert.ok(fingerprint.length < token.length);
    assert.equal(pushTokenFingerprint(token), fingerprint, 'must be deterministic');
    assert.equal(pushTokenFingerprint('abc'), 'len:3', 'short values reveal nothing');
  });
});

// ---------------------------------------------------------------------------
// 2. Defensive payload validation (§9 last line of defence)
// ---------------------------------------------------------------------------

describe('CR-BE-PUSH-01 PART 02 — defensive payload validation', () => {
  it('accepts a compliant pointer payload', () => {
    assert.deepEqual(validatePushPayload(VALID_INPUT), []);
  });

  it('rejects a missing or oversized token', () => {
    assert.deepEqual(validatePushPayload({ ...VALID_INPUT, token: '   ' }), [
      'push token is required',
    ]);
    const long = 'x'.repeat(PUSH_PAYLOAD_LIMITS.tokenMaxLength + 1);
    const violations = validatePushPayload({ ...VALID_INPUT, token: long });
    assert.equal(violations.length, 1);
    assert.ok(violations[0].includes(String(PUSH_PAYLOAD_LIMITS.tokenMaxLength)));
    assert.ok(!violations[0].includes(long), 'violation must not echo the token');
  });

  it('enforces the governance title and body bounds', () => {
    assert.deepEqual(validatePushPayload({ ...VALID_INPUT, title: '' }), [
      'title is required',
    ]);
    assert.equal(PUSH_PAYLOAD_LIMITS.titleMaxLength, 100);
    assert.equal(PUSH_PAYLOAD_LIMITS.bodyMaxLength, 240);
    assert.equal(
      validatePushPayload({ ...VALID_INPUT, title: 'a'.repeat(101) }).length,
      1,
    );
    assert.equal(
      validatePushPayload({ ...VALID_INPUT, body: 'b'.repeat(241) }).length,
      1,
    );
    assert.deepEqual(validatePushPayload({ ...VALID_INPUT, body: null }), []);
  });

  it('rejects provider-reserved data keys and oversized data maps', () => {
    for (const key of ['from', 'gcm', 'google_thing', 'notification']) {
      const violations = validatePushPayload({
        ...VALID_INPUT,
        data: { [key]: 'x' },
      });
      assert.equal(violations.length, 1, `${key} must be rejected`);
      assert.ok(violations[0].includes('reserved'));
    }
    const many: Record<string, string> = {};
    for (let i = 0; i <= PUSH_PAYLOAD_LIMITS.dataMaxKeys; i += 1) {
      many[`k${i}`] = 'v';
    }
    assert.ok(
      validatePushPayload({ ...VALID_INPUT, data: many }).some((v) =>
        v.includes('keys'),
      ),
    );
    assert.ok(
      validatePushPayload({
        ...VALID_INPUT,
        data: { big: 'v'.repeat(PUSH_PAYLOAD_LIMITS.dataValueMaxLength + 1) },
      }).length > 0,
    );
    assert.ok(
      PUSH_PAYLOAD_LIMITS.dataMaxTotalBytes < 4096,
      'the local ceiling must stay below the FCM 4096-byte message limit',
    );
  });

  it('rejects an unknown platform', () => {
    const violations = validatePushPayload({
      ...VALID_INPUT,
      platform: 'WEB' as never,
    });
    assert.equal(violations.length, 1);
    assert.ok(violations[0].includes('ANDROID'));
  });
});

// ---------------------------------------------------------------------------
// 3. Credential-less adapters
// ---------------------------------------------------------------------------

describe('CR-BE-PUSH-01 PART 02 — credential-less adapters', () => {
  it('noop reports success without contacting any provider', async () => {
    const result = await new NoopPushAdapter().send(VALID_INPUT);
    assert.equal(result.status, 'SENT');
    assert.equal(result.provider, 'noop');
    assert.equal(result.tokenInvalid, false);
    assert.equal(result.deliveryId, VALID_INPUT.deliveryId);
    assert.ok(result.providerMessageId?.startsWith('noop-'));
  });

  it('noop simulates every failure branch deterministically', async () => {
    const permanent = await new NoopPushAdapter('fail-permanent').send(VALID_INPUT);
    assert.equal(permanent.status, 'FAILED');
    assert.equal(permanent.retryable, false);
    assert.equal(permanent.tokenInvalid, false);

    const retryable = await new NoopPushAdapter('fail-retryable').send(VALID_INPUT);
    assert.equal(retryable.retryable, true);
    assert.equal(retryable.errorCode, 'PROVIDER_UNAVAILABLE');

    const dead = await new NoopPushAdapter('fail-invalid-token').send(VALID_INPUT);
    assert.equal(dead.errorCode, 'INVALID_TOKEN');
    assert.equal(dead.tokenInvalid, true);
    assert.equal(dead.retryable, false);
    assert.equal(classifyPushResult(dead), 'INVALID_TOKEN');
  });

  it('capture records payloads with a fingerprint, never the raw token', async () => {
    const adapter = new CapturePushAdapter();
    await adapter.send(VALID_INPUT);
    await adapter.send({ ...VALID_INPUT, platform: 'IOS', title: 'Second' });

    assert.equal(adapter.captures.length, 2);
    const [first, second] = adapter.captures;
    assert.equal(first.tokenFingerprint, pushTokenFingerprint(VALID_INPUT.token));
    assert.ok(
      !JSON.stringify(adapter.captures).includes(VALID_INPUT.token),
      'captured output must never contain a raw device token',
    );
    assert.equal(second.platform, 'IOS');
    assert.deepEqual(first.data, VALID_INPUT.data);

    adapter.reset();
    assert.equal(adapter.captures.length, 0);
  });

  it('every adapter refuses an invalid payload before any provider contact', async () => {
    const bad: PushSendInput = { ...VALID_INPUT, title: '' };
    for (const adapter of [new NoopPushAdapter(), new CapturePushAdapter()]) {
      const result = await adapter.send(bad);
      assert.equal(result.status, 'FAILED');
      assert.equal(result.errorCode, 'PAYLOAD_INVALID');
      assert.equal(result.retryable, false);
      assert.equal(result.tokenInvalid, false);
    }
    const { adapter, calls } = adapterWith(() => ({ status: 200, body: '{}' }));
    const result = await adapter.send(bad);
    assert.equal(result.errorCode, 'PAYLOAD_INVALID');
    assert.equal(calls.length, 0, 'a rejected payload must cost no provider request');
  });
});

// ---------------------------------------------------------------------------
// 4. Provider resolution (fail-closed)
// ---------------------------------------------------------------------------

describe('CR-BE-PUSH-01 PART 02 — provider resolution', () => {
  it('defaults to the credential-less noop provider', () => {
    snapshotEnv();
    process.env.NODE_ENV = 'test';
    delete process.env.PUSH_PROVIDER;
    resetAppConfigCache();
    const adapter = resolvePushAdapter();
    assert.equal(adapter.provider, 'noop');
  });

  it('resolves the capture provider without credentials', () => {
    snapshotEnv();
    process.env.NODE_ENV = 'test';
    process.env.PUSH_PROVIDER = 'capture';
    resetAppConfigCache();
    assert.equal(resolvePushAdapter().provider, 'capture');
  });

  it('refuses a real provider in the test environment', () => {
    snapshotEnv();
    process.env.NODE_ENV = 'test';
    process.env.PUSH_PROVIDER = 'fcm';
    process.env.PUSH_FCM_PROJECT_ID = 'p';
    process.env.PUSH_FCM_CLIENT_EMAIL = 'a@b.iam.gserviceaccount.com';
    process.env.PUSH_FCM_PRIVATE_KEY = TEST_PRIVATE_KEY;
    resetAppConfigCache();
    assert.throws(() => resolvePushAdapter(), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(String((error as Error).message), /test environment/i);
      return true;
    });
  });

  it('fails closed on an unknown provider instead of falling back', () => {
    snapshotEnv();
    process.env.NODE_ENV = 'development';
    process.env.PUSH_PROVIDER = 'onesignal';
    resetAppConfigCache();
    assert.throws(() => resolvePushAdapter(), ConfigError);
  });

  it('resolves fcm outside the test environment when credentials are present', () => {
    snapshotEnv();
    process.env.NODE_ENV = 'development';
    process.env.PUSH_PROVIDER = 'fcm';
    process.env.PUSH_FCM_PROJECT_ID = 'asentra-dev';
    process.env.PUSH_FCM_CLIENT_EMAIL = 'sender@asentra-dev.iam.gserviceaccount.com';
    process.env.PUSH_FCM_PRIVATE_KEY = TEST_PRIVATE_KEY;
    resetAppConfigCache();
    const adapter = resolvePushAdapter();
    assert.equal(adapter.provider, 'fcm');
  });

  it('fails closed when fcm is selected without credentials', () => {
    snapshotEnv();
    process.env.NODE_ENV = 'development';
    process.env.PUSH_PROVIDER = 'fcm';
    delete process.env.PUSH_FCM_PROJECT_ID;
    delete process.env.PUSH_FCM_CLIENT_EMAIL;
    delete process.env.PUSH_FCM_PRIVATE_KEY;
    resetAppConfigCache();
    assert.throws(() => resolvePushAdapter(), ConfigError);
  });

  it('keeps the credential-less provider list a subset of the available ones', () => {
    for (const provider of CREDENTIAL_LESS_PUSH_PROVIDERS) {
      assert.ok((AVAILABLE_PUSH_PROVIDERS as readonly string[]).includes(provider));
    }
    assert.ok(!(CREDENTIAL_LESS_PUSH_PROVIDERS as readonly string[]).includes('fcm'));
  });
});

// ---------------------------------------------------------------------------
// 5. Secure configuration boundary (§12.2)
// ---------------------------------------------------------------------------

describe('CR-BE-PUSH-01 PART 02 — secure configuration boundary', () => {
  it('keeps FCM credentials out of AppConfig entirely', async () => {
    snapshotEnv();
    process.env.NODE_ENV = 'development';
    process.env.PUSH_PROVIDER = 'fcm';
    process.env.PUSH_FCM_PROJECT_ID = 'asentra-dev';
    process.env.PUSH_FCM_CLIENT_EMAIL = 'sender@asentra-dev.iam.gserviceaccount.com';
    process.env.PUSH_FCM_PRIVATE_KEY = TEST_PRIVATE_KEY;
    resetAppConfigCache();

    const { getAppConfig } = await import('../src/config');
    const config = getAppConfig();
    assert.deepEqual(
      Object.keys(config.push).sort(),
      ['provider'],
      'AppConfig.push must expose only the provider discriminator',
    );
    const serialized = JSON.stringify(config);
    assert.ok(
      !serialized.includes('PRIVATE KEY'),
      'no PEM material may ever reach AppConfig',
    );
    assert.ok(!serialized.includes('asentra-dev'), 'no FCM project/credential in config');
  });

  it('names the missing FIELD and never a value when configuration is absent', () => {
    for (const missing of [
      'PUSH_FCM_PROJECT_ID',
      'PUSH_FCM_CLIENT_EMAIL',
      'PUSH_FCM_PRIVATE_KEY',
    ]) {
      const env: NodeJS.ProcessEnv = {
        PUSH_FCM_PROJECT_ID: 'asentra-dev',
        PUSH_FCM_CLIENT_EMAIL: 'sender@asentra-dev.iam.gserviceaccount.com',
        PUSH_FCM_PRIVATE_KEY: TEST_PRIVATE_KEY,
      };
      delete env[missing];
      assert.throws(
        () => readFcmPushConfig(env),
        (error: unknown) => {
          assert.ok(error instanceof ConfigError);
          const message = (error as Error).message;
          assert.ok(message.includes(missing), `must name ${missing}`);
          assert.ok(!message.includes('PRIVATE KEY'), 'must not echo the key');
          assert.ok(!message.includes('sender@'), 'must not echo the client email');
          return true;
        },
      );
    }
  });

  it('normalizes an escaped-newline PEM only at the config seam', () => {
    const escaped = TEST_PRIVATE_KEY.trim().replace(/\n/g, '\\n');
    assert.ok(!escaped.includes('\n'), 'the fixture must be single-line');
    const config = readFcmPushConfig({
      PUSH_FCM_PROJECT_ID: 'asentra-dev',
      PUSH_FCM_CLIENT_EMAIL: 'sender@asentra-dev.iam.gserviceaccount.com',
      PUSH_FCM_PRIVATE_KEY: escaped,
    });
    assert.ok(config.privateKey.includes('\n'));
    assert.equal(config.privateKey.trim(), TEST_PRIVATE_KEY.trim());
    assert.equal(config.apiBaseUrl, FCM_PUSH_DEFAULTS.apiBaseUrl);
    assert.equal(config.tokenUri, FCM_PUSH_DEFAULTS.tokenUri);
  });

  it('rejects a private key that is not a PEM block', () => {
    assert.throws(() => normalizeFcmPrivateKey('not-a-key'), ConfigError);
    assert.throws(
      () => normalizeFcmPrivateKey('not-a-key'),
      (error: unknown) => {
        assert.ok(!(error as Error).message.includes('not-a-key'));
        return true;
      },
    );
  });

  it('allows overriding the endpoints without touching credentials', () => {
    const config = readFcmPushConfig({
      PUSH_FCM_PROJECT_ID: 'asentra-dev',
      PUSH_FCM_CLIENT_EMAIL: 'sender@asentra-dev.iam.gserviceaccount.com',
      PUSH_FCM_PRIVATE_KEY: TEST_PRIVATE_KEY,
      PUSH_FCM_API_BASE_URL: 'https://fcm.example.test/',
      PUSH_FCM_TOKEN_URI: 'https://oauth.example.test/token',
    });
    assert.equal(config.apiBaseUrl, 'https://fcm.example.test');
    assert.equal(config.tokenUri, 'https://oauth.example.test/token');
  });

  it('redacts credential-like fragments and bounds error text', () => {
    const dirty = `failed authorization=Bearer ya29.super-secret token=abc123 ${TEST_PRIVATE_KEY}`;
    const clean = sanitizeFcmError(dirty);
    assert.ok(!clean.includes('ya29.super-secret'));
    assert.ok(!clean.includes('abc123'));
    assert.ok(!clean.includes('PRIVATE KEY'));
    assert.ok(clean.includes('[REDACTED'));
    assert.ok(sanitizeFcmError('x'.repeat(5000)).length <= 501);
  });
});

// ---------------------------------------------------------------------------
// 6. Service-account JWT signing
// ---------------------------------------------------------------------------

describe('CR-BE-PUSH-01 PART 02 — service-account assertion', () => {
  it('signs an RS256 JWT with the correct claims and no vendor SDK', () => {
    const now = 1_700_000_000;
    const assertion = buildFcmAssertion(TEST_CONFIG, now);
    const [header, claims, signature] = assertion.split('.');
    assert.equal(
      JSON.parse(Buffer.from(header, 'base64url').toString('utf8')).alg,
      'RS256',
    );
    const payload = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8'));
    assert.equal(payload.iss, TEST_CONFIG.clientEmail);
    assert.equal(payload.aud, TEST_CONFIG.tokenUri);
    assert.equal(payload.scope, FCM_PUSH_DEFAULTS.scope);
    assert.equal(payload.iat, now);
    assert.equal(payload.exp, now + 3600);

    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${claims}`);
    verifier.end();
    assert.ok(
      verifier.verify(TEST_PUBLIC_KEY, Buffer.from(signature, 'base64url')),
      'the assertion signature must verify against the service-account key',
    );
  });
});

// ---------------------------------------------------------------------------
// 7. FCM error parsing and classification (§8, §13.2)
// ---------------------------------------------------------------------------

describe('CR-BE-PUSH-01 PART 02 — FCM error classification', () => {
  it('extracts the FcmError detail, canonical status and field violations', () => {
    const parsed = parseFcmErrorBody(
      JSON.stringify({
        error: {
          message: 'Requested entity was not found.',
          status: 'NOT_FOUND',
          details: [
            {
              '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
              errorCode: 'UNREGISTERED',
            },
          ],
        },
      }),
    );
    assert.equal(parsed.errorCode, 'UNREGISTERED');
    assert.equal(parsed.message, 'Requested entity was not found.');

    const badRequest = parseFcmErrorBody(
      JSON.stringify({
        error: {
          message: 'Invalid registration token',
          status: 'INVALID_ARGUMENT',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.BadRequest',
              fieldViolations: [{ field: 'message.token', description: 'bad' }],
            },
          ],
        },
      }),
    );
    assert.equal(badRequest.errorCode, 'INVALID_ARGUMENT');
    assert.deepEqual(badRequest.fieldViolations, ['message.token']);

    const garbage = parseFcmErrorBody('<html>502</html>');
    assert.equal(garbage.errorCode, null);
    assert.deepEqual(garbage.fieldViolations, []);
  });

  it('maps UNREGISTERED and SENDER_ID_MISMATCH by governance, not by guess', () => {
    const unregistered = classifyFcmError({
      status: 404,
      errorCode: 'UNREGISTERED',
      message: 'gone',
    });
    assert.equal(unregistered.code, 'INVALID_TOKEN');
    assert.equal(unregistered.tokenInvalid, true);
    assert.equal(unregistered.retryable, false);

    // SENDER_ID_MISMATCH is a CREDENTIAL/config fault in this codebase's
    // taxonomy: the device token belongs to another Firebase sender, so the
    // fault is ours, and a user's device must not be invalidated for it.
    const mismatch = classifyFcmError({
      status: 403,
      errorCode: 'SENDER_ID_MISMATCH',
      message: 'wrong sender',
    });
    assert.equal(mismatch.code, 'AUTHENTICATION_FAILED');
    assert.equal(mismatch.tokenInvalid, false);
    assert.equal(mismatch.retryable, false);
  });

  it('only invalidates on INVALID_ARGUMENT when the token field is at fault', () => {
    const payloadFault = classifyFcmError({
      status: 400,
      errorCode: 'INVALID_ARGUMENT',
      fieldViolations: ['message.notification.body'],
      message: 'payload too large',
    });
    assert.equal(payloadFault.code, 'INVALID_REQUEST');
    assert.equal(payloadFault.tokenInvalid, false, 'a payload defect must not kill a device');

    const tokenFault = classifyFcmError({
      status: 400,
      errorCode: 'INVALID_ARGUMENT',
      fieldViolations: ['message.token'],
      message: 'invalid token',
    });
    assert.equal(tokenFault.code, 'INVALID_TOKEN');
    assert.equal(tokenFault.tokenInvalid, true);

    const noDetail = classifyFcmError({
      status: 400,
      errorCode: 'INVALID_ARGUMENT',
      message: 'invalid',
    });
    assert.equal(noDetail.code, 'INVALID_REQUEST');
    assert.equal(noDetail.tokenInvalid, false, 'ambiguity must never invalidate');
  });

  it('maps transient, throttling, auth and unknown conditions', () => {
    const cases: Array<[string, number, string, boolean, boolean]> = [
      ['QUOTA_EXCEEDED', 429, 'RATE_LIMITED', true, false],
      ['UNAVAILABLE', 503, 'PROVIDER_UNAVAILABLE', true, false],
      ['INTERNAL', 500, 'PROVIDER_UNAVAILABLE', true, false],
      ['THIRD_PARTY_AUTH_ERROR', 401, 'AUTHENTICATION_FAILED', false, false],
      ['PERMISSION_DENIED', 403, 'AUTHENTICATION_FAILED', false, false],
      ['UNAUTHENTICATED', 401, 'AUTHENTICATION_FAILED', false, false],
    ];
    for (const [errorCode, status, expected, retryable, tokenInvalid] of cases) {
      const result = classifyFcmError({ status, errorCode, message: errorCode });
      assert.equal(result.code, expected, errorCode);
      assert.equal(result.retryable, retryable, `${errorCode} retryable`);
      assert.equal(result.tokenInvalid, tokenInvalid, `${errorCode} tokenInvalid`);
    }

    // Unclassified: conservatively retryable, never token-invalidating.
    const unknown = classifyFcmError({ errorCode: 'WHAT_IS_THIS', message: 'odd' });
    assert.equal(unknown.code, 'UNKNOWN_ERROR');
    assert.equal(unknown.retryable, true);
    assert.equal(unknown.tokenInvalid, false);

    const network = classifyFcmError({ message: 'socket hang up', network: true });
    assert.equal(network.code, 'NETWORK_ERROR');
    assert.equal(network.retryable, true);
    assert.equal(network.tokenInvalid, false);
  });

  it('falls back to the HTTP status when no error code is present', () => {
    assert.equal(classifyFcmError({ status: 404, message: 'x' }).code, 'INVALID_TOKEN');
    assert.equal(classifyFcmError({ status: 429, message: 'x' }).code, 'RATE_LIMITED');
    assert.equal(
      classifyFcmError({ status: 502, message: 'x' }).code,
      'PROVIDER_UNAVAILABLE',
    );
    assert.equal(
      classifyFcmError({ status: 401, message: 'x' }).code,
      'AUTHENTICATION_FAILED',
    );
    assert.equal(classifyFcmError({ status: 400, message: 'x' }).code, 'INVALID_REQUEST');
    assert.equal(classifyFcmError({ status: 418, message: 'x' }).code, 'UNKNOWN_ERROR');
  });

  it('sanitizes classified error text', () => {
    const result = classifyFcmError({
      status: 401,
      errorCode: 'UNAUTHENTICATED',
      message: 'bad authorization=Bearer ya29.leaked',
    });
    assert.ok(!result.message.includes('ya29.leaked'));
  });
});

// ---------------------------------------------------------------------------
// 8. FcmPushAdapter.send over a mocked transport
// ---------------------------------------------------------------------------

describe('CR-BE-PUSH-01 PART 02 — FCM send behaviour', () => {
  it('posts an HTTP v1 message and returns the provider message id', async () => {
    const { adapter, calls } = adapterWith(() => ({
      status: 200,
      body: JSON.stringify({
        name: 'projects/asentra-test-project/messages/0:1700000000%abc',
      }),
    }));
    const result = await adapter.send(VALID_INPUT);

    assert.equal(result.status, 'SENT');
    assert.equal(result.provider, 'fcm');
    assert.equal(
      result.providerMessageId,
      'projects/asentra-test-project/messages/0:1700000000%abc',
    );
    assert.equal(result.tokenInvalid, false);
    assert.equal(result.deliveryId, VALID_INPUT.deliveryId);
    assert.equal(classifyPushResult(result), 'ACCEPTED');

    assert.equal(calls.length, 1);
    const [request] = calls;
    assert.equal(
      request.url,
      'https://fcm.googleapis.com/v1/projects/asentra-test-project/messages:send',
    );
    assert.equal(request.headers.Authorization, 'Bearer test-access-token');
    const body = JSON.parse(request.body);
    assert.equal(body.message.token, VALID_INPUT.token);
    assert.equal(body.message.notification.title, VALID_INPUT.title);
    assert.deepEqual(body.message.data, VALID_INPUT.data);
    assert.equal(body.message.android.priority, 'high');
    assert.equal(body.message.apns, undefined);
  });

  it('routes iOS through the FCM APNs relay, not a direct APNs client', async () => {
    const { adapter, calls } = adapterWith(() => ({
      status: 200,
      body: JSON.stringify({ name: 'projects/p/messages/1' }),
    }));
    await adapter.send({ ...VALID_INPUT, platform: 'IOS' });
    const body = JSON.parse(calls[0].body);
    assert.ok(body.message.apns, 'iOS sends must carry the FCM apns block');
    assert.equal(body.message.android, undefined);
    assert.match(calls[0].url, /^https:\/\/fcm\.googleapis\.com\//);
  });

  it('reports an unregistered token as INVALID_TOKEN without touching the database', async () => {
    const { adapter } = adapterWith(() => ({
      status: 404,
      body: fcmError('UNREGISTERED', 'NOT_FOUND', 'Requested entity was not found.'),
    }));
    const result = await adapter.send(VALID_INPUT);
    assert.equal(result.status, 'FAILED');
    assert.equal(result.errorCode, 'INVALID_TOKEN');
    assert.equal(result.tokenInvalid, true, 'PART 04 consumes this flag');
    assert.equal(result.retryable, false);
    assert.equal(classifyPushResult(result), 'INVALID_TOKEN');
    assert.ok(
      !JSON.stringify(result).includes(VALID_INPUT.token),
      'the result must never echo the device token',
    );
  });

  it('classifies throttling and outage as retryable, config faults as permanent', async () => {
    const throttled = adapterWith(() => ({
      status: 429,
      body: fcmError('QUOTA_EXCEEDED', 'RESOURCE_EXHAUSTED'),
    }));
    const throttledResult = await throttled.adapter.send(VALID_INPUT);
    assert.equal(throttledResult.errorCode, 'RATE_LIMITED');
    assert.equal(throttledResult.retryable, true);
    assert.equal(throttledResult.tokenInvalid, false);

    const outage = adapterWith(() => ({
      status: 503,
      body: fcmError('UNAVAILABLE', 'UNAVAILABLE'),
    }));
    const outageResult = await outage.adapter.send(VALID_INPUT);
    assert.equal(outageResult.errorCode, 'PROVIDER_UNAVAILABLE');
    assert.equal(outageResult.retryable, true);

    const authFault = adapterWith(() => ({
      status: 401,
      body: fcmError('THIRD_PARTY_AUTH_ERROR', 'UNAUTHENTICATED'),
    }));
    const authResult = await authFault.adapter.send(VALID_INPUT);
    assert.equal(authResult.errorCode, 'AUTHENTICATION_FAILED');
    assert.equal(authResult.retryable, false);
    assert.equal(
      authResult.tokenInvalid,
      false,
      'a credential fault must never invalidate a user device',
    );
  });

  it('treats a transport failure as a retryable network error', async () => {
    const { adapter } = adapterWith(() => {
      throw new Error('The operation was aborted');
    });
    const result = await adapter.send(VALID_INPUT);
    assert.equal(result.status, 'FAILED');
    assert.equal(result.errorCode, 'NETWORK_ERROR');
    assert.equal(result.retryable, true);
    assert.equal(result.tokenInvalid, false);
  });

  it('surfaces a token-exchange failure without leaking the assertion', async () => {
    const adapter = new FcmPushAdapter({
      config: TEST_CONFIG,
      transport: async () => ({ status: 200, body: '{}' }),
      accessTokenProvider: async () => {
        throw new Error('token exchange failed: assertion=eyJhbGciOi.leaked');
      },
    });
    const result = await adapter.send(VALID_INPUT);
    assert.equal(result.status, 'FAILED');
    assert.equal(result.errorCode, 'NETWORK_ERROR');
    assert.ok(!result.error?.includes('eyJhbGciOi.leaked'), 'assertion must be redacted');
    assert.equal(result.tokenInvalid, false);
  });

  it('performs the JWT-bearer exchange once and caches the access token', async () => {
    const calls: FcmHttpRequest[] = [];
    const adapter = new FcmPushAdapter({
      config: TEST_CONFIG,
      transport: async (request) => {
        calls.push(request);
        if (request.url === TEST_CONFIG.tokenUri) {
          return {
            status: 200,
            body: JSON.stringify({ access_token: 'ya29.mock', expires_in: 3600 }),
          };
        }
        return { status: 200, body: JSON.stringify({ name: 'projects/p/messages/1' }) };
      },
    });

    await adapter.send(VALID_INPUT);
    await adapter.send(VALID_INPUT);

    const tokenCalls = calls.filter((c) => c.url === TEST_CONFIG.tokenUri);
    assert.equal(tokenCalls.length, 1, 'the access token must be cached between sends');
    assert.match(tokenCalls[0].body, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer/);
    const sendCalls = calls.filter((c) => c.url !== TEST_CONFIG.tokenUri);
    assert.equal(sendCalls.length, 2);
    for (const call of sendCalls) {
      assert.equal(call.headers.Authorization, 'Bearer ya29.mock');
    }
  });

  it('accepts a 2xx with an unparsable body without inventing a message id', async () => {
    const { adapter } = adapterWith(() => ({ status: 200, body: 'not-json' }));
    const result = await adapter.send(VALID_INPUT);
    assert.equal(result.status, 'SENT');
    assert.equal(result.providerMessageId, null);
  });
});
