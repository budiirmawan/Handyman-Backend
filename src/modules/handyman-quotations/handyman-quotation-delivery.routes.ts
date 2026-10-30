import { Router } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { AppError } from '../../shared/errors';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { listQuotationDelivery, recordQuotationDelivery, workspaceRecorder } from './handyman-quotation-delivery.service';

/** Care-only journal. Neither endpoint is a customer decision or a sender. */
export function createQuotationDeliveryRouter(): Router {
  const router = Router();
  const local = '/handyman/care/buildings/:buildingId/requests/:requestId/quotations/:quotationId/versions/:versionId/delivery-events';
  const workspace = '/handyman/care/requests/:requestId/quotations/:quotationId/versions/:versionId/delivery-events';
  const clean = (req: { query: unknown }) => {
    if (Object.keys(req.query as object).length) throw AppError.validation('Quotation delivery accepts no query parameters.');
  };
  const scope = (params: Record<string, string | string[]>) => ({
    buildingId: params.buildingId as string | undefined, requestId: params.requestId as string,
    quotationId: params.quotationId as string, versionId: params.versionId as string,
  });
  router.use([local, workspace], (_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next(); });
  const localAuth = [authenticationMiddleware, requirePermission('handyman.care.building')];
  router.post(local, ...localAuth, async (req, res, next) => {
    try {
      clean(req);
      const result = await recordQuotationDelivery({ userId: req.auth.userId }, scope(req.params), req.body);
      sendSuccess(res, result, result.replayed ? 200 : 201);
    } catch (error) { next(error); }
  });
  router.get(local, ...localAuth, async (req, res, next) => {
    try { clean(req); sendSuccess(res, await listQuotationDelivery({ userId: req.auth.userId }, scope(req.params))); }
    catch (error) { next(error); }
  });
  router.post(workspace, async (req, res, next) => {
    try {
      clean(req);
      const result = await recordQuotationDelivery(await workspaceRecorder(req.header('authorization')), scope(req.params), req.body);
      sendSuccess(res, result, result.replayed ? 200 : 201);
    } catch (error) { next(error); }
  });
  router.get(workspace, async (req, res, next) => {
    try { clean(req); sendSuccess(res, await listQuotationDelivery(await workspaceRecorder(req.header('authorization')), scope(req.params))); }
    catch (error) { next(error); }
  });
  return router;
}
