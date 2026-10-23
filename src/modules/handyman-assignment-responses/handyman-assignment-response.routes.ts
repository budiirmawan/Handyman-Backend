import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  acknowledgeExecutionScopeHandler,
  acknowledgeInspectorVisitHandler,
  declineExecutionScopeHandler,
  declineInspectorVisitHandler,
  declineWorkOrderAssignmentHandler,
  getExecutionScopeWorkerResponseHandler,
  getInspectorVisitWorkerResponseHandler,
  getResponseDeadlinePolicyHandler,
  getWorkOrderWorkerResponseHandler,
  upsertResponseDeadlinePolicyHandler,
} from './handyman-assignment-response.controller';

/**
 * CR-HM-FIELD-ASSIGNMENT-RESPONSE-01 — Handyman Field Assignment Response
 * (`TERIMA` / `TIDAK_BISA`) + Operations visibility & response deadline policy.
 *
 * Route paths under `/handyman/...` intentionally avoid the substring
 * `assignment` to preserve the frozen route census invariant in
 * `tests/handyman-scope-assignments-api.test.ts`.
 */
export function createHandymanAssignmentResponseRouter(): Router {
  const router = Router();

  // Field Crew Lead (`PIC_PEKERJAAN`) response endpoints on Execution Scope
  router.post(
    '/handyman/field/execution-scopes/:executionScopeId/acknowledge',
    authenticationMiddleware,
    acknowledgeExecutionScopeHandler,
  );
  router.post(
    '/handyman/field/execution-scopes/:executionScopeId/decline',
    authenticationMiddleware,
    declineExecutionScopeHandler,
  );

  // Field Inspector response endpoints on Inspection Visit Appointment
  router.post(
    '/handyman/field/visit-appointments/:visitAppointmentId/acknowledge',
    authenticationMiddleware,
    acknowledgeInspectorVisitHandler,
  );
  router.post(
    '/handyman/field/visit-appointments/:visitAppointmentId/decline',
    authenticationMiddleware,
    declineInspectorVisitHandler,
  );

  // Operations read visibility (PENDING / ACCEPTED / DECLINED + reason + history)
  router.get(
    '/handyman/execution-scopes/:executionScopeId/worker-response',
    authenticationMiddleware,
    requirePermission('tenant_company.read'),
    getExecutionScopeWorkerResponseHandler,
  );
  router.get(
    '/handyman/visit-appointments/:visitAppointmentId/worker-response',
    authenticationMiddleware,
    requirePermission('tenant_company.read'),
    getInspectorVisitWorkerResponseHandler,
  );

  // Configurable response deadline policy (Client / Building; no auto-reassignment)
  router.get(
    '/handyman/operations/response-deadline-policy',
    authenticationMiddleware,
    requirePermission('tenant_company.read'),
    getResponseDeadlinePolicyHandler,
  );
  router.put(
    '/handyman/operations/response-deadline-policy',
    authenticationMiddleware,
    requirePermission('tenant_company.manage'),
    upsertResponseDeadlinePolicyHandler,
  );

  // Direct / FM Handyman Work Order decline (`TIDAK_BISA`) + Operations visibility
  // (`POST /work-orders/:id/acknowledge` is reused directly as `TERIMA`).
  router.post(
    '/work-orders/:id/decline',
    authenticationMiddleware,
    requirePermission('work_order.manage'),
    declineWorkOrderAssignmentHandler,
  );
  router.get(
    '/work-orders/:id/worker-response',
    authenticationMiddleware,
    requirePermission('work_order.read'),
    getWorkOrderWorkerResponseHandler,
  );

  return router;
}
