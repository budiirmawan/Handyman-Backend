import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { getMobileUtilityMeterContextHandler } from './mobile-utility-meter-context.controller';

/**
 * CR-BE-RN12-METER-FIELD-01 PART 00 — mobile field meter context.
 *
 *   GET /mobile/utility-reading-dues/:readingDueId/meter-context
 *       utility_meter.field.read
 *
 * ROUTE SHAPE
 * -----------
 * Follows the established mobile convention `/mobile/<resource-plural>/:id/<sub-resource>`
 * — the same shape as `/mobile/tasks/:taskId/form-instance`,
 * `/mobile/assets/:assetId/operational-state` and RN-11's
 * `/mobile/work-orders/:workOrderId/material-items`. It is addressed by the
 * FIELD EXECUTION identity (the Reading Due), never by a bare meter id: several
 * OPEN dues may coexist for one meter, so a meter id alone cannot say which
 * execution the actor is standing in.
 *
 * AUTHORITY — THREE INDEPENDENT GATES
 * -----------------------------------
 *   1. `authenticationMiddleware`  — an authenticated session
 *   2. `utility_meter.field.read`  — a DEDICATED field permission. It is
 *      deliberately NOT `utility_meter.read`, NOT `utility_meter.manage`, and
 *      NOT either `meter_reading_binding.*`. Holding the management permission
 *      alone does not grant this route; the field permission is separately
 *      grantable and revocable, mirroring RN-11's `material_request.field.read`
 *      vs `material_request.manage` split.
 *   3. `assertUtilityMeterFieldActor` in the service — the actor must be the
 *      ACTIVE assignee (WORKFORCE profile or TEAM) of the due's generated task,
 *      the task must still target this Meter / Building / Client, and BE-02G
 *      Building access must hold.
 *
 * Gate 3 is the load-bearing one and is NOT `requireBuildingAccess`, because the
 * Building is not in the path: it is derived from the due's meter and asserted
 * in the service. Building access alone is insufficient, and no role name is
 * consulted anywhere.
 *
 * WHAT THIS ROUTE IS NOT
 * ----------------------
 * No management route is re-exposed. There is no reading POST, no evidence, no
 * OCR, no abnormality, no recheck, no `availableActions`, and no BE-25H sync
 * kind here — PART 00 is identity and authority only. The existing BE-10C
 * `METER_READING` sync kind and `meterReadingBindingService` are untouched.
 */
export function createMobileUtilityMeterContextRouter(): Router {
  const router = Router();

  router.get(
    '/mobile/utility-reading-dues/:readingDueId/meter-context',
    authenticationMiddleware,
    requirePermission('utility_meter.field.read'),
    getMobileUtilityMeterContextHandler,
  );

  return router;
}
