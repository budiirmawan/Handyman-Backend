import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import {
  getHandymanWorkSessionActiveHandler,
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
 *   POST   /handyman/execution-scopes/:executionScopeId/work-sessions/start-work
 *   POST   /handyman/execution-scopes/:executionScopeId/work-sessions/pause
 *   POST   /handyman/execution-scopes/:executionScopeId/work-sessions/material-run
 *   POST   /handyman/execution-scopes/:executionScopeId/work-sessions/resume
 *   POST   /handyman/execution-scopes/:executionScopeId/work-sessions/complete
 *   POST   /handyman/execution-scopes/:executionScopeId/work-sessions/check-out
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
  const base =
    '/handyman/execution-scopes/:executionScopeId/work-sessions';
  router.post(`${base}/check-in`, auth,
    postHandymanWorkSessionCheckInHandler);
  router.post(`${base}/start-work`, auth,
    postHandymanWorkSessionStartWorkHandler);
  router.post(`${base}/pause`, auth,
    postHandymanWorkSessionPauseHandler);
  router.post(`${base}/material-run`, auth,
    postHandymanWorkSessionMaterialRunHandler);
  router.post(`${base}/resume`, auth,
    postHandymanWorkSessionResumeHandler);
  router.post(`${base}/complete`, auth,
    postHandymanWorkSessionCompleteHandler);
  router.post(`${base}/check-out`, auth,
    postHandymanWorkSessionCheckOutHandler);
  router.get(`${base}/active`, auth,
    getHandymanWorkSessionActiveHandler);
  router.get('/handyman/work-sessions/:sessionId/time-projection',
    auth, getHandymanWorkSessionTimeProjectionHandler);
  return router;
}
