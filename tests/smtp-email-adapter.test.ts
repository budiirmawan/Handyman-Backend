import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { ConfigError, resetAppConfigCache } from '../src/config';
import {
  resolveEmailAdapter,
} from '../src/modules/email-delivery';
import {
  SMTP_EMAIL_DEFAULTS,
  SmtpEmailAdapter,
  classifySmtpEmailResult,
  classifySmtpError,
  readSmtpEmailConfig,
  sanitizeSmtpError,
  type SmtpEmailConfig,
  type SmtpEmailMessage,
  type SmtpEmailTransportResult,
  type SmtpTransport,
} from '../src/modules/email-delivery';

/**
 * CR-BE-NOTIFY-PROV-01 PART 05 — real SMTP email adapter (focused tests).
 *
 * Validates the gated provider adapter WITHOUT any external network:
 *   - boundary config reading/validation (credentials never in errors),
 *   - wire-message construction through a MOCK SmtpTransport (credentials
 *     never appear in the message),
 *   - SMTP outcome/error → PART 01 taxonomy mapping (retryable contract),
 *   - resolver wiring for EMAIL_PROVIDER=smtp (the test-environment guard
 *     still blocks real providers under NODE_ENV=test).
 *
 * No ledger/retry/scheduler change is exercised here (PART 04 owns it and
 * consumes any EmailAdapter unchanged).
 */

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'NODE_ENV',
  'EMAIL_PROVIDER',
  'EMAIL_SMTP_HOST',
  'EMAIL_SMTP_PORT',
  'EMAIL_SMTP_SECURE',
  'EMAIL_SMTP_USERNAME',
  'EMAIL_SMTP_PASSWORD',
  'EMAIL_FROM_ADDRESS',
  'EMAIL_FROM_NAME',
  'EMAIL_REPLY_TO',
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

function testConfig(overrides: Partial<SmtpEmailConfig> = {}): SmtpEmailConfig {
  return {
    host: 'smtp.example.internal',
    port: 587,
    secure: false,
    username: 'sender@example.com',
    password: 'SUPER_SECRET_PASSWORD',
    fromAddress: 'noreply@asentra.example',
    fromName: 'Asentra',
    replyTo: 'support@asentra.example',
    connectionTimeoutMs: SMTP_EMAIL_DEFAULTS.connectionTimeoutMs,
    greetingTimeoutMs: SMTP_EMAIL_DEFAULTS.greetingTimeoutMs,
    socketTimeoutMs: SMTP_EMAIL_DEFAULTS.socketTimeoutMs,
    ...overrides,
  };
}

/** Records messages; scripted result or error per call. */
function mockTransport(
  behavior:
    | { result: SmtpEmailTransportResult }
    | { error: unknown },
): { transport: SmtpTransport; calls: SmtpEmailMessage[] } {
  const calls: SmtpEmailMessage[] = [];
  return {
    calls,
    transport: {
      async sendMail(message: SmtpEmailMessage): Promise<SmtpEmailTransportResult> {
        calls.push(message);
        if ('error' in behavior) {
          throw behavior.error;
        }
        return behavior.result;
      },
    },
  };
}

afterEach(() => {
  restoreEnv();
});

