import { ConfigError, loadConfig } from '../config';
import {
  DatabaseError,
  closePool,
  describeDatabase,
  initDatabase,
  sanitizeDatabaseError,
} from './connection';
import { getMigrationStatus, migrateDown, migrateUp } from './migrate';
import { runSeeds } from './seed';
import {
  bootstrapOwner,
  getOwnerBootstrapStatus,
  parseBootstrapOwnerArgs,
  promptForNewPassword,
  type BootstrapOwnerArgs,
  type BootstrapOwnerResult,
} from '../modules/iam-bootstrap';
import { passwordService } from '../modules/auth';

const USAGE = [
  'Usage: db:migrate | db:migrate:status | db:migrate:down | db:seed',
  '       node dist/database/cli.js bootstrap-owner --email <email> --display-name <name>',
  '       node dist/database/cli.js bootstrap-status',
].join('\n');

async function main(): Promise<void> {
  const command = process.argv[2];

  if (
    command !== 'migrate' &&
    command !== 'status' &&
    command !== 'down' &&
    command !== 'seed' &&
    command !== 'bootstrap-owner' &&
    command !== 'bootstrap-status'
  ) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 1;
    return;
  }

  try {
    // Argument safety is checked BEFORE configuration, connection or any
    // secret input. `--password` is refused immediately.
    let bootstrapArgs: BootstrapOwnerArgs | undefined;
    if (command === 'bootstrap-owner') {
      bootstrapArgs = parseBootstrapOwnerArgs(process.argv.slice(3));
    }

    const config = loadConfig();
    // `initDatabase` both verifies connectivity and installs the process-wide
    // pool used by the bootstrap service (repository calls).
    const pool = await initDatabase(config.database);

    try {
      process.stdout.write(
        `Connected ${describeDatabase(config.database)}\n`,
      );

      if (command === 'status') {
        await printStatus(pool);
        return;
      }

      if (command === 'bootstrap-status') {
        await printBootstrapStatus();
        return;
      }

      if (command === 'bootstrap-owner') {
        // The secret is read only after the target database has been
        // successfully reached, and only from the controlling terminal.
        const password = await promptForNewPassword(
          passwordService.validatePassword,
        );
        const result = await bootstrapOwner({
          email: bootstrapArgs!.email,
          displayName: bootstrapArgs!.displayName,
          password,
        });
        printBootstrapResult(result);
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

async function printBootstrapStatus(): Promise<void> {
  const status = await getOwnerBootstrapStatus();

  process.stdout.write('First-owner bootstrap status\n');
  process.stdout.write(`  Schema ready: ${status.schemaReady ? 'yes' : 'no'}\n`);
  process.stdout.write(`  Users table ready: ${status.usersTableReady ? 'yes' : 'no'}\n`);
  process.stdout.write(`  Users in database: ${status.userCount}\n`);
  process.stdout.write(`  Bootstrap completed: ${status.completed ? 'yes' : 'no'}\n`);

  if (status.completed) {
    process.stdout.write(`  Owner user id: ${status.ownerUserId}\n`);
    process.stdout.write(`  Owner email: ${status.ownerEmail}\n`);
    process.stdout.write(`  Roles: ${status.roleCodes.join(', ')}\n`);
    process.stdout.write(`  Bootstrapped at: ${status.bootstrappedAt}\n`);
    process.stdout.write(
      '  The bootstrap is one-time and cannot be repeated on this database.\n',
    );
    return;
  }

  if (!status.schemaReady) {
    process.stdout.write(
      '  Next: apply migrations (node dist/database/cli.js migrate) before bootstrapping.\n',
    );
  } else if (status.userCount > 0) {
    process.stdout.write(
      '  Refusal expected: the users table is not empty. Bootstrap is only valid on a fresh database.\n',
    );
  } else {
    process.stdout.write(
      '  Ready: run bootstrap-owner from an interactive terminal.\n',
    );
  }
}

function printBootstrapResult(result: BootstrapOwnerResult): void {
  process.stdout.write('First-owner bootstrap complete.\n');
  process.stdout.write(`  Owner user id: ${result.ownerUserId}\n`);
  process.stdout.write(`  Email: ${result.email}\n`);
  process.stdout.write(`  Display name: ${result.displayName}\n`);
  process.stdout.write(`  Roles: ${result.roleCodes.join(', ')}\n`);
  process.stdout.write(
    `  Effective permissions: ${result.effectivePermissionCount}\n`,
  );
  process.stdout.write(
    `  Canonical persona roles created: ${result.canonicalRoleCodes.join(', ')}\n`,
  );
  process.stdout.write(`  Bootstrapped at: ${result.bootstrappedAt}\n`);
  process.stdout.write(
    '  The password is not stored, printed or recoverable here. Sign in via POST /api/v1/auth/login, then GET /api/v1/auth/me.\n',
  );
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
