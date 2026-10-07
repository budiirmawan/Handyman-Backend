import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  getAssetOperationalStateHandler,
  returnAssetToServiceHandler,
  transitionAssetOperationalStateHandler,
} from './asset-operational-state.controller';

/**
 * CR-BE-RN10-SAFE-EQUIPMENT-01 PART 02 — Asset operational-state routes.
 *
 * Reads (`asset.read`):
 *   GET   /assets/:assetId/operational-state
 * Management (`asset_operational_state.manage`):
 *   PATCH /assets/:assetId/operational-state
 * Governed return to service (`asset_operational_state.return_to_service`):
 *   POST  /assets/:assetId/operational-state/return-to-service
 *
 * PERMISSION CHOICE — a DEDICATED management code, not `asset.manage`.
 * Taking equipment out of service, isolating it, or shutting it down is a
 * safety decision, not Asset master-data administration. Reusing `asset.manage`
 * would grant every asset administrator the authority to declare equipment
 * unsafe, and would make the two capabilities impossible to separate in review
 * or revoke independently. `asset_operational_state.manage` is therefore its
 * own code. Reading the state needs no new capability — knowing whether
 * equipment is available is an Asset read.
 *
 * NO technician/mobile permission exists in this PART (§15): there is no
 * mobile mutation endpoint here, and no `availableActions` token. PART 04 owns
 * caller-specific mobile authority.
 *
 * Building isolation is asserted in the controller (no `buildingId` in the
 * path), exactly like the neighbouring `/assets/:id/status` routes.
 *
 * PART 03 adds the third operation — the governed RETURN_TO_SERVICE — under
 * its OWN dedicated permission. Taking equipment out of service and putting it
 * back are separate authorities: returning an Asset to service asserts that the
 * hazard is cleared, so it requires `asset_operational_state.return_to_service`
 * and neither `asset_operational_state.manage`, nor `asset.manage`, nor any
 * `asset_failure.*` code can substitute for it. The command is a distinct route
 * rather than a state value on the PATCH precisely so that this authority
 * boundary is enforced by routing and RBAC, and so the PATCH DTO can keep
 * refusing `IN_SERVICE` outright.
 *
 * Still deliberately absent: no evidence attachment, no Finding or Work Order
 * coupling, and no mobile mutation endpoint or `availableActions` token (PART 04
 * owns caller-specific mobile authority).
 */
export function createAssetOperationalStateRouter(): Router {
  const router = Router();

  router.get(
    '/assets/:assetId/operational-state',
    authenticationMiddleware,
    requirePermission('asset.read'),
    getAssetOperationalStateHandler,
  );
  router.patch(
    '/assets/:assetId/operational-state',
    authenticationMiddleware,
    requirePermission('asset_operational_state.manage'),
    transitionAssetOperationalStateHandler,
  );
  router.post(
    '/assets/:assetId/operational-state/return-to-service',
    authenticationMiddleware,
    requirePermission('asset_operational_state.return_to_service'),
    returnAssetToServiceHandler,
  );

  return router;
}
