import { Router } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { AppError } from '../../shared/errors';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { linkInspectedWorkRequest, readInspectionWorkLink } from './handyman-inspection-work-link.service';

const param = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;

export function createHandymanInspectionWorkLinkRouter(): Router {
  const router = Router();
  const path = '/handyman/requests/:requestId/inspection-work-link';
  router.post(path, authenticationMiddleware, requirePermission('tenant_company.manage'), async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (Object.keys(req.query).length) throw AppError.validation('Query parameters are not supported.');
      const link = await linkInspectedWorkRequest(param(req.params.requestId), req.body, req.auth.userId);
      sendSuccess(res, link, link.replayed ? 200 : 201);
    } catch (error) { next(error); }
  });
  router.get(path, authenticationMiddleware, requirePermission('tenant_company.read'), async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (Object.keys(req.query).length) throw AppError.validation('Query parameters are not supported.');
      sendSuccess(res, await readInspectionWorkLink(param(req.params.requestId), req.auth.userId));
    } catch (error) { next(error); }
  });
  return router;
}
