import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { getPool } from '../../database';
import { sendSuccess } from '../../shared/api-response';
import { AppError } from '../../shared/errors';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { resolveBuildingCareAuthority, HANDYMAN_CARE_BUILDING_PERMISSION, NON_ACCEPTED_IDENTITY_FIELDS, assertNoSuppliedRecordingIdentity } from '../handyman-care-authority';

const purposes = ['SERVICE_REQUEST_FOLLOW_UP','QUOTATION_RESPONSE_RECEIVED','VARIATION_RESPONSE_RECEIVED','BAST_CONFIRMATION_RECEIVED','PAYMENT_COMMUNICATION','WARRANTY_COMMUNICATION'];
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
      const { purpose, reportedContactName, reportedContactReference = null, channel, channelReference = null, statement, reportedStatement = null, idempotencyKey, evidenceIds = [] } = req.body ?? {};
      if (!purposes.includes(purpose) || typeof reportedContactName !== 'string' || !reportedContactName.trim() || !['PHONE','EMAIL','IN_PERSON','MESSAGING','OTHER'].includes(channel) || typeof statement !== 'string' || !statement.trim() || typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || !Array.isArray(evidenceIds) || evidenceIds.some((x: unknown) => typeof x !== 'string' || !uuid.test(x)) || ![null,'CONFIRM','REJECT','OTHER'].includes(reportedStatement)) throw AppError.badRequest('Invalid communication payload.');
      await c.query('BEGIN');
      transactionOpen = true;
      // Serialize equivalent actor/key commands; a concurrent replay observes the committed row.
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${req.auth!.userId}:${idempotencyKey}`]);
      const request = await c.query(`SELECT id, client_id, building_id FROM handyman_service_requests WHERE id=$1`, [requestId]);
      if (!request.rowCount || request.rows[0].client_id !== authority.scope.clientId || request.rows[0].building_id !== buildingId) throw AppError.notFound('Handyman request not found.');
      if (evidenceIds.length) {
        const evidence = await c.query(`SELECT id FROM evidence_submissions WHERE id = ANY($1::uuid[]) AND execution_type='HANDYMAN_REQUEST' AND execution_id=$2 AND client_id=$3 AND status='ACTIVE'`, [evidenceIds, requestId, authority.scope.clientId]);
        if (evidence.rowCount !== new Set(evidenceIds).size) throw AppError.badRequest('Evidence must be active request-owned evidence for this request.');
      }
      const prior = await c.query(`SELECT c.*, COALESCE((SELECT array_agg(e.evidence_submission_id ORDER BY e.evidence_submission_id) FROM handyman_care_communication_evidence e WHERE e.communication_id=c.id), ARRAY[]::uuid[]) AS evidence_ids FROM handyman_care_communications c WHERE recorded_by_user_id=$1 AND idempotency_key=$2`, [req.auth!.userId, idempotencyKey]);
      if (prior.rowCount) {
        const p = prior.rows[0];
        const requestedEvidence = [...new Set(evidenceIds)].sort();
        const savedEvidence = (p.evidence_ids as string[]).sort();
        const sameIntent = p.handyman_request_id === requestId && p.building_id === buildingId && p.purpose === purpose && p.reported_contact_name === reportedContactName.trim() && p.reported_contact_reference === reportedContactReference && p.channel === channel && p.channel_reference === channelReference && p.statement === statement.trim() && p.reported_statement === reportedStatement && JSON.stringify(savedEvidence) === JSON.stringify(requestedEvidence);
        if (!sameIntent) throw AppError.badRequest('Idempotency key was already used for a different communication.');
        await c.query('COMMIT'); transactionOpen = false; sendSuccess(res, { ...p, evidenceIds: p.evidence_ids, replayed: true }, 200); return;
      }
      const id = randomUUID();
      const inserted = await c.query(`INSERT INTO handyman_care_communications (id,client_id,building_id,handyman_request_id,purpose,reported_contact_name,reported_contact_reference,channel,channel_reference,statement,reported_statement,recorded_by_user_id,idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`, [id, authority.scope.clientId, buildingId, requestId, purpose, reportedContactName.trim(), reportedContactReference, channel, channelReference, statement.trim(), reportedStatement, req.auth!.userId, idempotencyKey]);
      for (const evidenceId of [...new Set(evidenceIds)] as string[]) await c.query('INSERT INTO handyman_care_communication_evidence (communication_id,evidence_submission_id) VALUES ($1,$2)', [id,evidenceId]);
      await c.query('COMMIT'); transactionOpen = false; sendSuccess(res, { ...inserted.rows[0], evidenceIds: [...new Set(evidenceIds)] }, 201);
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
