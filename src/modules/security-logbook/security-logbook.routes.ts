import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { requireBuildingAccess } from '../context-access';
import {
  createLogbookEntryHandler,
  getLogbookEntryHandler,
  listLogbookEntriesHandler,
  updateLogbookEntryHandler,
} from './security-logbook.controller';

/**
 * CR-BE-MOB-05 PART 03 — Security Operational Logbook endpoints.
 *
 *   POST  /buildings/:buildingId/security/logbook   — create an entry (201)
 *   GET   /buildings/:buildingId/security/logbook   — list entries (filters)
 *   GET   /security/logbook/:id                     — entry detail
 *   PATCH /security/logbook/:id                     — update while OPEN
 *
 * Building-nested routes additionally pass through BE-02G
 * `requireBuildingAccess`, and every single-record read/write asserts the
 * entry's Building in the service — no cross-Building reads or writes.
 * Self-service identity: the entry's Workforce Profile is resolved from the
 * authenticated session, never from the request. Timestamps are backend-set
 * (database clock). The optional `shiftHandoverId` must reference an
 * existing authoritative `shift_handovers` row in the same Building.
 */
export function createSecurityLogbookRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('security_logbook.manage');
  const read = requirePermission('security_logbook.read');

  router.post(
    '/buildings/:buildingId/security/logbook',
    auth,
    manage,
    requireBuildingAccess('buildingId'),
    createLogbookEntryHandler,
  );
  router.get(
    '/buildings/:buildingId/security/logbook',
    auth,
    read,
    requireBuildingAccess('buildingId'),
    listLogbookEntriesHandler,
  );
  router.get(
    '/security/logbook/:id',
    auth,
    read,
    getLogbookEntryHandler,
  );
  router.patch(
    '/security/logbook/:id',
    auth,
    manage,
    updateLogbookEntryHandler,
  );

  return router;
}
