import { Router } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { AppError } from '../../shared/errors';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { workspaceRecorder } from '../handyman-quotations/handyman-quotation-delivery.service';
import { listVariationDelivery, recordVariationDelivery } from './handyman-variation-delivery.service';

/** Only a Care journal: these endpoints neither send a PDF nor approve work. */
export function createVariationDeliveryRouter(): Router {
  const router = Router();
  const suffix = '/requests/:requestId/variations/:variationId/offers/:offerDocumentId/versions/:offerVersion/delivery-events';
  const local = `/handyman/care/buildings/:buildingId${suffix}`;
  const workspace = `/handyman/care${suffix}`;
  const clean = (req: { query: unknown }) => {
    if (Object.keys(req.query as object).length) throw AppError.validation('Variation delivery accepts no query parameters.');
  };
  const scope = (params: Record<string, string | string[]>) => ({
    buildingId: params.buildingId as string | undefined, requestId: params.requestId as string,
    variationId: params.variationId as string, offerDocumentId: params.offerDocumentId as string, offerVersion: params.offerVersion as string,
  });
  router.use([local, workspace], (_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next(); });
  const localAuth = [authenticationMiddleware, requirePermission('handyman.care.building')];
  router.post(local, ...localAuth, async (req, res, next) => {
    try {
      clean(req);
      const result = await recordVariationDelivery({ userId: req.auth.userId }, scope(req.params), req.body);
      sendSuccess(res, result, result.replayed ? 200 : 201);
    } catch (error) { next(error); }
  });
  router.get(local, ...localAuth, async (req, res, next) => {
    try { clean(req); sendSuccess(res, await listVariationDelivery({ userId: req.auth.userId }, scope(req.params))); }
    catch (error) { next(error); }
  });
  router.post(workspace, async (req, res, next) => {
    try {
      clean(req);
      const result = await recordVariationDelivery(await workspaceRecorder(req.header('authorization')), scope(req.params), req.body);
      sendSuccess(res, result, result.replayed ? 200 : 201);
    } catch (error) { next(error); }
  });
  router.get(workspace, async (req, res, next) => {
    try { clean(req); sendSuccess(res, await listVariationDelivery(await workspaceRecorder(req.header('authorization')), scope(req.params))); }
    catch (error) { next(error); }
  });
  return router;
}
