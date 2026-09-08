import { Router } from 'express';
import { getAppConfig } from '../config';
import { getPool, verifyConnection } from '../database';
import { sendSuccess } from '../shared/api-response';
import { AppError } from '../shared/errors';

export function createHealthRouter(): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    const config = getAppConfig();

    sendSuccess(res, {
      status: 'ok',
      environment: config.environment,
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  router.get('/health/database', async (_req, res) => {
    const config = getAppConfig();

    try {
      const pool = getPool();
      await verifyConnection(pool, config.database);
      sendSuccess(res, {
        status: 'ok',
        database: 'connected',
      });
    } catch {
      throw AppError.databaseUnavailable();
    }
  });

  return router;
}
