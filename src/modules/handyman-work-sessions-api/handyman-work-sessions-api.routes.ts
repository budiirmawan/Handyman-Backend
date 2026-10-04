import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  getHandymanWorkSessionActiveHandler,
  getHandymanWorkSessionsHandler,
  getHandymanWorkSessionTimeProjectionHandler,
  postHandymanWorkSessionCheckInHandler,
  postHandymanWorkSessionCheckOutHandler,
  postHandymanWorkSessionCompleteHandler,
  postHandymanWorkSessionMaterialRunHandler,
  postHandymanWorkSessionPauseHandler,
  postHandymanWorkSessionResumeHandler,
  postHandymanWorkSessionStartWorkHandler,
} from './handyman-work-sessions-api.controller';

/**
 * CR-HM-08 PART 05 — work-session HTTP surface:
 *
 *   POST   /handyman/execution-scopes/:executionScopeId/work-sessions/check-in
 *   POST   /handyman/work-sessions/:sessionId/start-work
 *   POST   /handyman/work-sessions/:sessionId/pause
 *   POST   /handyman/work-sessions/:sessionId/material-run
 *   POST   /handyman/work-sessions/:sessionId/resume
 *   POST   /handyman/work-sessions/:sessionId/complete
 *   POST   /handyman/work-sessions/:sessionId/check-out
 *   GET    /handyman/execution-scopes/:executionScopeId/work-sessions/active
 *   GET    /handyman/work-sessions/:sessionId/time-projection
 *
 * Authentication ONLY: any authenticated local session (Crew Leads
 * hold no RBAC permissions — eligibility/authority is enforced
 * EXCLUSIVELY by the PART 02–04 services: CURRENT authoritative
 * Crew Lead binding, Client access, frozen state machine). No
 * permission vocabulary is invented and no caller-supplied identity
 * field is trusted. NO billing/QC/BAST/payment/FM routes exist.
 */
export function createHandymanWorkSessionsApiRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('tenant_company.read');
  const base =
    '/handyman/execution-scopes/:executionScopeId/work-sessions';
  router.get(base, auth, read, getHandymanWorkSessionsHandler);
  router.post(`${base}/check-in`, auth,
    postHandymanWorkSessionCheckInHandler);
  const sessionBase = '/handyman/work-sessions/:sessionId';
  router.post(`${sessionBase}/start-work`, auth,
    postHandymanWorkSessionStartWorkHandler);
  router.post(`${sessionBase}/pause`, auth,
    postHandymanWorkSessionPauseHandler);
  router.post(`${sessionBase}/material-run`, auth,
    postHandymanWorkSessionMaterialRunHandler);
  router.post(`${sessionBase}/resume`, auth,
    postHandymanWorkSessionResumeHandler);
  router.post(`${sessionBase}/complete`, auth,
    postHandymanWorkSessionCompleteHandler);
  router.post(`${sessionBase}/check-out`, auth,
    postHandymanWorkSessionCheckOutHandler);
  router.get(`${base}/active`, auth,
    getHandymanWorkSessionActiveHandler);
  router.get('/handyman/work-sessions/:sessionId/time-projection',
    auth, getHandymanWorkSessionTimeProjectionHandler);
  return router;
}
