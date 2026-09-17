import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  assignHandymanJobHandler,
  createHandymanJobHandler,
  getHandymanJobHandler,
  listHandymanJobAssignmentsHandler,
  listHandymanJobsHandler,
  reassignHandymanJobHandler,
} from './handyman-job.controller';

/**
 * CR-HM-BE-05 RUN 3 — Handyman Job + assignment HTTP contract, registered
 * through the existing Asentra route composition (no separate
 * server/runtime). Every route requires an authenticated session; RBAC then
 * gates per route:
 *
 * - `handyman_job.manage`            → job creation
 * - `handyman_job.read`              → job list/get
 * - `handyman_job_assignment.manage` → first assignment + reassignment
 * - `handyman_job_assignment.read`   → append-only composition history
 *
 * There is deliberately NO generic PATCH /handyman-jobs (jobs have no
 * independent lifecycle — the bound Work Order owns execution state) and NO
 * Work Order lifecycle mutation is exposed through Handyman routes. Client
 * data scope, approval binding, idempotency, time-of-use eligibility and the
 * pre-execution reassignment guard remain service-authoritative (Run 1).
 */
export function createHandymanJobRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const jobRead = requirePermission('handyman_job.read');
  const assignmentRead = requirePermission('handyman_job_assignment.read');
  const assignmentManage = requirePermission('handyman_job_assignment.manage');

  router.post(
    '/handyman-jobs',
    auth,
    requirePermission('handyman_job.manage'),
    createHandymanJobHandler,
  );
  router.get('/handyman-jobs', auth, jobRead, listHandymanJobsHandler);
  router.get('/handyman-jobs/:jobId', auth, jobRead, getHandymanJobHandler);
  router.post(
    '/handyman-jobs/:jobId/assignment',
    auth,
    assignmentManage,
    assignHandymanJobHandler,
  );
  router.post(
    '/handyman-jobs/:jobId/assignment/reassign',
    auth,
    assignmentManage,
    reassignHandymanJobHandler,
  );
  router.get(
    '/handyman-jobs/:jobId/assignments',
    auth,
    assignmentRead,
    listHandymanJobAssignmentsHandler,
  );

  return router;
}
