/**
 * CR-HM-DB-OPT-01 schema capture: boot a disposable embedded PostgreSQL
 * (devDependency `embedded-postgres`), run the repository migration chain, and
 * dump a schema/index/FK inventory JSON used by `gen-table-inventory.ts`.
 * Never points at a shared database; the data directory is created and removed
 * under scripts/db-bench/out/.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import EmbeddedPostgres from 'embedded-postgres';
import { createPool, migrateUp, migrations } from '../../src/database';
import type { DatabaseConfig } from '../../src/config';

const DATA_DIR = 'scripts/db-bench/out/pgdata';
const PORT = 55432;

const database: DatabaseConfig = {
  host: '127.0.0.1',
  port: PORT,
  name: 'asentra_bench',
  user: 'postgres',
  password: 'postgres',
  ssl: false,
  pool: {
    max: 4,
    min: 0,
    connectionTimeoutMs: 10_000,
    idleTimeoutMs: 30_000,
    statementTimeoutMs: 0,
    idleInTransactionSessionTimeoutMs: 0,
  },
};

async function main() {
  await rm(DATA_DIR, { recursive: true, force: true });
  await mkdir(DATA_DIR, { recursive: true });

  const pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    port: PORT,
    user: 'postgres',
    password: 'postgres',
    persistent: true,
    authMethod: 'password',
  } as never);

  await pg.initialise();
  await pg.start();
  console.log('PG started on port', PORT, '— version check next');

  const admin = createPool({ ...database, name: 'postgres' });
  const ver = await admin.query('SELECT version()');
  console.log(ver.rows[0].version);
  await admin.query('CREATE DATABASE asentra_bench');
  await admin.end();

  const pool = createPool(database);
  const t0 = Date.now();
  const applied = await migrateUp(pool);
  console.log(`migrateUp applied ${applied.length}/${migrations.length} migrations in ${Date.now() - t0}ms`);

  const inv = {} as {
    version: string;
    tables: unknown[];
    columns: unknown[];
    indexes: unknown[];
    constraints: unknown[];
    foreignKeys: unknown[];
    tableCount: number;
    indexCount: number;
  };

  inv.version = (await pool.query('SELECT version()')).rows[0].version;

  inv.tables = (await pool.query(`
    SELECT c.relname AS table,
           COALESCE(pg_catalog.obj_description(c.oid, 'pg_class'), '') AS comment,
           c.reltuples::bigint AS est_rows
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname
  `)).rows;

  inv.columns = (await pool.query(`
    SELECT table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position
  `)).rows;

  inv.indexes = (await pool.query(`
    SELECT tablename AS table,
           indexname AS index,
           indexdef AS definition
    FROM pg_indexes
    WHERE schemaname = 'public'
    ORDER BY tablename, indexname
  `)).rows;

  inv.constraints = (await pool.query(`
    SELECT conrelid::regclass::text AS table,
           conname AS name,
           pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace
    ORDER BY 1, 2
  `)).rows;

  inv.foreignKeys = (await pool.query(`
    SELECT
      tc.table_name AS table,
      kcu.column_name AS column,
      ccu.table_name AS references_table,
      ccu.column_name AS references_column,
      tc.constraint_name AS name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
    ORDER BY tc.table_name, kcu.column_name
  `)).rows;

  inv.tableCount = inv.tables.length;
  inv.indexCount = inv.indexes.length;

  await writeFile('scripts/db-bench/out/schema-inventory.json', JSON.stringify(inv, null, 2));
  console.log(`tables=${inv.tableCount} indexes=${inv.indexCount} fks=${inv.foreignKeys.length}`);

  await pool.end();
  await pg.stop();
  await rm(DATA_DIR, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
