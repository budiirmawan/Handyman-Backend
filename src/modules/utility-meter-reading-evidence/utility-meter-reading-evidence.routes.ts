import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  getReadingEvidenceHandler,
  listReadingEvidenceByFiltersHandler,
  listReadingEvidenceHandler,
  listReadingEvidenceRequirementsHandler,
  removeReadingEvidenceHandler,
  submitReadingEvidenceHandler,
  validateReadingEvidenceHandler,
} from './utility-meter-reading-evidence.controller';

/**
 * BE-18F — Reading Evidence endpoints.
 *
 * Reads (`utility_meter.read`):
 *   GET   /utility/meter-readings/:id/evidence-requirements
 *   GET   /utility/meter-readings/:id/evidence          (?includeRemoved=true)
 *   GET   /utility/meter-readings/:id/evidence-validation
 *   GET   /utility/meter-reading-evidence   (?meterReadingId= & ?meterId= & ?buildingId=)
 *   GET   /utility/meter-reading-evidence/:evidenceId
 * Management (`utility_meter.manage`):
 *   POST  /utility/meter-readings/:id/evidence
 *   PATCH /utility/meter-reading-evidence/:evidenceId   (BE-07 soft remove)
 *
 * The BE-18A `utility_meter.*` permissions are reused deliberately: reading
 * evidence is an attribute of a Meter Reading, not a separate domain, so it
 * must not introduce a parallel permission surface.
 *
 * Requirements themselves are created through the existing BE-07
 * `/evidence-requirements` endpoints with
 * `targetType = 'UTILITY_METER_READING'` — BE-18F exposes no duplicate
 * requirement-authoring surface.
 *
 * There is no DELETE: removal is BE-07's soft `status → 'REMOVED'`, so
 * evidence history is preserved.
 *
 * Building access is asserted in the service against the reading's own
 * Building, so isolation always derives from authoritative records rather
 * than a caller-supplied context.
 */
export function createUtilityMeterReadingEvidenceRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('utility_meter.manage');
  const read = requirePermission('utility_meter.read');

  router.get(
    '/utility/meter-readings/:id/evidence-requirements',
    auth,
    read,
    listReadingEvidenceRequirementsHandler,
  );
  router.get(
    '/utility/meter-readings/:id/evidence-validation',
    auth,
    read,
    validateReadingEvidenceHandler,
  );
  router.post(
    '/utility/meter-readings/:id/evidence',
    auth,
    manage,
    submitReadingEvidenceHandler,
  );
  router.get(
    '/utility/meter-readings/:id/evidence',
    auth,
    read,
    listReadingEvidenceHandler,
  );

  // Registered before the `/:evidenceId` route so the collection path is not
  // captured as an id.
  router.get(
    '/utility/meter-reading-evidence',
    auth,
    read,
    listReadingEvidenceByFiltersHandler,
  );
  router.get(
    '/utility/meter-reading-evidence/:evidenceId',
    auth,
    read,
    getReadingEvidenceHandler,
  );
  router.patch(
    '/utility/meter-reading-evidence/:evidenceId',
    auth,
    manage,
    removeReadingEvidenceHandler,
  );

  return router;
}
