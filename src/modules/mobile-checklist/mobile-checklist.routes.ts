import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  createMobileChecklistFindingHandler,
  finishMobileChecklistExecutionHandler,
  getMobileChecklistExecutionHandler,
  openMobileChecklistExecutionHandler,
  saveMobileChecklistResponsesHandler,
  startMobileChecklistExecutionHandler,
} from './mobile-checklist.controller';

/**
 * BE-25D / MOB-C04 PART 02 — Mobile Checklist Contract.
 *
 *   GET  /mobile/checklist-executions/:executionId                  (read)
 *   POST /mobile/checklist-executions/:executionId/start            (execute)
 *   PUT  /mobile/checklist-executions/:executionId/responses        (execute)
 *   POST /mobile/checklist-executions/:executionId/complete         (execute)
 *   POST /mobile/checklist-executions/:executionId/cancel           (execute)
 *
 * The read model (BE-25D) is unchanged. The execution commands (MOB-C04
 * PART 02) run through the SAME shared checklist-execution service as the
 * generic REST endpoints (no separate mobile checklist engine) AND are gated
 * by the authoritative current-shift Building authority in the service — a
 * checklist may only be executed by a user currently on shift at the Building
 * its work belongs to. Mutation requires `checklist.manage` (the existing
 * execution authority); reads require `checklist.read`.
 */
export function createMobileChecklistRouter(): Router {
  const router = Router();
  const read = requirePermission('checklist.read');
  const manage = requirePermission('checklist.manage');

  router.get(
    '/mobile/checklist-executions/:executionId',
    authenticationMiddleware,
    read,
    getMobileChecklistExecutionHandler,
  );

  router.post(
    '/mobile/checklist-executions/:executionId/start',
    authenticationMiddleware,
    manage,
    startMobileChecklistExecutionHandler,
  );

  router.put(
    '/mobile/checklist-executions/:executionId/responses',
    authenticationMiddleware,
    manage,
    saveMobileChecklistResponsesHandler,
  );

  router.post(
    '/mobile/checklist-executions/:executionId/complete',
    authenticationMiddleware,
    manage,
    finishMobileChecklistExecutionHandler,
  );

  router.post(
    '/mobile/checklist-executions/:executionId/cancel',
    authenticationMiddleware,
    manage,
    finishMobileChecklistExecutionHandler,
  );

  // MOB-C05 PART 03 — Report a Finding from an authoritative bound checklist
  // execution. Route gate reuses the existing execution-domain permission
  // (`checklist.manage`, the same gate the other mobile checklist mutations
  // use) — it is NOT finding.manage and NOT a new finding.report permission.
  // Real authority is the server-side chain in the service (BE-02G scope →
  // ACTIVE task assignment → current shift in the exact Building) plus the
  // PART 01 authoritative source context. Body is title + optional
  // description only; the Finding number is generated server-side.
  router.post(
    '/mobile/checklist-executions/:executionId/finding',
    authenticationMiddleware,
    manage,
    createMobileChecklistFindingHandler,
  );

  // MOB-C04 PART 02B — Open (get-or-create) the bound checklist execution for
  // an assigned, current-shift generated task (task id is the authoritative
  // mobile-assignment feed `reference.taskId` for TASK items). Authority is
  // derived server-side from the generated task.
  router.post(
    '/mobile/tasks/:taskId/checklist-execution',
    authenticationMiddleware,
    manage,
    openMobileChecklistExecutionHandler,
  );

  return router;
}