describe('CR-BE-NOTIFY-PROV-01 PART 05 — SMTP boundary configuration', () => {
  it('reads required and optional keys with governed defaults', () => {
    snapshotEnv();
    process.env.EMAIL_SMTP_HOST = 'mail.asentra.example';
    process.env.EMAIL_SMTP_PORT = '465';
    process.env.EMAIL_SMTP_SECURE = 'true';
    process.env.EMAIL_SMTP_USERNAME = 'sender@asentra.example';
    process.env.EMAIL_SMTP_PASSWORD = 'hunter2';
    process.env.EMAIL_FROM_ADDRESS = 'noreply@asentra.example';
    process.env.EMAIL_FROM_NAME = ' Asentra Ops ';
    process.env.EMAIL_REPLY_TO = 'support@asentra.example';

    const config = readSmtpEmailConfig(process.env);
    assert.equal(config.host, 'mail.asentra.example');
    assert.equal(config.port, 465);
    assert.equal(config.secure, true);
    assert.equal(config.username, 'sender@asentra.example');
    assert.equal(config.password, 'hunter2');
    assert.equal(config.fromAddress, 'noreply@asentra.example');
    assert.equal(config.fromName, 'Asentra Ops');
    assert.equal(config.replyTo, 'support@asentra.example');
  });

  it('applies defaults: port 587, secure false, no AUTH without a username', () => {
    snapshotEnv();
    const config = readSmtpEmailConfig({
      EMAIL_SMTP_HOST: 'relay.local',
      EMAIL_FROM_ADDRESS: 'noreply@asentra.example',
    });
    assert.equal(config.port, SMTP_EMAIL_DEFAULTS.port);
    assert.equal(config.secure, false);
    assert.equal(config.username, '');
    assert.equal(config.password, '');
    assert.equal(config.fromName, null);
    assert.equal(config.replyTo, null);
  });

  it('fails fast on missing required keys — field NAMES only, never credential values', () => {
    assert.throws(
      () => readSmtpEmailConfig({ EMAIL_FROM_ADDRESS: 'a@b.example' }),
      (error: unknown) =>
        error instanceof ConfigError && error.message.includes('EMAIL_SMTP_HOST'),
    );
    assert.throws(
      () => readSmtpEmailConfig({ EMAIL_SMTP_HOST: 'mail.example' }),
      (error: unknown) =>
        error instanceof ConfigError && error.message.includes('EMAIL_FROM_ADDRESS'),
    );

    // A provided password must never surface in any configuration error.
    assert.throws(
      () =>
        readSmtpEmailConfig({
          EMAIL_SMTP_HOST: 'mail.example',
          EMAIL_SMTP_PORT: 'not-a-port',
          EMAIL_SMTP_PASSWORD: 'TOP_SECRET_VALUE',
          EMAIL_FROM_ADDRESS: 'a@b.example',
        }),
      (error: unknown) =>
        error instanceof ConfigError &&
        error.message.includes('EMAIL_SMTP_PORT') &&
        !error.message.includes('TOP_SECRET_VALUE'),
    );

    assert.throws(
      () =>
        readSmtpEmailConfig({
          EMAIL_SMTP_HOST: 'mail.example',
          EMAIL_SMTP_SECURE: 'maybe',
          EMAIL_FROM_ADDRESS: 'a@b.example',
        }),
      (error: unknown) => error instanceof ConfigError,
    );
  });
});

