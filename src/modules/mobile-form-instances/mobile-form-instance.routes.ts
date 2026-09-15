import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  finishMobileFormInstanceHandler,
  openMobileFormInstanceHandler,
  saveMobileFormResponsesHandler,
  startMobileFormInstanceHandler,
} from './mobile-form-instance.controller';

/**
 * MOB-C07 PART 02 / PART 03 / PART 04 — Mobile Form Instance open + execution.
 *
 *   POST /mobile/tasks/:taskId/form-instance
 *   POST /mobile/form-instances/:instanceId/start
 *   PUT  /mobile/form-instances/:instanceId/responses
 *   POST /mobile/form-instances/:instanceId/complete
 *   POST /mobile/form-instances/:instanceId/cancel
 *
 * Route gate is `form_instance.execute` only. Real authority is the
 * server-side chain in the service (bound instance → generated task →
 * FORM_VERSION → published version + ACTIVE parent + client match →
 * BE-02G Building → C04 assignment → current shift). Body-supplied ids
 * are never authority. Unbound instances (`generated_task_id` NULL) are
 * denied here and stay on the generic routes. Complete/cancel do not
 * mutate generated-task status.
 */
export function createMobileFormInstanceRouter(): Router {
  const router = Router();
  const execute = requirePermission('form_instance.execute');

  router.post(
    '/mobile/tasks/:taskId/form-instance',
    authenticationMiddleware,
    execute,
    openMobileFormInstanceHandler,
  );
  router.post(
    '/mobile/form-instances/:instanceId/start',
    authenticationMiddleware,
    execute,
    startMobileFormInstanceHandler,
  );
  router.put(
    '/mobile/form-instances/:instanceId/responses',
    authenticationMiddleware,
    execute,
    saveMobileFormResponsesHandler,
  );
  router.post(
    '/mobile/form-instances/:instanceId/complete',
    authenticationMiddleware,
    execute,
    finishMobileFormInstanceHandler,
  );
  router.post(
    '/mobile/form-instances/:instanceId/cancel',
    authenticationMiddleware,
    execute,
    finishMobileFormInstanceHandler,
  );

  return router;
}
