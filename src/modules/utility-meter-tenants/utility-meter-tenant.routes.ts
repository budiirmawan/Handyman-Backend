import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  assignMeterToTenantHandler,
  endUtilityMeterTenantAssignmentHandler,
  getUtilityMeterTenantAssignmentHandler,
  listMeterTenantAssignmentsHandler,
  listSpaceMetersHandler,
  listTenantCompanyMetersHandler,
  resolveCurrentTenantAssignmentHandler,
  updateUtilityMeterTenantAssignmentHandler,
} from './utility-meter-tenant.controller';

/**
 * BE-18D — Tenant Meter endpoints.
 *
 * Reads (`utility_meter.read`):
 *   GET   /utility/meters/:id/tenant-assignments   (?status=) — meter history
 *   GET   /utility/meters/:id/tenant              → null when unassigned
 *   GET   /tenant-companies/:tenantCompanyId/utility-meters   (?status=)
 *   GET   /spaces/:spaceId/utility-meters                     (?status=)
 *   GET   /utility/meter-tenant-assignments/:id
 * Management (`utility_meter.manage`):
 *   POST  /utility/meters/:id/tenant-assignments
 *   PATCH /utility/meter-tenant-assignments/:id
 *   PATCH /utility/meter-tenant-assignments/:id/end
 *
 * The BE-18A `utility_meter.*` permissions are reused deliberately: a tenant
 * meter is a Meter with an assignment, not a separate domain, so it must not
 * introduce a parallel permission surface. Managing this binding is a meter
 * operation — it never grants tenant master data access, which stays behind
 * BE-14's own `tenant_company.*` permissions.
 *
 * Building access is asserted in the service against the Meter (or the
 * Space's resolved Building), so every route derives isolation from
 * authoritative records rather than a caller-supplied context.
 */
export function createUtilityMeterTenantRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const manage = requirePermission('utility_meter.manage');
  const read = requirePermission('utility_meter.read');

  router.post(
    '/utility/meters/:id/tenant-assignments',
    auth,
    manage,
    assignMeterToTenantHandler,
  );
  router.get(
    '/utility/meters/:id/tenant-assignments',
    auth,
    read,
    listMeterTenantAssignmentsHandler,
  );
  router.get(
    '/utility/meters/:id/tenant',
    auth,
    read,
    resolveCurrentTenantAssignmentHandler,
  );

  router.get(
    '/tenant-companies/:tenantCompanyId/utility-meters',
    auth,
    read,
    listTenantCompanyMetersHandler,
  );
  router.get('/spaces/:spaceId/utility-meters', auth, read, listSpaceMetersHandler);

  router.get(
    '/utility/meter-tenant-assignments/:id',
    auth,
    read,
    getUtilityMeterTenantAssignmentHandler,
  );
  router.patch(
    '/utility/meter-tenant-assignments/:id',
    auth,
    manage,
    updateUtilityMeterTenantAssignmentHandler,
  );
  router.patch(
    '/utility/meter-tenant-assignments/:id/end',
    auth,
    manage,
    endUtilityMeterTenantAssignmentHandler,
  );

  return router;
}
