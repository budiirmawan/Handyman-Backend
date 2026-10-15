import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  HANDYMAN_BAST_MANAGE_PERMISSION,
} from './handyman-bast-worker-authority';
import {
  postWorkerBastIssueHandler,
  postWorkerBastPrepareHandler,
  postWorkerBastVoidHandler,
} from './handyman-bast-worker-api.controller';

/**
 * CR-HM-BAST-HTTP-01 — Authorized Worker BAST transport:
 *
 *   POST /handyman/field/execution-scopes/:executionScopeId/bast/prepare
 *   POST /handyman/field/bast/:bastId/issue
 *   POST /handyman/field/bast/:bastId/void
 *
 * Every route: authentication + the dedicated `handyman.bast.manage`
 * capability (migration 0446, granted to NO role by default), then the
 * service-side worker-lane preamble (exact BE-02G Building access + CURRENT
 * authoritative Crew Lead binding). Commands delegate to the frozen
 * CR-HM-11 PART 01 services only — PREPARE creates a DRAFT anchored to the
 * latest guarded Supervisor QC PASS, ISSUE records issuance (never customer
 * acceptance), VOID records an audited void with a required reason.
 *
 * Customer ACCEPT/REJECT/sign-off stays on the Customer Care transport
 * (`handyman-bast-api`, `tenant_company.manage`); this router exposes NO
 * accept/reject/sign-off route and NO financial state write.
 */
export function createHandymanBastWorkerApiRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const workerBast = requirePermission(HANDYMAN_BAST_MANAGE_PERMISSION);

  router.post(
    '/handyman/field/execution-scopes/:executionScopeId/bast/prepare',
    auth,
    workerBast,
    postWorkerBastPrepareHandler,
  );
  router.post(
    '/handyman/field/bast/:bastId/issue',
    auth,
    workerBast,
    postWorkerBastIssueHandler,
  );
  router.post(
    '/handyman/field/bast/:bastId/void',
    auth,
    workerBast,
    postWorkerBastVoidHandler,
  );

  return router;
}
