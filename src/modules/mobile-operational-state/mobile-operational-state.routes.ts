import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { getMobileAssetOperationalStateHandler } from './mobile-operational-state.controller';

/**
 * CR-BE-RN10-SAFE-EQUIPMENT-01 PART 04 — mobile RN-10 operational-state read.
 *
 *   GET /mobile/assets/:assetId/operational-state
 *
 * This router exposes EXACTLY ONE operation, and it is a read.
 *
 * PERMISSION — `asset_operational_state.read`, a dedicated code (PART 04)
 * rather than a reuse of `asset.read`: reading whether equipment may be used
 * is ordinarily an Asset read, but the mobile RN-10 surface additionally
 * returns the CALLER-SPECIFIC `availableActions` snapshot, which is a
 * capability disclosure about the caller's own safety authorities, not
 * generic Asset data. A dedicated code keeps the mobile operational
 * capability grantable, auditable, and revocable on its own — the same
 * governance rationale the PART 01 `asset_failure.report` and PART 02
 * `asset_operational_state.manage` codes follow. No technician / BM /
 * Supervisor role name appears in this authority logic: application roles
 * are provisioned to the code by policy/configuration, exactly like every
 * other permission in this repository.
 *
 * BUILDING ISOLATION is NOT `requireBuildingAccess` because the Building is
 * not in the path: it is derived from the Asset, so the service asserts the
 * caller's Building access after resolving the Asset — the same posture the
 * PART 02 `/assets/:assetId/operational-state` handlers and the PART 01
 * mobile unsafe-condition command take.
 *
 * NO MUTATION ROUTE EXISTS in this PART. There is deliberately no
 * `/mobile/assets/:assetId/out-of-service`, no `/isolate`, no `/shutdown`,
 * and no `/return-to-service` here: the canonical mutations
 * (`PATCH /assets/:assetId/operational-state` and
 * `POST /assets/:assetId/operational-state/return-to-service`) are the only
 * doors onto safety state, and the mobile `availableActions` tokens point at
 * them. QR (`targetType = ASSET`) remains identity resolution only and
 * carries no RN-10 token — a QR match is never mutation authority.
 */
export function createMobileOperationalStateRouter(): Router {
  const router = Router();

  router.get(
    '/mobile/assets/:assetId/operational-state',
    authenticationMiddleware,
    requirePermission('asset_operational_state.read'),
    getMobileAssetOperationalStateHandler,
  );

  return router;
}
