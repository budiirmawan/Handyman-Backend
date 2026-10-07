import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createRfqAwardHandler,
  createRfqRecommendationHandler,
  getRfqAwardHandler,
  getRfqRecommendationForRfqHandler,
  getRfqRecommendationHandler,
} from './rfq-recommendation.controller';

/**
 * CR-BE-PRO-02 PART 05 — internal recommendation and award surface. Approval
 * uses the existing `/procurement-approvals` authority; no Vendor session
 * route is mounted here.
 */
export function createRfqRecommendationRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('rfq.read');
  const manage = requirePermission('rfq.manage');
  const award = requirePermission('rfq.award');

  router.post('/rfqs/:rfqId/recommendations', auth, manage, createRfqRecommendationHandler);
  router.get('/rfqs/:rfqId/recommendations', auth, read, getRfqRecommendationForRfqHandler);
  router.get('/rfq-recommendations/:recommendationId', auth, read, getRfqRecommendationHandler);
  router.post('/rfq-recommendations/:recommendationId/award', auth, award, createRfqAwardHandler);
  router.get('/rfq-awards/:awardId', auth, read, getRfqAwardHandler);

  return router;
}
