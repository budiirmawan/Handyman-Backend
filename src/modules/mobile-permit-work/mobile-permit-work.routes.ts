import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  closeMobilePermitWorkHandler,
  getMobilePermitWorkFieldContextHandler,
  listMobilePermitWorkHandler,
  startMobilePermitWorkHandler,
} from './mobile-permit-work.controller';
import {
  PERMIT_WORK_FIELD_EXECUTE_PERMISSION,
  PERMIT_WORK_FIELD_READ_PERMISSION,
} from './mobile-permit-work.types';

/**
 * CR-BE-RN20-PERMIT-FIELD-01 — Work Permit Field Execution.
 *
 *   GET  /mobile/permit-work                   permit_work_field.read
 *   GET  /mobile/permit-work/:permitId         permit_work_field.read
 *   POST /mobile/permit-work/:permitId/start   permit_work_field.execute
 *   POST /mobile/permit-work/:permitId/close   permit_work_field.execute
 *
 * AUTHORITY — three independent gates on every route
 * --------------------------------------------------
 *   1. `authenticationMiddleware`  — an authenticated session
 *   2. a DEDICATED field permission (above). Deliberately NOT `permit.read` and
 *      NOT `permit.manage`: those remain the permit ADMINISTRATION authority of
 *      `/permits/*`, `/permit-*` and `/safety-requirements/*`, which this router
 *      neither re-exposes nor weakens. Holding `permit.manage` alone does not
 *      open a field route, and holding a field permission alone opens no
 *      management route.
 *   3. `resolvePermitWorkFieldAuthority` in the service — the caller must be an
 *      ACTIVE Permit Worker of THIS permit (permit_workers → vendor_workforce_
 *      bindings → workforce_profiles.user_id = caller, all ACTIVE), the permit's
 *      Building must be accessible (BE-02G), and the Permit must not be
 *      CANCELLED. Gate 3 is asserted in the service because the Building is not
 *      in the path; it is never `requireBuildingAccess`.
 *
 * WHAT THIS ROUTER IS NOT
 * -----------------------
 * No permit create / edit / cancel, no application submit, no approval,
 * no validity, worker, equipment, safety-requirement or evidence route, no
 * HOLD / RESUME / CANCEL action, no current-shift gate and no task or work
 * order assignment marker. START and CLOSE call the existing BE-20K lifecycle
 * service; no lifecycle persistence is duplicated.
 */
export function createMobilePermitWorkRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission(PERMIT_WORK_FIELD_READ_PERMISSION);
  const execute = requirePermission(PERMIT_WORK_FIELD_EXECUTE_PERMISSION);

  router.get('/mobile/permit-work', auth, read, listMobilePermitWorkHandler);
  router.get(
    '/mobile/permit-work/:permitId',
    auth,
    read,
    getMobilePermitWorkFieldContextHandler,
  );
  router.post(
    '/mobile/permit-work/:permitId/start',
    auth,
    execute,
    startMobilePermitWorkHandler,
  );
  router.post(
    '/mobile/permit-work/:permitId/close',
    auth,
    execute,
    closeMobilePermitWorkHandler,
  );

  return router;
}
