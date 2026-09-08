import { ConfigError, loadConfig } from '../config';
import {
  DatabaseError,
  closePool,
  createPool,
  describeDatabase,
  sanitizeDatabaseError,
  verifyConnection,
} from './connection';
import { getMigrationStatus, migrateDown, migrateUp } from './migrate';
import { runSeeds } from './seed';

const USAGE = 'Usage: db:migrate | db:migrate:status | db:migrate:down | db:seed';

async function main(): Promise<void> {
  const command = process.argv[2];

  if (
    command !== 'migrate' &&
    command !== 'status' &&
    command !== 'down' &&
    command !== 'seed'
  ) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 1;
    return;
  }

  try {
    const config = loadConfig();
    const pool = createPool(config.database);

    try {
      await verifyConnection(pool, config.database);
      process.stdout.write(
        `Connected ${describeDatabase(config.database)}\n`,
      );

      if (command === 'status') {
        await printStatus(pool);
        return;
      }

      if (command === 'seed') {
        const applied = await runSeeds(pool);
        if (applied.length === 0) {
          process.stdout.write('No seeds registered.\n');
          return;
        }

        for (const id of applied) {
          process.stdout.write(`Seeded ${id}\n`);
        }

        process.stdout.write(`Seeded ${applied.length} seed(s).\n`);
        return;
      }

      if (command === 'migrate') {
        const applied = await migrateUp(pool);
        if (applied.length === 0) {
          process.stdout.write('No pending migrations.\n');
          return;
        }

        for (const id of applied) {
          process.stdout.write(`Applied ${id}\n`);
        }

        process.stdout.write(`Applied ${applied.length} migration(s).\n`);
        return;
      }

      const rolledBack = await migrateDown(pool);
      if (!rolledBack) {
        process.stdout.write('No applied migrations to roll back.\n');
        return;
      }

      process.stdout.write(`Rolled back ${rolledBack}\n`);
    } finally {
      await closePool(pool).catch(() => undefined);
    }
  } catch (error) {
    const password = process.env.DB_PASSWORD ?? '';
    process.stderr.write(`${formatError(error, password)}\n`);
    process.exitCode = 1;
  }
}

async function printStatus(
  pool: Parameters<typeof getMigrationStatus>[0],
): Promise<void> {
  const items = await getMigrationStatus(pool);

  if (items.length === 0) {
    process.stdout.write('No migrations registered.\n');
    return;
  }

  for (const item of items) {
    const state = item.applied ? 'applied' : 'pending';
    const when = item.appliedAt ? `  ${item.appliedAt.toISOString()}` : '';
    process.stdout.write(`[${state}] ${item.id}${when}\n`);
  }
}

function formatError(error: unknown, password: string): string {
  const message =
    error instanceof ConfigError || error instanceof DatabaseError
      ? error.message
      : error instanceof Error
        ? error.message
        : 'Migration failed';

  return sanitizeDatabaseError(message, password);
}

void main();
