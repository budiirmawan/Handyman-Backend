import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { requireBuildingAccess } from '../context-access';
import { createUtilityTariffHandler, listUtilityTariffsHandler } from './utility-tariff.controller';

/** CR-BE-UTL-01 PART 10 — Building-scoped Electricity / Water tariffs. */
export function createUtilityTariffRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  router.post('/buildings/:buildingId/utility-tariffs', auth,
    requirePermission('utility_meter.manage'), requireBuildingAccess('buildingId'),
    createUtilityTariffHandler);
  router.get('/buildings/:buildingId/utility-tariffs', auth,
    requirePermission('utility_meter.read'), requireBuildingAccess('buildingId'),
    listUtilityTariffsHandler);
  return router;
}