describe('CR-BE-NOTIFY-PROV-01 PART 05 — wire message through the mock transport', () => {
  it('builds the message from boundary config and never leaks credentials into it', async () => {
    const { transport, calls } = mockTransport({
      result: { messageId: '<smtp-abc@mail.example>', accepted: ['user@example.com'] },
    });
    const adapter = new SmtpEmailAdapter({ config: testConfig(), transport });

    const result = await adapter.send({
      to: 'user@example.com',
      subject: 'Hello John',
      body: 'Email body for John.',
    });

    assert.equal(result.status, 'SENT');
    assert.equal(result.providerMessageId, '<smtp-abc@mail.example>');
    assert.equal(result.providerReference, '<smtp-abc@mail.example>');
    assert.ok(result.sentAt instanceof Date);

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      from: { name: 'Asentra', address: 'noreply@asentra.example' },
      replyTo: 'support@asentra.example',
      to: 'user@example.com',
      subject: 'Hello John',
      text: 'Email body for John.',
    });
    // Credentials live only in the transport construction boundary.
    const wire = JSON.stringify(calls[0]);
    assert.ok(!wire.includes('SUPER_SECRET_PASSWORD'));
    assert.ok(!wire.includes('sender@example.com'));
  });

  it('falls back to the subject when the rendered body is null', async () => {
    const { transport, calls } = mockTransport({ result: { messageId: '<m@x>' } });
    const adapter = new SmtpEmailAdapter({ config: testConfig(), transport });

    await adapter.send({ to: 'user@example.com', subject: 'Subject only', body: null });
    assert.equal(calls[0].text, 'Subject only');
  });

  it('maps an envelope reject with a 5xx response to FAILED + retryable:false', async () => {
    const { transport } = mockTransport({
      result: {
        messageId: '<m@x>',
        accepted: [],
        rejected: ['user@example.com'],
        response: '550 5.1.1 Mailbox unavailable',
      },
    });
    const adapter = new SmtpEmailAdapter({ config: testConfig(), transport });

    const result = await adapter.send({ to: 'user@example.com', subject: 's', body: 'b' });
    assert.equal(result.status, 'FAILED');
    assert.equal(result.retryable, false);
    assert.match(result.error as string, /550/);
    assert.equal(classifySmtpEmailResult(result), 'REJECTED_PERMANENT');
  });

  it('maps an envelope reject with a 4xx response to FAILED + retryable:true', async () => {
    const { transport } = mockTransport({
      result: {
        rejected: ['user@example.com'],
        response: '450 4.7.1 Try again later',
      },
    });
    const adapter = new SmtpEmailAdapter({ config: testConfig(), transport });

    const result = await adapter.send({ to: 'user@example.com', subject: 's', body: 'b' });
    assert.equal(result.status, 'FAILED');
    assert.equal(result.retryable, true);
    assert.equal(classifySmtpEmailResult(result), 'REJECTED_RETRYABLE');
  });

  it('maps transport failures through the taxonomy (4xx retryable, 5xx permanent, ECONN retryable, EAUTH permanent)', async () => {
    const cases: Array<{
      error: unknown;
      retryable: boolean;
      outcome: 'REJECTED_RETRYABLE' | 'REJECTED_PERMANENT';
    }> = [
      {
        error: Object.assign(new Error('Deferred: 451 greylisted'), { responseCode: 451 }),
        retryable: true,
        outcome: 'REJECTED_RETRYABLE',
      },
      {
        error: Object.assign(new Error('Relay denied'), { responseCode: 554 }),
        retryable: false,
        outcome: 'REJECTED_PERMANENT',
      },
      {
        error: Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:587'), {
          code: 'ECONNREFUSED',
        }),
        retryable: true,
        outcome: 'REJECTED_RETRYABLE',
      },
      {
        error: Object.assign(new Error('Authentication failed'), { code: 'EAUTH' }),
        retryable: false,
        outcome: 'REJECTED_PERMANENT',
      },
    ];

    for (const testCase of cases) {
      const { transport } = mockTransport({ error: testCase.error });
      const adapter = new SmtpEmailAdapter({ config: testConfig(), transport });
      const result = await adapter.send({ to: 'u@example.com', subject: 's', body: 'b' });
      assert.equal(result.status, 'FAILED');
      assert.equal(result.retryable, testCase.retryable);
      assert.equal(classifySmtpEmailResult(result), testCase.outcome);
    }
  });

  it('sanitizes credential-like fragments out of SMTP errors', async () => {
    const { transport } = mockTransport({
      error: Object.assign(new Error('auth failed password=SECRET123 token=abcdef'), {
        responseCode: 535,
      }),
    });
    const adapter = new SmtpEmailAdapter({ config: testConfig(), transport });

    const result = await adapter.send({ to: 'u@example.com', subject: 's', body: 'b' });
    assert.equal(result.status, 'FAILED');
    assert.ok(!(result.error as string).includes('SECRET123'));
    assert.ok(!(result.error as string).includes('abcdef'));
    assert.match(result.error as string, /\[REDACTED\]/);
  });
});

