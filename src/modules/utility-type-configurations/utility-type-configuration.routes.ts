import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  addUtilityTypeUomHandler,
  createUtilityTypeConfigurationHandler,
  getUtilityTypeConfigurationHandler,
  listUtilityTypeConfigurationsHandler,
  updateUtilityTypeConfigurationHandler,
  updateUtilityTypeConfigurationStatusHandler,
  updateUtilityTypeUomHandler,
} from './utility-type-configuration.controller';

/**
 * BE-18B — Electricity / Water / Gas configuration endpoints.
 *
 * Reads (`utility_meter.read`):
 *   GET   /clients/:clientId/utility-type-configurations  (?utilityType= &status=)
 *   GET   /utility/type-configurations/:id
 * Management (`utility_meter.manage`):
 *   POST  /clients/:clientId/utility-type-configurations
 *   PATCH /utility/type-configurations/:id
 *   PATCH /utility/type-configurations/:id/status
 *   POST  /utility/type-configurations/:id/uoms
 *   PATCH /utility/type-configurations/:id/uoms/:uomId
 *
 * The BE-18A `utility_meter.*` permissions are reused deliberately: utility
 * type configuration is Meter master reference data, not a separate domain,
 * so it must not introduce a parallel permission surface.
 *
 * Client isolation is enforced in the service through
 * `contextAccessService.canAccessClient` (derived from explicit BE-02G
 * Building assignments), matching the BE-18A client-scoped routes.
 */
export function createUtilityTypeConfigurationRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('utility_meter.manage');
  const read = requirePermission('utility_meter.read');

  router.post(
    '/clients/:clientId/utility-type-configurations',
    auth,
    manage,
    createUtilityTypeConfigurationHandler,
  );
  router.get(
    '/clients/:clientId/utility-type-configurations',
    auth,
    read,
    listUtilityTypeConfigurationsHandler,
  );
  router.get(
    '/utility/type-configurations/:id',
    auth,
    read,
    getUtilityTypeConfigurationHandler,
  );
  router.patch(
    '/utility/type-configurations/:id',
    auth,
    manage,
    updateUtilityTypeConfigurationHandler,
  );
  router.patch(
    '/utility/type-configurations/:id/status',
    auth,
    manage,
    updateUtilityTypeConfigurationStatusHandler,
  );
  router.post(
    '/utility/type-configurations/:id/uoms',
    auth,
    manage,
    addUtilityTypeUomHandler,
  );
  router.patch(
    '/utility/type-configurations/:id/uoms/:uomId',
    auth,
    manage,
    updateUtilityTypeUomHandler,
  );

  return router;
}
