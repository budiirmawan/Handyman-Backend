import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigError, parseConfig } from '../src/config/env';

/**
 * CR-HM-DB-OPT-01 PART 02 — connection pool configuration.
 *
 * Pure configuration tests (no PostgreSQL): validated pool sizing/timeouts,
 * Railway private DATABASE_URL support, field-level DB_* overrides, and
 * rejection of malformed values. Defaults must equal the historical hard-coded
 * pool values so existing deployments see zero behavior change.
 */
describe('CR-HM-DB-OPT-01 — database pool settings', () => {
  it('defaults match the historical hard-coded pool behavior', () => {
    const config = parseConfig({});

    assert.equal(config.database.pool.max, 10);
    assert.equal(config.database.pool.min, 0);
    assert.equal(config.database.pool.connectionTimeoutMs, 5_000);
    assert.equal(config.database.pool.idleTimeoutMs, 30_000);
    assert.equal(config.database.pool.statementTimeoutMs, 0);
    assert.equal(config.database.pool.idleInTransactionSessionTimeoutMs, 0);
  });

  it('accepts explicit pool sizing and timeouts', () => {
    const config = parseConfig({
      DB_POOL_MAX: '25',
      DB_POOL_MIN: '2',
      DB_CONNECTION_TIMEOUT_MS: '10000',
      DB_IDLE_TIMEOUT_MS: '60000',
      DB_STATEMENT_TIMEOUT_MS: '30000',
      DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: '45000',
    });

    assert.equal(config.database.pool.max, 25);
    assert.equal(config.database.pool.min, 2);
    assert.equal(config.database.pool.connectionTimeoutMs, 10_000);
    assert.equal(config.database.pool.idleTimeoutMs, 60_000);
    assert.equal(config.database.pool.statementTimeoutMs, 30_000);
    assert.equal(config.database.pool.idleInTransactionSessionTimeoutMs, 45_000);
  });

  it('rejects out-of-range pool values instead of silently clamping', () => {
    assert.throws(() => parseConfig({ DB_POOL_MAX: '0' }), ConfigError);
    assert.throws(() => parseConfig({ DB_POOL_MAX: '101' }), ConfigError);
    assert.throws(() => parseConfig({ DB_POOL_MIN: '-1' }), ConfigError);
    assert.throws(() => parseConfig({ DB_CONNECTION_TIMEOUT_MS: '10' }), ConfigError);
    assert.throws(() => parseConfig({ DB_IDLE_TIMEOUT_MS: '10' }), ConfigError);
    assert.throws(() => parseConfig({ DB_STATEMENT_TIMEOUT_MS: '99999999' }), ConfigError);
    assert.throws(() => parseConfig({ DB_POOL_MAX: 'abc' }), ConfigError);
  });

  it('rejects DB_POOL_MIN greater than DB_POOL_MAX', () => {
    assert.throws(
      () => parseConfig({ DB_POOL_MIN: '20', DB_POOL_MAX: '10' }),
      /DB_POOL_MIN/,
    );
  });
});

describe('CR-HM-DB-OPT-01 — DATABASE_URL support', () => {
  it('uses DATABASE_URL when DB_* fields are unset', () => {
    const config = parseConfig({
      DATABASE_URL:
        'postgresql://railway_user:s3cret@private-host.railway.internal:5432/asentra?sslmode=require',
    });

    assert.equal(config.database.host, 'private-host.railway.internal');
    assert.equal(config.database.port, 5432);
    assert.equal(config.database.name, 'asentra');
    assert.equal(config.database.user, 'railway_user');
    assert.equal(config.database.password, 's3cret');
    assert.equal(config.database.ssl, true);
  });

  it('maps libpq sslmode values onto the SSL flag', () => {
    const base = 'postgresql://user:pass@host:5432/db';
    assert.equal(parseConfig({ DATABASE_URL: `${base}?sslmode=disable` }).database.ssl, false);
    assert.equal(parseConfig({ DATABASE_URL: `${base}?sslmode=allow` }).database.ssl, false);
    assert.equal(parseConfig({ DATABASE_URL: `${base}?sslmode=prefer` }).database.ssl, true);
    assert.equal(parseConfig({ DATABASE_URL: `${base}?sslmode=require` }).database.ssl, true);
    assert.equal(parseConfig({ DATABASE_URL: `${base}?sslmode=verify-full` }).database.ssl, true);
  });

  it('lets explicit DB_* variables override individual URL fields', () => {
    const config = parseConfig({
      DATABASE_URL: 'postgresql://url_user:url_pass@url-host:5433/url_db?sslmode=disable',
      DB_HOST: 'override-host',
      DB_PORT: '6000',
      DB_NAME: 'override_db',
      DB_USER: 'override_user',
      DB_PASSWORD: 'override_pass',
      DB_SSL: 'true',
    });

    assert.equal(config.database.host, 'override-host');
    assert.equal(config.database.port, 6000);
    assert.equal(config.database.name, 'override_db');
    assert.equal(config.database.user, 'override_user');
    assert.equal(config.database.password, 'override_pass');
    assert.equal(config.database.ssl, true);
  });

  it('ignores an empty DATABASE_URL and keeps defaults', () => {
    const config = parseConfig({ DATABASE_URL: '' });
    assert.equal(config.database.host, 'localhost');
    assert.equal(config.database.name, 'asentra');
  });

  it('rejects malformed DATABASE_URL values instead of booting unintended', () => {
    assert.throws(() => parseConfig({ DATABASE_URL: 'not a url' }), ConfigError);
    assert.throws(
      () => parseConfig({ DATABASE_URL: 'mysql://user:pass@host:3306/db' }),
      /postgres/,
    );
    assert.throws(
      () => parseConfig({ DATABASE_URL: 'postgresql://user:pass@host:5432' }),
      /database name/,
    );
    assert.throws(
      () => parseConfig({ DATABASE_URL: 'postgresql://user:pass@host:5432/db?sslmode=sometimes' }),
      /sslmode/,
    );
  });

  it('preserves the test-environment database name default without a URL', () => {
    const config = parseConfig({ NODE_ENV: 'test' });
    assert.equal(config.database.name, 'asentra_test');
    assert.equal(config.database.pool.max, 10);
  });

  it('never falls back to a public URL variable', () => {
    const config = parseConfig({
      DATABASE_PUBLIC_URL: 'postgresql://user:pass@public-host:5432/public_db',
    });
    assert.equal(config.database.host, 'localhost');
    assert.equal(config.database.name, 'asentra');
  });
});
