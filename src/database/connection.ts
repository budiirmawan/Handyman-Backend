import { Pool, type PoolConfig } from 'pg';
import type { DatabaseConfig } from '../config';
import { logger } from '../shared/logger';

export class DatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseError';
  }
}

export function describeDatabase(database: DatabaseConfig): string {
  return `${database.host}:${database.port}/${database.name}`;
}

export function sanitizeDatabaseError(message: string, password: string): string {
  if (password.length === 0) {
    return message;
  }

  return message.split(password).join('***');
}

export function createPool(database: DatabaseConfig): Pool {
  const config: PoolConfig = {
    host: database.host,
    port: database.port,
    database: database.name,
    user: database.user,
    password: database.password,
    ssl: database.ssl ? { rejectUnauthorized: true } : false,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  };

  const pool = new Pool(config);

  // CR-BE-STAB-03 PART 03 — surface unexpected idle-client / pool errors
  // instead of letting them crash the process. The pool emits 'error' for
  // connection-level failures on idle clients; log and keep serving.
  pool.on('error', (error) => {
    const pgError = error as { code?: string; message: string };
    logger.error('PostgreSQL pool error', {
      code: pgError.code,
      errorMessage: pgError.message,
    });
  });

  return pool;
}

export async function verifyConnection(
  pool: Pool,
  database: DatabaseConfig,
): Promise<void> {
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : 'unknown error';
    const message = `Database connection failed (${describeDatabase(database)}): ${sanitizeDatabaseError(detail, database.password)}`;
    logger.error('PostgreSQL connectivity check failed', {
      host: database.host,
      port: database.port,
      database: database.name,
      errorMessage: sanitizeDatabaseError(detail, database.password),
    });
    throw new DatabaseError(message);
  }
}

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    throw new DatabaseError('Database pool has not been initialized');
  }

  return pool;
}

export async function initDatabase(database: DatabaseConfig): Promise<Pool> {
  const nextPool = createPool(database);

  try {
    await verifyConnection(nextPool, database);
  } catch (error) {
    await nextPool.end().catch(() => undefined);
    throw error;
  }

  pool = nextPool;
  logger.info('PostgreSQL connection established', {
    host: database.host,
    port: database.port,
    database: database.name,
  });
  return nextPool;
}

export async function closePool(activePool: Pool = getPool()): Promise<void> {
  await activePool.end();

  if (pool === activePool) {
    pool = undefined;
    logger.info('PostgreSQL pool closed');
  }
}
