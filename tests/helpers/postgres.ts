import type { TestContext } from 'node:test';
import type { DatabaseConfig } from '../../src/config';
import { parseConfig } from '../../src/config';
import { createPool } from '../../src/database';

const SAFE_DB_NAME = /^[a-z][a-z0-9_]*$/;

export function testDatabaseConfig(): DatabaseConfig {
  return parseConfig({
    ...process.env,
    NODE_ENV: process.env.NODE_ENV ?? 'test',
  }).database;
}

export function assertIsolatedTestDatabase(name: string): void {
  if (name === 'asentra') {
    throw new Error(
      'Refusing to run destructive tests against the development database asentra',
    );
  }

  if (!SAFE_DB_NAME.test(name)) {
    throw new Error(`Unsafe test database name: ${name}`);
  }
}

export async function ensureTestDatabase(): Promise<DatabaseConfig | null> {
  const database = testDatabaseConfig();

  try {
    assertIsolatedTestDatabase(database.name);
  } catch {
    return null;
  }

  const admin = createPool({
    ...database,
    name: 'postgres',
  });

  try {
    const existing = await admin.query<{ exists: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists',
      [database.name],
    );

    if (!existing.rows[0]?.exists) {
      await admin.query(`CREATE DATABASE ${database.name}`);
    }

    return database;
  } catch {
    return null;
  } finally {
    await admin.end().catch(() => undefined);
  }
}

export async function skipIfNoTestDatabase(
  t: TestContext,
): Promise<DatabaseConfig | null> {
  const database = await ensureTestDatabase();
  if (!database) {
    t.skip('local PostgreSQL test database asentra_test is unavailable');
    return null;
  }

  return database;
}
