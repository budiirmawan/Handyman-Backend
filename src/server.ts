import type { Server } from 'node:http';
import type { Pool } from 'pg';
import { createApp } from './app';
import { ConfigError, getAppConfig } from './config';
import { DatabaseError, closePool, initDatabase } from './database';
import { logger } from './shared/logger';
import type { DueJobScheduler } from './modules/due-job-scheduler';
import {
  startDueJobScheduler,
  stopDueJobScheduler,
} from './modules/due-job-scheduler';

/** Bounded wait (ms) for an in-flight dispatcher run during shutdown. */
const SCHEDULER_DRAIN_TIMEOUT_MS = 5_000;

function writeStartupError(error: unknown): void {
  const message =
    error instanceof ConfigError || error instanceof DatabaseError
      ? error.message
      : error instanceof Error
        ? error.message
        : 'Failed to start Asentra Backend';

  logger.error(message);
}

async function shutdown(
  signal: string,
  server: Server,
  pool: Pool,
  scheduler: DueJobScheduler | null,
  exitCode = 0,
): Promise<void> {
  logger.info('Shutdown initiated', { signal });

  // CR-BE-STAB-01 PART 04 — clear the scheduler timer before tearing down so
  // no dispatcher tick can run during or after shutdown.
  // CR-BE-STAB-03 PART 04 — drain any in-flight dispatcher run with a bounded
  // wait BEFORE closing the pool, so shutdown cannot hang indefinitely.
  if (scheduler) {
    logger.info('Due job scheduler draining');
    await stopDueJobScheduler(SCHEDULER_DRAIN_TIMEOUT_MS);
  }

  logger.info('HTTP server closing');

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });

  logger.info('PostgreSQL pool closing');
  await closePool(pool);
  logger.info('Shutdown completed');
  process.exit(exitCode);
}

async function start(): Promise<void> {
  try {
    const config = getAppConfig();
    const pool = await initDatabase(config.database);

    const app = createApp();
    const server = app.listen(config.port, '0.0.0.0', () => {
      logger.info('Asentra Backend started', {
        environment: config.environment,
        port: config.port,
        apiPrefix: config.apiPrefix,
      });
    });

    // CR-BE-STAB-01 PART 04 — start the due job scheduler once during boot.
    // It self-disables in the test environment and is stopped on shutdown.
    const scheduler = startDueJobScheduler(config.scheduler);

    server.on('error', (error) => {
      writeStartupError(error);
      void closePool(pool)
        .catch(() => undefined)
        .finally(() => {
          process.exit(1);
        });
    });

    let shuttingDown = false;

    const requestShutdown = (signal: string, exitCode = 0): void => {
      if (shuttingDown) {
        return;
      }

      shuttingDown = true;
      void shutdown(signal, server, pool, scheduler, exitCode).catch((error) => {
        writeStartupError(error);
        process.exit(1);
      });
    };

    process.on('SIGINT', () => requestShutdown('SIGINT'));
    process.on('SIGTERM', () => requestShutdown('SIGTERM'));

    // CR-BE-STAB-03 PART 03 — route fatal process-level failures through the
    // same guarded shutdown path. The existing `shuttingDown` guard prevents
    // duplicate shutdown; `shutdown()` performs the real teardown + exit.
    // CR-BE-STAB-03 FINAL REVIEW — fatal failures exit non-zero (matching the
    // pre-CR process crash, exit 1) so supervisors still see the failure;
    // teardown itself stays graceful. Signals keep the clean exit code 0.
    const handleFatalError = (reason: unknown): void => {
      writeStartupError(reason);
      requestShutdown('FATAL_ERROR', 1);
    };

    process.on('unhandledRejection', (reason: unknown) => {
      handleFatalError(reason);
    });
    process.on('uncaughtException', (error: Error) => {
      handleFatalError(error);
    });
  } catch (error) {
    writeStartupError(error);
    process.exitCode = 1;
  }
}

void start();
