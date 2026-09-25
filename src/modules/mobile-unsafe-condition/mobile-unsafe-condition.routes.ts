import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { reportMobileUnsafeConditionHandler } from './mobile-unsafe-condition.controller';

/**
 * CR-BE-RN10-SAFE-EQUIPMENT-01 PART 01 — Mobile unsafe condition reporting.
 *
 *   POST /mobile/assets/:assetId/unsafe-condition
 *
 * RBAC (`asset_failure.report`):
 *   Deliberately NOT `asset_failure.manage`. Managing the Asset Failure /
 *   Incident domain — updating details, moving the failure-handling
 *   progression, resolving — is management authority and stays on the BE-21C
 *   `/asset-failures` surface. Reporting an unsafe condition is FIELD
 *   authority: a technician who observes a hazard must be able to record it
 *   without being able to administer the record afterwards.
 *
 * `asset_failure.report` is a dedicated code rather than a reuse of an
 * unrelated permission (`checklist.manage`, `work_order.manage`, …). Reusing a
 * neighbour for convenience is how authority silently widens; a dedicated code
 * can be granted, audited, and revoked on its own.
 *
 * Path convention:
 *   `/mobile/<resource>/<id>/<action>` matches the established mobile
 *   composition surface (`/mobile/checklist-executions/:executionId/finding`,
 *   `/mobile/tasks/:taskId/form-instance`,
 *   `/mobile/checklist-executions/:executionId/start`). The command lives on
 *   the MOBILE surface rather than on `/asset-failures` because BE-21C's own
 *   routes address the Incident collection, and BE-21C is explicit that an
 *   Incident specialization must not graft its endpoints onto the `/assets`
 *   namespace. A mobile composition module is the established answer to that
 *   (`mobile-qr-resolution`, `mobile-verification`).
 *
 * Building isolation is NOT `requireBuildingAccess` here because the Building
 * is not in the path: it is derived from the Asset, so the service asserts the
 * caller's Building access after resolving the Asset — the same posture the
 * `/assets/:id` routes take.
 *
 * No other endpoint is exposed by this PART. There is no read route (the
 * canonical read is BE-21C's `GET /asset-failures/{incidentId}`), and no
 * OUT_OF_SERVICE / ISOLATED / SHUT_DOWN / RETURN_TO_SERVICE command exists.
 */
export function createMobileUnsafeConditionRouter(): Router {
  const router = Router();

  router.post(
    '/mobile/assets/:assetId/unsafe-condition',
    authenticationMiddleware,
    requirePermission('asset_failure.report'),
    reportMobileUnsafeConditionHandler,
  );

  return router;
}
