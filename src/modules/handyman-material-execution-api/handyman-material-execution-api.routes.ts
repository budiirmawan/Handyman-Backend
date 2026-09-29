import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import {
  getProjectionHandler,
  postApproveHandler,
  postEstimateHandler,
  postIssueHandler,
  postPurchaseHandler,
  postReturnHandler,
  postSettleHandler,
  postUseHandler,
} from './handyman-material-execution-api.controller';

/**
 * CR-HM-09 PART 06 — material-execution HTTP surface:
 *
 *   POST   /handyman/execution-scopes/:executionScopeId/material-lines/estimate
 *   POST   /handyman/execution-scopes/:executionScopeId/material-lines/:lineId/approve
 *   POST   /handyman/execution-scopes/:executionScopeId/material-lines/:lineId/issue
 *   POST   /handyman/execution-scopes/:executionScopeId/material-lines/:lineId/purchase
 *   POST   /handyman/execution-scopes/:executionScopeId/material-lines/:lineId/use
 *   POST   /handyman/execution-scopes/:executionScopeId/material-lines/:lineId/return
 *   POST   /handyman/execution-scopes/:executionScopeId/material-lines/:lineId/settle
 *   GET    /handyman/execution-scopes/:executionScopeId/material-lines/final-charge-ready
 *
 * Authentication ONLY: any authenticated local session — Crew Leads
 * hold NO RBAC permissions; authority/locking/idempotency are
 * enforced EXCLUSIVELY by the PART 03–05 services (CURRENT
 * authoritative Crew Lead binding, Client access, frozen state
 * machine, frozen quantity invariants). No permission vocabulary is
 * invented and no caller-supplied identity field is trusted. NO
 * pricing/billing/payment/FM route ever exists here.
 */
export function createHandymanMaterialExecutionApiRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const base =
    '/handyman/execution-scopes/:executionScopeId/material-lines';
  router.post(`${base}/estimate`, auth, postEstimateHandler);
  router.get(`${base}/final-charge-ready`, auth, getProjectionHandler);
  router.post(`${base}/:lineId/approve`, auth, postApproveHandler);
  router.post(`${base}/:lineId/issue`, auth, postIssueHandler);
  router.post(`${base}/:lineId/purchase`, auth, postPurchaseHandler);
  router.post(`${base}/:lineId/use`, auth, postUseHandler);
  router.post(`${base}/:lineId/return`, auth, postReturnHandler);
  router.post(`${base}/:lineId/settle`, auth, postSettleHandler);
  return router;
}
