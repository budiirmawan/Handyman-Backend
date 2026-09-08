import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  getLatestVerificationHandler,
  getVerificationContextHandler,
  listVerificationHistoryHandler,
  listVerificationsHandler,
  openVerificationHandler,
  submitVerificationHandler,
} from './corrective-action-verification.controller';

/**
 * BE-21J — Corrective Action Verification routes.
 *
 * Modelled on BE-09F's finding-review routes: verification is a sub-resource
 * of the thing being verified, so it hangs off `/corrective-actions/:id`.
 *
 * The permission split is the substance of "the reviewer must be authorized":
 * `corrective_action_verification.read` sees the context, the result, and the
 * history; only `corrective_action_verification.manage` may open a
 * verification or record a decision. Holding `corrective_action.manage` — the
 * permission that lets someone DO the work — is deliberately NOT sufficient
 * to verify it, which is what keeps the two roles separable.
 *
 * The static `/verifications` collection is registered before the
 * `:id`-scoped routes so it is never shadowed.
 */
export function createCorrectiveActionVerificationRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('corrective_action_verification.read');
  const manage = requirePermission('corrective_action_verification.manage');

  router.get(
    '/corrective-action-verifications',
    auth,
    read,
    listVerificationsHandler,
  );

  // Context first: what the backend says about reviewability.
  router.get(
    '/corrective-actions/:id/verification',
    auth,
    read,
    getVerificationContextHandler,
  );
  // Opening claims the verification for the authenticated reviewer.
  router.post(
    '/corrective-actions/:id/verification',
    auth,
    manage,
    openVerificationHandler,
  );
  // The decision itself. POST to a distinct path so submitting can never be
  // confused with opening.
  router.post(
    '/corrective-actions/:id/verification/decision',
    auth,
    manage,
    submitVerificationHandler,
  );
  router.get(
    '/corrective-actions/:id/verification/latest',
    auth,
    read,
    getLatestVerificationHandler,
  );
  router.get(
    '/corrective-actions/:id/verification/history',
    auth,
    read,
    listVerificationHistoryHandler,
  );

  return router;
}
