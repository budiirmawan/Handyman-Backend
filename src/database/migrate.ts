import type { Pool, PoolClient } from 'pg';
import { DatabaseError } from './connection';
import { migrations } from './migrations';

export type MigrationStatusItem = {
  id: string;
  applied: boolean;
  appliedAt: Date | null;
};

const HISTORY_TABLE = 'schema_migrations';

export async function ensureMigrationHistory(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${HISTORY_TABLE} (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function listAppliedMigrationIds(
  client: PoolClient,
): Promise<Map<string, Date>> {
  await ensureMigrationHistory(client);

  const result = await client.query<{ id: string; applied_at: Date }>(
    `SELECT id, applied_at FROM ${HISTORY_TABLE} ORDER BY id ASC`,
  );

  return new Map(result.rows.map((row) => [row.id, row.applied_at]));
}

export async function getMigrationStatus(
  pool: Pool,
): Promise<MigrationStatusItem[]> {
  const client = await pool.connect();

  try {
    const applied = await listAppliedMigrationIds(client);

    return migrations.map((migration) => ({
      id: migration.id,
      applied: applied.has(migration.id),
      appliedAt: applied.get(migration.id) ?? null,
    }));
  } finally {
    client.release();
  }
}

export async function migrateUp(pool: Pool): Promise<string[]> {
  const appliedIds: string[] = [];

  for (const migration of migrations) {
    const applied = await withTransaction(pool, async (client) => {
      const history = await listAppliedMigrationIds(client);
      if (history.has(migration.id)) {
        return false;
      }

      await migration.up(client);
      await client.query(`INSERT INTO ${HISTORY_TABLE} (id) VALUES ($1)`, [
        migration.id,
      ]);
      return true;
    });

    if (applied) {
      appliedIds.push(migration.id);
    }
  }

  return appliedIds;
}

export async function migrateDown(pool: Pool): Promise<string | null> {
  return withTransaction(pool, async (client) => {
    const history = await listAppliedMigrationIds(client);
    const applied = migrations.filter((migration) => history.has(migration.id));
    const current = applied.at(-1);

    if (!current) {
      return null;
    }

    await current.down(client);
    await client.query(`DELETE FROM ${HISTORY_TABLE} WHERE id = $1`, [
      current.id,
    ]);
    return current.id;
  });
}

async function withTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw toMigrationError(error);
  } finally {
    client.release();
  }
}

function toMigrationError(error: unknown): DatabaseError {
  if (error instanceof DatabaseError) {
    return error;
  }

  const detail = error instanceof Error ? error.message : 'unknown error';
  return new DatabaseError(`Migration failed: ${detail}`);
}
