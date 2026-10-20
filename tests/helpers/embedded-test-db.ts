import { mkdir, rm } from 'node:fs/promises';
import EmbeddedPostgres from 'embedded-postgres';

/**
 * CR-HM-18 — disposable embedded PostgreSQL bootstrap.
 *
 * Suites that call `ensureTestDatabase()` without a reachable server silently
 * SKIP (exit 0), which previously hid whole surfaces as "NOT TESTED". This
 * helper starts a throwaway cluster, points the process env at it, and creates
 * the test database, so a suite is self-contained and its evidence is real.
 */
export type EmbeddedTestDatabase = {
  pg: EmbeddedPostgres;
  dir: string;
  stop: () => Promise<void>;
};

export async function startEmbeddedTestDatabase(options: {
  dir: string;
  port: number;
  database?: string;
}): Promise<EmbeddedTestDatabase> {
  const database = options.database ?? 'asentra_test';
  const dir = options.dir;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  Object.assign(process.env, {
    DB_HOST: '127.0.0.1',
    DB_PORT: String(options.port),
    DB_USER: 'postgres',
    DB_PASSWORD: '',
    DB_NAME: database,
    DB_SSL: 'false',
  });
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    port: options.port,
    user: 'postgres',
    password: '',
    persistent: true,
    authMethod: 'trust',
  });
  await pg.initialise();
  await pg.start();
  const admin = pg.getPgClient('postgres', '127.0.0.1');
  await admin.connect();
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.end();
  return {
    pg,
    dir,
    stop: async () => {
      try {
        await pg.stop();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
