import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import {
  authenticationRequiredError,
  permissionDeniedError,
} from '../auth/auth.errors';
import { permissionService } from '../permissions';
import { logger } from '../../shared/logger';
import {
  findHandymanEvidenceQcReadScopeId,
  isCurrentHandymanCrewLeadForScope,
} from '../handyman-evidence-qc/handyman-evidence-qc.service';
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
 * WRITES: authentication only — Crew Leads hold NO RBAC permissions;
 * authority/locking/idempotency/lifecycle are enforced EXCLUSIVELY by
 * the PART 03–05 services (CURRENT authoritative Crew Lead binding,
 * building scope, frozen ladders, ONE-OPEN window, post-FINALIZE file
 * lock).
 *
 * READS (W01 PART 03): `tenant_company.read` OR the CURRENT Crew Lead of
 * the owning execution scope — see requireEvidenceQcReadAuthority below.
 * Non-Lead users without the permission are denied as before.
 * No permission vocabulary is invented and no caller-supplied identity
 * field is trusted. ZERO pricing/billing/payment/FM route ever exists here.
 */
/**
 * W01 PART 03 — read authority for the GET surface. Two admissible paths,
 * both evaluated per execution scope:
 *   1. ADMINISTRATIVE: `tenant_company.read` (unchanged contract); the
 *      service-layer BE-02G building guard still applies.
 *   2. CURRENT CREW LEAD of the owning scope (its resolver enforces the
 *      ACTIVE building assignment). Crew Leads hold no RBAC permission.
 * Anyone else, including a Lead of a different scope and malformed or
 * unknown ids, gets the same PERMISSION_DENIED (no existence leak).
 */
const TENANT_READ_PERMISSION = 'tenant_company.read';

type ReadScopeResolver = (req: Request) => Promise<string | null>;

function requireEvidenceQcReadAuthority(resolveScopeId: ReadScopeResolver) {
  return async function evidenceQcReadAuthority(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      if (!req.auth) throw authenticationRequiredError();
      const userId = req.auth.userId;
      const permissions = await permissionService.resolvePermissionsForUser(
        userId,
      );
      if (permissions.includes(TENANT_READ_PERMISSION)) {
        next();
        return;
      }
      const scopeId = await resolveScopeId(req);
      if (scopeId && await isCurrentHandymanCrewLeadForScope(scopeId, userId)) {
        next();
        return;
      }
      logger.warn('Permission denied', {
        requestId: req.requestId,
        userId,
        requiredPermission: TENANT_READ_PERMISSION,
        path: req.path,
        method: req.method,
        result: 'denied',
      });
      next(permissionDeniedError());
    } catch (error) {
      next(error);
    }
  };
}

const paramScope =
  (name: string): ReadScopeResolver =>
    async (req) => {
      const value = req.params[name];
      return typeof value === 'string' ? value : null;
    };

const targetScope = (
  kind: 'record' | 'run' | 'defect',
  name: string,
): ReadScopeResolver =>
  async (req) => {
    const value = req.params[name];
    if (typeof value !== 'string') return null;
    return findHandymanEvidenceQcReadScopeId({ kind, id: value });
  };

export function createHandymanEvidenceQcApiRouter(): Router {
  const router = Router();
  const auth = authenticationMiddleware;
  const readScope = requireEvidenceQcReadAuthority(
    paramScope('executionScopeId'));
  const readRecord = requireEvidenceQcReadAuthority(
    targetScope('record', 'evidenceRecordId'));
  const readRun = requireEvidenceQcReadAuthority(
    targetScope('run', 'qcRunId'));
  const readDefect = requireEvidenceQcReadAuthority(
    targetScope('defect', 'defectId'));
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
  router.get(scopeEvidence, auth, readScope, getEvidenceByScopeHandler);
  router.post(`${record}/files`, auth, postEvidenceFileAddHandler);
  router.post(`${record}/finalize`, auth, postEvidenceFinalizeHandler);
  router.get(record, auth, readRecord, getEvidenceRecordHandler);

  router.post(scopeQc, auth, postQcOpenHandler);
  router.get(scopeQc, auth, readScope, getQcRunsByScopeHandler);
  router.post(`${run}/items`, auth, postQcItemSetHandler);
  router.post(`${run}/finish`, auth, postQcFinishHandler);
  router.get(run, auth, readRun, getQcRunHandler);

  router.post(scopeDefects, auth, postDefectOpenHandler);
  router.get(scopeDefects, auth, readScope, getDefectsByScopeHandler);
  router.post(`${defect}/start-rectification`, auth,
    postDefectStartRectificationHandler);
  router.post(`${defect}/record-rectification`, auth,
    postDefectRecordRectificationHandler);
  router.post(`${defect}/request-reinspection`, auth,
    postDefectRequestReinspectionHandler);
  router.post(`${defect}/pass-reinspection`, auth,
    postDefectPassReinspectionHandler);
  router.get(defect, auth, readDefect, getDefectHandler);
  return router;
}
