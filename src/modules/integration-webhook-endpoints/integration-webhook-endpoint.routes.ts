import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createIntegrationWebhookEndpointHandler,
  getIntegrationWebhookEndpointHandler,
  listIntegrationWebhookEndpointsHandler,
  rotateIntegrationWebhookEndpointSecretHandler,
  updateIntegrationWebhookEndpointHandler,
} from './integration-webhook-endpoint.controller';

/**
 * CR-BE-INTEG-01 PART 02 — webhook endpoint configuration surface.
 *
 *   POST  /integration/webhook-endpoints                    integration_webhook.manage
 *   GET   /integration/webhook-endpoints                    integration_webhook.read
 *   GET   /integration/webhook-endpoints/:id                integration_webhook.read
 *   PATCH /integration/webhook-endpoints/:id                integration_webhook.manage
 *   POST  /integration/webhook-endpoints/:id/rotate-secret  integration_webhook.manage
 *
 * RBAC-protected (default-deny) with dedicated integration permissions
 * (governance §10 — configuration permissions were rejected as
 * privilege-escalating for an SSRF-capable, secret-minting surface). All
 * handlers additionally intersect with the caller's BE-02G Client scope.
 * There is NO delete route: INACTIVE is the retirement path (§3.3), and no
 * manual event-injection or delivery surface exists (PART 03+/§11).
 */
export function createIntegrationWebhookEndpointRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('integration_webhook.read');
  const manage = requirePermission('integration_webhook.manage');

  router.post(
    '/integration/webhook-endpoints',
    auth,
    manage,
    createIntegrationWebhookEndpointHandler,
  );
  router.get(
    '/integration/webhook-endpoints',
    auth,
    read,
    listIntegrationWebhookEndpointsHandler,
  );
  router.get(
    '/integration/webhook-endpoints/:id',
    auth,
    read,
    getIntegrationWebhookEndpointHandler,
  );
  router.patch(
    '/integration/webhook-endpoints/:id',
    auth,
    manage,
    updateIntegrationWebhookEndpointHandler,
  );
  router.post(
    '/integration/webhook-endpoints/:id/rotate-secret',
    auth,
    manage,
    rotateIntegrationWebhookEndpointSecretHandler,
  );

  return router;
}