describe('CR-BE-NOTIFY-PROV-01 PART 05 — SMTP error classifier', () => {
  it('classifies response codes: 4xx transient, 5xx permanent', () => {
    assert.equal(classifySmtpError({ responseCode: 421 }).retryable, true);
    assert.equal(classifySmtpError({ responseCode: 450 }).retryable, true);
    assert.equal(classifySmtpError({ responseCode: 452 }).retryable, true);
    assert.equal(classifySmtpError({ responseCode: 550 }).retryable, false);
    assert.equal(classifySmtpError({ responseCode: 553 }).retryable, false);
  });

  it('classifies network codes as transient and auth failures as permanent', () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND']) {
      assert.equal(classifySmtpError({ code, message: `${code} happened` }).retryable, true);
    }
    assert.equal(classifySmtpError({ code: 'EAUTH', message: 'nope' }).retryable, false);
    assert.equal(classifySmtpError({ message: 'Invalid login: 535' }).retryable, false);
  });

  it('treats unclassified errors as retryable (bounded by the ledger attempt budget)', () => {
    assert.equal(classifySmtpError(new Error('something entirely unknown')).retryable, true);
    assert.equal(classifySmtpError(null).retryable, true);
  });

  it('sanitizeSmtpError redacts credentials and truncates', () => {
    const sanitized = sanitizeSmtpError('boom api_key=K123 authorization=Bearerxyz');
    assert.ok(!sanitized.includes('K123'));
    assert.ok(!sanitized.includes('Bearerxyz'));
    assert.match(sanitized, /\[REDACTED\]/);
    const long = sanitizeSmtpError('x'.repeat(2000));
    assert.ok(long.length <= 501);
  });
});

describe('CR-BE-NOTIFY-PROV-01 PART 05 — resolver wiring', () => {
  it('still blocks smtp under NODE_ENV=test (credential-less providers only)', () => {
    snapshotEnv();
    process.env.NODE_ENV = 'test';
    process.env.EMAIL_PROVIDER = 'smtp';
    resetAppConfigCache();
    assert.throws(
      () => resolveEmailAdapter(),
      (error: unknown) =>
        error instanceof ConfigError &&
        error.message.includes('test environment') &&
        error.message.includes('noop, capture'),
    );
  });

  it('resolves the smtp adapter outside the test environment with valid boundary config', () => {
    snapshotEnv();
    process.env.NODE_ENV = 'development';
    process.env.EMAIL_PROVIDER = 'smtp';
    process.env.EMAIL_SMTP_HOST = '127.0.0.1';
    process.env.EMAIL_SMTP_PORT = '2525';
    process.env.EMAIL_FROM_ADDRESS = 'noreply@asentra.example';
    resetAppConfigCache();

    // Construction validates config but opens NO connection (send was never
    // called), so this wiring test stays network-free.
    const adapter = resolveEmailAdapter();
    assert.equal(adapter.provider, 'smtp');
  });

  it('fails fast at resolution when the SMTP boundary config is incomplete', () => {
    snapshotEnv();
    process.env.NODE_ENV = 'development';
    process.env.EMAIL_PROVIDER = 'smtp';
    delete process.env.EMAIL_SMTP_HOST;
    delete process.env.EMAIL_FROM_ADDRESS;
    resetAppConfigCache();
    assert.throws(
      () => resolveEmailAdapter(),
      (error: unknown) => error instanceof ConfigError,
    );
  });

  it('keeps noop/capture resolution and lists smtp among available providers', () => {
    snapshotEnv();
    process.env.NODE_ENV = 'development';
    delete process.env.EMAIL_PROVIDER;
    resetAppConfigCache();
    assert.equal(resolveEmailAdapter().provider, 'noop');

    process.env.EMAIL_PROVIDER = 'ses';
    resetAppConfigCache();
    assert.throws(
      () => resolveEmailAdapter(),
      (error: unknown) =>
        error instanceof ConfigError &&
        error.message.includes('no email adapter is implemented') &&
        error.message.includes('noop, capture, smtp'),
    );
  });
});
