import type { Pool, PoolClient } from 'pg';
import { DatabaseError } from './connection';
import { migrations } from './migrations';

export type MigrationStatusItem = {
  id: string;
  applied: boolean;
  appliedAt: Date | null;
};

const HISTORY_TABLE = 'schema_migrations';
// Stable application-specific PostgreSQL advisory lock; portable, no extension.
const MIGRATION_LOCK = 724196031;

/** Read-only gate: never creates history or changes schema using app credentials. */
export async function verifyMigrationReadiness(pool: Pool): Promise<void> {
  let ids: string[];
  try {
    const result = await pool.query<{ id: string }>(`SELECT id FROM ${HISTORY_TABLE}`);
    ids = result.rows.map((row) => row.id);
  } catch {
    throw new DatabaseError('Migration history unavailable; run the authorized one-shot migration before starting the API.');
  }
  const expected = new Set(migrations.map((migration) => migration.id));
  const applied = new Set(ids);
  if (migrations.some((migration) => !applied.has(migration.id)) ||
      ids.some((id) => !expected.has(id))) {
    throw new DatabaseError('Migration history does not match this artifact; inspect migration status before admitting API traffic.');
  }
}

/**
 * BA-03 — reject a populated 0478 downgrade before its destructive DDL.
 *
 * The pre-0478 exclusion cannot distinguish non-empty tier keys. Even a plain
 * SERVICE row would lose its key, and 0478's historical up has no backfill for
 * the non-null key check. The existing runner therefore treats every populated
 * SERVICE catalog as forward-only; empty databases retain normal down behavior.
 * This is a runner preflight, not a second migration registry or authority.
 */
async function assertMigrationDownSafe(
  client: PoolClient,
  migrationId: string,
): Promise<void> {
  if (migrationId !== '0478_service_price_tier_key') return;

  const result = await client.query<{
    service_rows: number;
    keyed_rows: number;
  }>(
    `SELECT COUNT(*)::int AS service_rows,
            (COUNT(*) FILTER (WHERE service_price_key <> ''))::int AS keyed_rows
     FROM price_catalog_entries
     WHERE source_mode = 'SERVICE'`,
  );
  const { service_rows: serviceRows, keyed_rows: keyedRows } = result.rows[0]!;
  if (serviceRows === 0) return;

  throw new DatabaseError(
    `Unsafe downgrade ${migrationId} refused: ${serviceRows} SERVICE price ` +
    `row(s), including ${keyedRows} with non-empty tier key(s), cannot be ` +
    'downgraded without erasing price identity. Keep 0478 applied and use a ' +
    'forward fix or paired backup/restore. No 0478 downgrade was attempted.',
  );
}

async function withMigrationLock<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let locked = false;
  let destroyed = false;
  try {
    const result = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked', [MIGRATION_LOCK],
    );
    locked = result.rows[0]?.locked === true;
    if (!locked) throw new DatabaseError('Another migration runner is active; retry only after it completes.');
    return await work(client);
  } finally {
    if (locked) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]);
      } catch {
        // Destroy the connection if unlocking fails; never return a locked session.
        client.release(true);
        destroyed = true;
      }
    }
    if (!destroyed) client.release();
  }
}

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

    const registered = new Set(migrations.map((migration) => migration.id));
    return [...migrations.map((migration) => ({
      id: migration.id,
      applied: applied.has(migration.id),
      appliedAt: applied.get(migration.id) ?? null,
    })), ...[...applied].filter(([id]) => !registered.has(id)).map(([id, appliedAt]) => ({
      id, applied: true, appliedAt,
    }))];
  } finally {
    client.release();
  }
}

export async function migrateUp(pool: Pool): Promise<string[]> {
  return withMigrationLock(pool, async (client) => {
    const appliedIds: string[] = [];
    const history = await listAppliedMigrationIds(client);
    const registered = new Set(migrations.map((migration) => migration.id));
    if ([...history.keys()].some((id) => !registered.has(id))) {
      throw new DatabaseError('Unknown applied migrations; use the matching artifact, not an older migration runner.');
    }

    for (const migration of migrations) {
      const applied = await withTransaction(client, async (client) => {
        const history = await listAppliedMigrationIds(client);
        if (history.has(migration.id)) {
          if (migration.id === '0472_handyman_assignment_responses') {
            const checkRes = await client.query<{ def: string }>(
              `SELECT pg_get_constraintdef(oid) AS def
                 FROM pg_constraint
                WHERE conname = 'notifications_navigation_target_check'
                LIMIT 1`,
            );
            const def = checkRes.rows[0]?.def ?? '';
            if (!def.includes('EXECUTION_SCOPE_FIELD_WORK')) {
              await migration.up(client);
            }
          }
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
  });
}

export async function migrateDown(pool: Pool): Promise<string | null> {
  return withMigrationLock(pool, (client) => withTransaction(client, async (client) => {
    const history = await listAppliedMigrationIds(client);
    const applied = migrations.filter((migration) => history.has(migration.id));
    const current = applied.at(-1);

    if (!current) {
      return null;
    }

    await assertMigrationDownSafe(client, current.id);
    await current.down(client);
    await client.query(`DELETE FROM ${HISTORY_TABLE} WHERE id = $1`, [
      current.id,
    ]);
    return current.id;
  }));
}

async function withTransaction<T>(
  client: PoolClient,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw toMigrationError(error);
  }
}

function toMigrationError(error: unknown): DatabaseError {
  if (error instanceof DatabaseError) {
    return error;
  }

  const detail = error instanceof Error ? error.message : 'unknown error';
  return new DatabaseError(`Migration failed: ${detail}`);
}
