import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseConfig } from '../src/config/env';
import {
  DatabaseError,
  closePool,
  createPool,
  describeDatabase,
  getPool,
  initDatabase,
  sanitizeDatabaseError,
  verifyConnection,
} from '../src/database';
import { skipIfNoTestDatabase, testDatabaseConfig } from './helpers/postgres';

describe('database helpers', () => {
  it('describes the database without the password', () => {
    const database = {
      ...testDatabaseConfig(),
      password: 'super-secret-password',
    };

    assert.equal(
      describeDatabase(database),
      `${database.host}:${database.port}/${database.name}`,
    );
  });

  it('redacts a password from driver messages', () => {
    const message = sanitizeDatabaseError(
      'password authentication failed for user "postgres" using super-secret-password',
      'super-secret-password',
    );

    assert.match(message, /\*\*\*/);
    assert.doesNotMatch(message, /super-secret-password/);
  });

  it('rejects getPool before initialization', () => {
    assert.throws(() => getPool(), /Database pool has not been initialized/);
  });
});

describe('PostgreSQL connection', () => {
  it('connects and runs SELECT 1 against asentra_test', async (t) => {
    const database = await skipIfNoTestDatabase(t);
    if (!database) {
      return;
    }

    const pool = await initDatabase(database);

    try {
      const result = await pool.query('SELECT 1 AS ok');
      assert.equal(result.rows[0]?.ok, 1);
    } finally {
      await closePool(pool);
    }
  });

  it('fails clearly for an unknown database without exposing a password', async () => {
    const database = {
      ...testDatabaseConfig(),
      name: 'asentra_missing_db',
      password: 'super-secret-password',
    };
    const pool = createPool(database);

    try {
      await assert.rejects(
        () => verifyConnection(pool, database),
        (error: unknown) => {
          assert.ok(error instanceof DatabaseError);
          assert.match(error.message, /Database connection failed/);
          assert.match(error.message, /asentra_missing_db/);
          assert.doesNotMatch(error.message, /super-secret-password/);
          return true;
        },
      );
    } finally {
      await pool.end();
    }
  });
});

describe('database configuration', () => {
  it('uses local PostgreSQL defaults in development', () => {
    const config = parseConfig({});

    assert.equal(config.database.host, 'localhost');
    assert.equal(config.database.port, 5432);
    assert.equal(config.database.name, 'asentra');
    assert.equal(config.database.user, 'postgres');
    assert.equal(config.database.password, '');
    assert.equal(config.database.ssl, false);
  });

  it('defaults the test database name to asentra_test', () => {
    const config = parseConfig({ NODE_ENV: 'test' });
    assert.equal(config.database.name, 'asentra_test');
  });

  it('rejects an empty database name', () => {
    assert.throws(
      () => parseConfig({ DB_NAME: '' }),
      /Invalid configuration: DB_NAME must not be empty/,
    );
  });

  it('rejects an invalid DB_PORT', () => {
    assert.throws(
      () => parseConfig({ DB_PORT: 'abc' }),
      /Invalid configuration: DB_PORT/,
    );
  });
});
