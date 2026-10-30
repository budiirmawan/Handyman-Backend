import { recordNeutralCareCommunication } from './handyman-care-communications.service';
import { Router } from 'express';
import { getPool } from '../../database';
import { sendSuccess } from '../../shared/api-response';
import { AppError } from '../../shared/errors';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { resolveBuildingCareAuthority, HANDYMAN_CARE_BUILDING_PERMISSION, NON_ACCEPTED_IDENTITY_FIELDS, assertNoSuppliedRecordingIdentity } from '../handyman-care-authority';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const param = (v: string | string[]) => Array.isArray(v) ? v[0] : v;

export function createHandymanCareCommunicationsRouter(): Router {
  const router = Router();
  const authz = [authenticationMiddleware, requirePermission(HANDYMAN_CARE_BUILDING_PERMISSION)];
  router.post('/handyman/care/buildings/:buildingId/requests/:requestId/communications', ...authz, async (req, res, next) => {
    const db = getPool();
    const c = await db.connect();
    let transactionOpen = false;
    try {
      assertNoSuppliedRecordingIdentity(NON_ACCEPTED_IDENTITY_FIELDS, [req.body as Record<string, unknown>]);
      const buildingId = param(req.params.buildingId);
      const requestId = param(req.params.requestId);
      if (!uuid.test(buildingId) || !uuid.test(requestId)) throw AppError.badRequest('Invalid Building or request id.');
      const authority = await resolveBuildingCareAuthority({ actorUserId: req.auth?.userId, buildingId });
      await c.query('BEGIN');
      transactionOpen = true;
      const request = await c.query(`SELECT id FROM handyman_service_requests WHERE id=$1 AND client_id=$2 AND building_id=$3`, [requestId, authority.scope.clientId, buildingId]);
      if (!request.rowCount) throw AppError.notFound('Handyman request not found.');
      const result = await recordNeutralCareCommunication(c, { clientId: authority.scope.clientId, buildingId, requestId },
        { userId: req.auth!.userId }, req.body);
      await c.query('COMMIT'); transactionOpen = false; sendSuccess(res, result, result.replayed ? 200 : 201);
    } catch (e) { if (transactionOpen) await c.query('ROLLBACK').catch(()=>undefined); next(e); } finally { c.release(); }
  });
  router.get('/handyman/care/buildings/:buildingId/requests/:requestId/communications', ...authz, async (req,res,next) => {
    try {
      const buildingId = param(req.params.buildingId);
      const requestId = param(req.params.requestId);
      if (!uuid.test(buildingId) || !uuid.test(requestId)) throw AppError.badRequest('Invalid Building or request id.');
      const authority = await resolveBuildingCareAuthority({ actorUserId: req.auth?.userId, buildingId });
      const parent = await getPool().query('SELECT id FROM handyman_service_requests WHERE id=$1 AND building_id=$2 AND client_id=$3', [requestId, buildingId, authority.scope.clientId]);
      if (!parent.rowCount) throw AppError.notFound('Handyman request not found.');
      const result = await getPool().query(`SELECT c.*, COALESCE(json_agg(e.evidence_submission_id) FILTER (WHERE e.evidence_submission_id IS NOT NULL),'[]') AS "evidenceIds" FROM handyman_care_communications c LEFT JOIN handyman_care_communication_evidence e ON e.communication_id=c.id WHERE c.handyman_request_id=$1 AND c.building_id=$2 AND c.client_id=$3 GROUP BY c.id ORDER BY c.recorded_at DESC`, [requestId,buildingId,authority.scope.clientId]);
      sendSuccess(res,result.rows);
    } catch(e) { next(e); }
  });
  return router;
}
