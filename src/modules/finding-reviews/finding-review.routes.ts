import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  getCurrentFindingReviewHandler,
  getFindingVerificationHandler,
  listFindingReviewsHandler,
  openFindingReviewHandler,
  submitFindingVerificationHandler,
} from './finding-review.controller';

export function createFindingReviewRouter(): Router {
  const router = Router();
  router.post('/findings/:id/reviews', authenticationMiddleware, requirePermission('finding.review'), openFindingReviewHandler);
  router.get('/findings/:id/reviews', authenticationMiddleware, requirePermission('finding.read'), listFindingReviewsHandler);
  router.get('/findings/:id/reviews/current', authenticationMiddleware, requirePermission('finding.read'), getCurrentFindingReviewHandler);
  router.get('/findings/:id/verification', authenticationMiddleware, requirePermission('finding.read'), getFindingVerificationHandler);
  router.post('/findings/:id/verification', authenticationMiddleware, requirePermission('finding.review'), submitFindingVerificationHandler);
  return router;
}
