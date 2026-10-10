import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { sendSuccess } from '../../shared/api-response';
import { AppError } from '../../shared/errors';
import {
  grantCareActorPermission,
  listCareActorPermissionGrants,
  revokeCareActorPermission,
} from './handyman-care-actor-permission.service';

/**
 * CR-HM-CUSTOMER-PAYMENT-REPORT-01 PART 06 — administrative provisioning of
 * care actor permission grants. Authority is RBAC (`permission.read` /
 * `permission.manage`) plus the service-level delegation and property scope
 * rules. No role name is consulted.
 *
 *   GET    /handyman/care-actors/:careActorId/permissions
 *   POST   /handyman/care-actors/:careActorId/permissions          { permissionCode }
 *   DELETE /handyman/care-actors/:careActorId/permissions/:permissionCode
 */
const BASE = '/handyman/care-actors/:careActorId/permissions';

function actorUserId(req: Request): string {
  if (!req.auth) throw AppError.validation('Authentication required.');
  return req.auth.userId;
}

function rejectUnknownBody(req: Request, allowed: readonly string[]): void {
  const body = req.body;
  if (body === undefined) return;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw AppError.validation('Request body must be a JSON object.');
  }
  const extra = Object.keys(body).filter((key) => !allowed.includes(key));
  if (extra.length) throw AppError.validation(`Unsupported fields: ${extra.join(', ')}.`);
}

export function createCareActorPermissionAdminRouter(): Router {
  const router = Router();

  router.get(
    BASE,
    authenticationMiddleware,
    requirePermission('permission.read'),
    async (req: Request, res: Response, next: NextFunction) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        if (Object.keys(req.query).length) throw AppError.validation('Query parameters are not accepted.');
        const grants = await listCareActorPermissionGrants(
          { careActorId: String(req.params.careActorId) },
          actorUserId(req),
        );
        sendSuccess(res, { grants });
      } catch (error) { next(error); }
    },
  );

  router.post(
    BASE,
    authenticationMiddleware,
    requirePermission('permission.manage'),
    async (req: Request, res: Response, next: NextFunction) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        if (Object.keys(req.query).length) throw AppError.validation('Query parameters are not accepted.');
        rejectUnknownBody(req, ['permissionCode']);
        const result = await grantCareActorPermission(
          { careActorId: String(req.params.careActorId), permissionCode: req.body?.permissionCode },
          actorUserId(req),
        );
        sendSuccess(res, { grant: result.grant, created: result.created }, result.created ? 201 : 200);
      } catch (error) { next(error); }
    },
  );

  router.delete(
    `${BASE}/:permissionCode`,
    authenticationMiddleware,
    requirePermission('permission.manage'),
    async (req: Request, res: Response, next: NextFunction) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        if (Object.keys(req.query).length) throw AppError.validation('Query parameters are not accepted.');
        if (req.body !== undefined && Object.keys(req.body ?? {}).length) {
          throw AppError.validation('Revoke does not accept a body.');
        }
        const grant = await revokeCareActorPermission(
          { careActorId: String(req.params.careActorId), permissionCode: String(req.params.permissionCode) },
          actorUserId(req),
        );
        sendSuccess(res, { grant });
      } catch (error) { next(error); }
    },
  );

  return router;
}
