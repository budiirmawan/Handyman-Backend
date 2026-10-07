import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createSecurityIncidentReadinessHandler,
  getSecurityIncidentReadinessHandler,
  listSecurityIncidentReadinessHandler,
  updateSecurityIncidentReadinessHandler,
} from './security-incident-readiness.controller';

/**
 * BE-12I — Security Incident Readiness endpoints.
 *
 *   POST /security/incident-readiness
 *   GET  /security/incident-readiness
 *   GET  /security/incident-readiness/:id
 *   PATCH /security/incident-readiness/:id
 *
 * Configuration-only foundation. No incident master, no incident
 * workflow, no SLA, no dispatch / notification engine — the actual
 * incident engine is out of scope for this PART and will be added in
 * a later BE-12 PART.
 */
export function createSecurityIncidentReadinessRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('security_incident_readiness.manage');
  const read = requirePermission('security_incident_readiness.read');

  router.post(
    '/security/incident-readiness',
    auth,
    manage,
    createSecurityIncidentReadinessHandler,
  );
  router.get(
    '/security/incident-readiness',
    auth,
    read,
    listSecurityIncidentReadinessHandler,
  );
  router.get(
    '/security/incident-readiness/:id',
    auth,
    read,
    getSecurityIncidentReadinessHandler,
  );
  router.patch(
    '/security/incident-readiness/:id',
    auth,
    manage,
    updateSecurityIncidentReadinessHandler,
  );

  return router;
}
