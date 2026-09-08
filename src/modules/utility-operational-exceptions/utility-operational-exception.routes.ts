import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  cancelUtilityException,
  createUtilityException,
  getUtilityException,
  listUtilityExceptions,
  resolveUtilityException,
  startUtilityExceptionReview,
} from './utility-operational-exception.controller';
export function createUtilityOperationalExceptionRouter() {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('utility_meter.read');
  const manage = requirePermission('utility_meter.manage');
  router.post('/utility/exceptions', auth, manage, createUtilityException);
  router.get('/utility/exceptions', auth, read, listUtilityExceptions);
  router.post('/utility/exceptions/:id/start-review', auth, manage, startUtilityExceptionReview);
  router.post('/utility/exceptions/:id/resolve', auth, manage, resolveUtilityException);
  router.post('/utility/exceptions/:id/cancel', auth, manage, cancelUtilityException);
  router.get('/utility/exceptions/:id', auth, read, getUtilityException);
  return router;
}
