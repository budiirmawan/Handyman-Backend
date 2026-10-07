import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  cancelIncidentHandler,
  createIncidentHandler,
  getIncidentHandler,
  listIncidentsHandler,
  updateIncidentHandler,
} from './incident.controller';

/**
 * BE-21A — one shared Incident foundation for Operational Incident (BE-21B),
 * Asset Failure / Defect (BE-21C), and Finding Escalation (BE-21D). Later
 * BE-21 PARTs must build on these records and routes rather than introduce a
 * second Incident, Defect, or Corrective Action domain.
 *
 * RBAC is default-deny: every route requires an explicit permission, and the
 * service additionally asserts Building access, so an authenticated user with
 * the right permission still cannot reach another Building's incidents.
 */
export function createIncidentRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('incident.read');
  const manage = requirePermission('incident.manage');

  router.post('/incidents', auth, manage, createIncidentHandler);
  router.get('/incidents', auth, read, listIncidentsHandler);
  router.post('/incidents/:id/cancel', auth, manage, cancelIncidentHandler);
  router.get('/incidents/:id', auth, read, getIncidentHandler);
  router.patch('/incidents/:id', auth, manage, updateIncidentHandler);

  return router;
}
