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
    const applied =
      migration.transactional === false
        ? await runOutsideTransaction(pool, migration, 'up')
        : await withTransaction(pool, async (client) => {
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
  for (let index = migrations.length - 1; index >= 0; index -= 1) {
    const migration = migrations[index]!;
    const rolledBack =
      migration.transactional === false
        ? await runOutsideTransaction(pool, migration, 'down')
        : await withTransaction(pool, async (client) => {
            const history = await listAppliedMigrationIds(client);
            if (!history.has(migration.id)) {
              return false;
            }

            await migration.down(client);
            await client.query(`DELETE FROM ${HISTORY_TABLE} WHERE id = $1`, [
              migration.id,
            ]);
            return true;
          });

    if (rolledBack) {
      return migration.id;
    }
  }

  return null;
}

/**
 * CR-HM-DB-OPT-01 — runs a `transactional: false` migration (e.g. CREATE INDEX
 * CONCURRENTLY) on a dedicated client OUTSIDE any transaction block, then
 * records/removes its history row in its own single-statement transaction.
 *
 * The runner defensively disables statement_timeout for the duration of the
 * DDL (restoring the prior value afterwards) so an operator-configured
 * application timeout can never abort a CONCURRENTLY build halfway and leave
 * an invalid index behind.
 */
async function runOutsideTransaction(
  pool: Pool,
  migration: { id: string; up: (client: PoolClient) => Promise<void>; down: (client: PoolClient) => Promise<void> },
  direction: 'up' | 'down',
): Promise<boolean> {
  const client = await pool.connect();
  let previousStatementTimeout = '0';

  try {
    const history = await listAppliedMigrationIds(client);
    const alreadyApplied = history.has(migration.id);
    if (direction === 'up' ? alreadyApplied : !alreadyApplied) {
      return false;
    }

    const shown = await client.query<{ statement_timeout: string }>(
      'SHOW statement_timeout',
    );
    previousStatementTimeout = shown.rows[0]?.statement_timeout ?? '0';
    await client.query('SET statement_timeout = 0');

    try {
      if (direction === 'up') {
        await migration.up(client);
      } else {
        await migration.down(client);
      }

      if (direction === 'up') {
        await client.query(`INSERT INTO ${HISTORY_TABLE} (id) VALUES ($1)`, [
          migration.id,
        ]);
      } else {
        await client.query(`DELETE FROM ${HISTORY_TABLE} WHERE id = $1`, [
          migration.id,
        ]);
      }
      return true;
    } finally {
      await client
        .query(`SET statement_timeout = '${previousStatementTimeout.replace(/'/g, "''")}'`)
        .catch(() => undefined);
    }
  } catch (error) {
    throw toMigrationError(error);
  } finally {
    client.release();
  }
}

async function withTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    // CR-HM-DB-OPT-01 — migration DDL must not be aborted by a configured
    // application statement_timeout. SET LOCAL auto-reverts at COMMIT/ROLLBACK.
    await client.query('SET LOCAL statement_timeout = 0');
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
