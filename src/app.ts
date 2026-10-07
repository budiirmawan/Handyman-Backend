import express, { type Express } from 'express';
import { getAppConfig } from './config';
import { createCorsMiddleware } from './middleware/cors';
import { errorHandler } from './middleware/error-handler';
import { notFoundHandler } from './middleware/not-found';
import { requestIdMiddleware } from './middleware/request-id';
import { requestLogger } from './middleware/request-logger';
import { mobileContextMiddleware } from './middleware/mobile-context';
import { createSecurityHeaders } from './middleware/security';
import { createWhatsAppCallbackRouter } from './modules/whatsapp-callback';
import { registerIntegrationWebhookSubscriptionProbe } from './modules/integration-webhook-endpoints';
import { createApiRouter } from './routes';
import { sendSuccess } from './shared/api-response';

export type CreateAppOptions = {
  configure?: (app: Express) => void;
};

/**
 * Express application initialization.
 * Future versioned routers register through createApiRouter().
 */
export function createApp(options: CreateAppOptions = {}): Express {
  const app = express();
  const config = getAppConfig();

  // CR-BE-INTEG-01 PART 02 — replace the PART 01 conservative outbox probe
  // with the real ACTIVE-endpoint subscription probe (idempotent).
  registerIntegrationWebhookSubscriptionProbe();

  app.disable('x-powered-by');

  // CR-BE-AUDIT-01 PART 01 — establish the authoritative request ID and
  // request-local AsyncLocalStorage context before any middleware that may
  // reject the request.
  app.use(requestIdMiddleware);
  app.use(createSecurityHeaders());
  app.use(createCorsMiddleware(config.security.corsOrigins));
  app.use(mobileContextMiddleware);
  app.use(requestLogger);

  // CR-BE-NOTIFY-PROV-01 PART 07 — provider callback surface (disabled by
  // default; null when WHATSAPP_WEBHOOK_ENABLED is not true). Mounted BEFORE
  // the app-wide JSON parser: webhook signatures verify the RAW body bytes.
  const whatsAppCallbackRouter = createWhatsAppCallbackRouter();
  if (whatsAppCallbackRouter) {
    app.use('/webhooks/notifications/whatsapp', whatsAppCallbackRouter);
  }

  app.use(express.json({ limit: config.security.jsonBodyLimit }));

  app.get('/', (_req, res) => {
    sendSuccess(res, {
      name: 'Asentra Backend',
      status: 'running',
    });
  });

  app.use(config.apiPrefix, createApiRouter());
  options.configure?.(app);
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
