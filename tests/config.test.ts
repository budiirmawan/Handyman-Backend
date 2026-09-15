import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ConfigError,
  applyParsedEnv,
  parseConfig,
  parseEnvFile,
} from '../src/config/env';

describe('parseEnvFile', () => {
  it('parses keys, comments, quotes, and export prefix', () => {
    const parsed = parseEnvFile(`
# comment
NODE_ENV=development
PORT=3000
export LOG_LEVEL="info"
API_PREFIX='/api/v1'
EMPTY_SKIP
=novalue
`);

    assert.deepEqual(parsed, {
      NODE_ENV: 'development',
      PORT: '3000',
      LOG_LEVEL: 'info',
      API_PREFIX: '/api/v1',
    });
  });

  it('does not override already-set environment values', () => {
    const target: NodeJS.ProcessEnv = { PORT: '4000' };
    applyParsedEnv({ PORT: '3000', LOG_LEVEL: 'debug' }, target);
    assert.equal(target.PORT, '4000');
    assert.equal(target.LOG_LEVEL, 'debug');
  });
});

describe('parseConfig', () => {
  it('uses documented defaults', () => {
    const config = parseConfig({});

    assert.equal(config.environment, 'development');
    assert.equal(config.port, 3000);
    assert.equal(config.apiPrefix, '/api/v1');
    assert.equal(config.logLevel, 'info');
    assert.equal(config.isDevelopment, true);
    assert.equal(config.isTest, false);
    assert.equal(config.isProduction, false);
    assert.equal(config.database.host, 'localhost');
    assert.equal(config.database.port, 5432);
    assert.equal(config.database.name, 'asentra');
    assert.equal(config.database.user, 'postgres');
    assert.equal(config.database.password, '');
    assert.equal(config.database.ssl, false);
    assert.deepEqual(config.security.corsOrigins, [
      'http://localhost:3000',
      'http://localhost:5173',
    ]);
    assert.equal(config.security.jsonBodyLimit, '1mb');
    assert.equal(config.security.loginRateLimitWindowMinutes, 15);
    assert.equal(config.security.loginRateLimitMaxAttempts, 10);
    assert.equal(config.session.ttlMinutes, 480);
    assert.equal(config.session.ttlMs, 480 * 60_000);
    assert.equal(config.session.tokenBytes, 32);
    assert.equal(config.session.lastUsedUpdateIntervalMs, 300_000);
    assert.equal(config.invitation.ttlHours, 72);
    assert.equal(config.invitation.ttlMs, 72 * 3_600_000);
  });

  it('reads supported environment variables', () => {
    const config = parseConfig({
      NODE_ENV: 'production',
      PORT: '8080',
      API_PREFIX: '/api/v1/',
      LOG_LEVEL: 'warn',
    });

    assert.equal(config.environment, 'production');
    assert.equal(config.port, 8080);
    assert.equal(config.apiPrefix, '/api/v1');
    assert.equal(config.logLevel, 'warn');
    assert.equal(config.isProduction, true);
    assert.equal(config.isDevelopment, false);
  });

  it('accepts test environment and defaults to asentra_test', () => {
    const config = parseConfig({ NODE_ENV: 'test' });
    assert.equal(config.environment, 'test');
    assert.equal(config.isTest, true);
    assert.equal(config.database.name, 'asentra_test');
  });

  it('rejects an invalid PORT', () => {
    assert.throws(
      () => parseConfig({ PORT: 'invalid' }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /Invalid configuration: PORT/);
        assert.match(error.message, /invalid/);
        return true;
      },
    );
  });

  it('rejects an out-of-range PORT', () => {
    assert.throws(() => parseConfig({ PORT: '0' }), /Invalid configuration: PORT/);
  });

  it('rejects an unknown NODE_ENV', () => {
    assert.throws(
      () => parseConfig({ NODE_ENV: 'random' }),
      /Invalid configuration: NODE_ENV must be one of: development, test, production/,
    );
  });

  it('rejects an empty API_PREFIX', () => {
    assert.throws(
      () => parseConfig({ API_PREFIX: '' }),
      /Invalid configuration: API_PREFIX/,
    );
  });

  it('rejects an API_PREFIX without a leading slash', () => {
    assert.throws(
      () => parseConfig({ API_PREFIX: 'api/v1' }),
      /Invalid configuration: API_PREFIX/,
    );
  });

  it('rejects an unknown LOG_LEVEL', () => {
    assert.throws(
      () => parseConfig({ LOG_LEVEL: 'verbose' }),
      /Invalid configuration: LOG_LEVEL/,
    );
  });

  it('reads security configuration', () => {
    const config = parseConfig({
      CORS_ORIGINS: 'http://localhost:5173, https://app.example.com',
      JSON_BODY_LIMIT: '512kb',
    });

    assert.deepEqual(config.security.corsOrigins, [
      'http://localhost:5173',
      'https://app.example.com',
    ]);
    assert.equal(config.security.jsonBodyLimit, '512kb');
  });

  it('uses no CORS origins by default in production', () => {
    const config = parseConfig({ NODE_ENV: 'production' });
    assert.deepEqual(config.security.corsOrigins, []);
  });

  it('reads session configuration', () => {
    const config = parseConfig({
      SESSION_TTL_MINUTES: '60',
      SESSION_TOKEN_BYTES: '64',
      SESSION_LAST_USED_THROTTLE_MS: '0',
    });

    assert.equal(config.session.ttlMinutes, 60);
    assert.equal(config.session.ttlMs, 3_600_000);
    assert.equal(config.session.tokenBytes, 64);
    assert.equal(config.session.lastUsedUpdateIntervalMs, 0);
  });

  it('rejects an invalid SESSION_TTL_MINUTES', () => {
    assert.throws(
      () => parseConfig({ SESSION_TTL_MINUTES: '0' }),
      /Invalid configuration: SESSION_TTL_MINUTES must be at least 1/,
    );
  });

  it('rejects a non-integer SESSION_TOKEN_BYTES', () => {
    assert.throws(
      () => parseConfig({ SESSION_TOKEN_BYTES: 'abc' }),
      /Invalid configuration: SESSION_TOKEN_BYTES must be an integer/,
    );
  });

  it('rejects an undersized SESSION_TOKEN_BYTES', () => {
    assert.throws(
      () => parseConfig({ SESSION_TOKEN_BYTES: '8' }),
      /Invalid configuration: SESSION_TOKEN_BYTES must be at least 16/,
    );
  });

  it('reads invitation configuration', () => {
    const config = parseConfig({ INVITATION_TTL_HOURS: '24' });

    assert.equal(config.invitation.ttlHours, 24);
    assert.equal(config.invitation.ttlMs, 24 * 3_600_000);
  });

  it('rejects an invalid INVITATION_TTL_HOURS', () => {
    assert.throws(
      () => parseConfig({ INVITATION_TTL_HOURS: '0' }),
      /Invalid configuration: INVITATION_TTL_HOURS must be at least 1/,
    );
  });

  it('reads login rate limit configuration', () => {
    const config = parseConfig({
      AUTH_LOGIN_RATE_LIMIT_WINDOW_MINUTES: '5',
      AUTH_LOGIN_RATE_LIMIT_MAX_ATTEMPTS: '3',
    });

    assert.equal(config.security.loginRateLimitWindowMinutes, 5);
    assert.equal(config.security.loginRateLimitMaxAttempts, 3);
  });

  it('rejects an invalid login rate limit value', () => {
    assert.throws(
      () => parseConfig({ AUTH_LOGIN_RATE_LIMIT_MAX_ATTEMPTS: '0' }),
      /Invalid configuration: AUTH_LOGIN_RATE_LIMIT_MAX_ATTEMPTS must be at least 1/,
    );
  });

  it('rejects a wildcard CORS origin', () => {
    assert.throws(
      () => parseConfig({ CORS_ORIGINS: '*' }),
      /Invalid configuration: CORS_ORIGINS/,
    );
  });

  it('rejects an invalid JSON_BODY_LIMIT', () => {
    assert.throws(
      () => parseConfig({ JSON_BODY_LIMIT: 'huge' }),
      /Invalid configuration: JSON_BODY_LIMIT/,
    );
  });
});
