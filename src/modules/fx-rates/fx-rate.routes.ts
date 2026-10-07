import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  approveFxRateHandler,
  createFxRateHandler,
  deactivateFxRateHandler,
  getClientFxPolicyHandler,
  getFxRateHandler,
  listFxRateEventsHandler,
  listFxRatesHandler,
  rejectFxRateHandler,
  setClientFxPolicyHandler,
  supersedeFxRateHandler,
} from './fx-rate.controller';

/**
 * CR-BE-FX-01 PART 02 — FX Rate lifecycle and Client FX Policy routes.
 *
 * GOVERNANCE: docs/CR-BE-FX-01_START_GOVERNANCE.md §15, §17, §18.
 *
 * RBAC (existing architecture, no new roles):
 *   fx_rate.read          — read rates and their audit trail
 *   fx_rate.manage        — PROPOSE a rate (maker). Cannot activate it.
 *   fx_rate.approve       — approve / reject / supersede / deactivate (checker).
 *                           Withheld from PLATFORM_ADMIN by
 *                           UNASSIGNED_BY_DEFAULT_PERMISSION_CODES.
 *   client_fx_policy.read / client_fx_policy.manage
 *                         — Client-scoped policy; Client reachability is
 *                           enforced inside the service.
 *
 * Note the deliberate split: `fx_rate.manage` alone can create a PENDING_APPROVAL
 * rate but nothing else. A caller holding only `fx_rate.manage` can never make a
 * rate usable, which is what makes the maker-checker rule enforceable rather
 * than advisory.
 *
 * NOT exposed here (by design): conversion, quoting, reporting conversion,
 * provider ingestion, and any FX dashboard.
 */
export function createFxRateRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;

  const read = requirePermission('fx_rate.read');
  const manage = requirePermission('fx_rate.manage');
  const approve = requirePermission('fx_rate.approve');
  const policyRead = requirePermission('client_fx_policy.read');
  const policyManage = requirePermission('client_fx_policy.manage');

  // ---- platform-global FX rate authority ---------------------------------
  router.get('/fx-rates', auth, read, listFxRatesHandler);
  router.post('/fx-rates', auth, manage, createFxRateHandler);
  router.get('/fx-rates/:rateId', auth, read, getFxRateHandler);
  router.get('/fx-rates/:rateId/events', auth, read, listFxRateEventsHandler);

  // ---- governed lifecycle (checker authority) -----------------------------
  router.post('/fx-rates/:rateId/approve', auth, approve, approveFxRateHandler);
  router.post('/fx-rates/:rateId/reject', auth, approve, rejectFxRateHandler);
  router.post('/fx-rates/:rateId/supersede', auth, approve, supersedeFxRateHandler);
  router.post('/fx-rates/:rateId/deactivate', auth, approve, deactivateFxRateHandler);

  // ---- Client-scoped FX policy --------------------------------------------
  router.get('/clients/:clientId/fx-policy', auth, policyRead, getClientFxPolicyHandler);
  router.put('/clients/:clientId/fx-policy', auth, policyManage, setClientFxPolicyHandler);

  return router;
}
