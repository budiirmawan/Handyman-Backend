import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import {
  getDefectHandler,
  getDefectsByScopeHandler,
  getEvidenceByScopeHandler,
  getEvidenceRecordHandler,
  getQcRunHandler,
  getQcRunsByScopeHandler,
  postDefectOpenHandler,
  postDefectPassReinspectionHandler,
  postDefectRecordRectificationHandler,
  postDefectRequestReinspectionHandler,
  postDefectStartRectificationHandler,
  postEvidenceCreateHandler,
  postEvidenceFileAddHandler,
  postEvidenceFinalizeHandler,
  postQcFinishHandler,
  postQcItemSetHandler,
  postQcOpenHandler,
} from './handyman-evidence-qc-api.controller';

/**
 * CR-HM-10 PART 06 — evidence/QC/defect HTTP surface:
 *
 *   POST /handyman/execution-scopes/:executionScopeId/evidence
 *   GET  /handyman/execution-scopes/:executionScopeId/evidence
 *   POST /handyman/evidence-records/:evidenceRecordId/files
 *   POST /handyman/evidence-records/:evidenceRecordId/finalize
 *   GET  /handyman/evidence-records/:evidenceRecordId
 *   POST /handyman/execution-scopes/:executionScopeId/qc-runs
 *   GET  /handyman/execution-scopes/:executionScopeId/qc-runs
 *   POST /handyman/qc-runs/:qcRunId/items
 *   POST /handyman/qc-runs/:qcRunId/finish
 *   GET  /handyman/qc-runs/:qcRunId
 *   POST /handyman/execution-scopes/:executionScopeId/defects
 *   GET  /handyman/execution-scopes/:executionScopeId/defects
 *   POST /handyman/defects/:defectId/start-rectification
 *   POST /handyman/defects/:defectId/record-rectification
 *   POST /handyman/defects/:defectId/request-reinspection
 *   POST /handyman/defects/:defectId/pass-reinspection
 *   GET  /handyman/defects/:defectId
 *
 * Authentication ONLY: any authenticated local session — Crew Leads
 * hold NO RBAC permissions; authority/locking/idempotency/lifecycle
 * are enforced EXCLUSIVELY by the PART 03–05 services (CURRENT
 * authoritative Crew Lead binding, Client access, frozen ladders,
 * ONE-OPEN window, post-FINALIZE file lock). No permission
 * vocabulary is invented and no caller-supplied identity field is
 * trusted. ZERO pricing/billing/payment/FM route ever exists here.
 */
export function createHandymanEvidenceQcApiRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const read = requirePermission('tenant_company.read');
  const scopeEvidence =
    '/handyman/execution-scopes/:executionScopeId/evidence';
  const scopeQc =
    '/handyman/execution-scopes/:executionScopeId/qc-runs';
  const scopeDefects =
    '/handyman/execution-scopes/:executionScopeId/defects';
  const record = '/handyman/evidence-records/:evidenceRecordId';
  const run = '/handyman/qc-runs/:qcRunId';
  const defect = '/handyman/defects/:defectId';

  router.post(scopeEvidence, auth, postEvidenceCreateHandler);
  router.get(scopeEvidence, auth, read, getEvidenceByScopeHandler);
  router.post(`${record}/files`, auth, postEvidenceFileAddHandler);
  router.post(`${record}/finalize`, auth, postEvidenceFinalizeHandler);
  router.get(record, auth, read, getEvidenceRecordHandler);

  router.post(scopeQc, auth, postQcOpenHandler);
  router.get(scopeQc, auth, read, getQcRunsByScopeHandler);
  router.post(`${run}/items`, auth, postQcItemSetHandler);
  router.post(`${run}/finish`, auth, postQcFinishHandler);
  router.get(run, auth, read, getQcRunHandler);

  router.post(scopeDefects, auth, postDefectOpenHandler);
  router.get(scopeDefects, auth, read, getDefectsByScopeHandler);
  router.post(`${defect}/start-rectification`, auth,
    postDefectStartRectificationHandler);
  router.post(`${defect}/record-rectification`, auth,
    postDefectRecordRectificationHandler);
  router.post(`${defect}/request-reinspection`, auth,
    postDefectRequestReinspectionHandler);
  router.post(`${defect}/pass-reinspection`, auth,
    postDefectPassReinspectionHandler);
  router.get(defect, auth, read, getDefectHandler);
  return router;
}
