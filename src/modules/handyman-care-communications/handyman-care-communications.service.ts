import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { AppError } from '../../shared/errors';
import { NON_ACCEPTED_IDENTITY_FIELDS, assertNoSuppliedRecordingIdentity } from '../handyman-care-authority';

const purposes = ['SERVICE_REQUEST_FOLLOW_UP','QUOTATION_RESPONSE_RECEIVED','VARIATION_RESPONSE_RECEIVED','BAST_CONFIRMATION_RECEIVED','PAYMENT_COMMUNICATION','WARRANTY_COMMUNICATION'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Recorder = { userId: string; careActorId?: never } | { careActorId: string; userId?: never };
const invalid = () => AppError.badRequest('Invalid communication payload.');
/** Existing neutral communication/evidence store, with explicit real recorder.
 * Always PENDING_VERIFICATION; neither this function nor an attachment grants
 * customer authority. Caller owns scope authorization and the transaction. */
export async function recordNeutralCareCommunication(tx: PoolClient,
  scope: { clientId: string; buildingId: string; requestId: string }, recorder: Recorder, body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid();
  const b = body as Record<string, unknown>;
  assertNoSuppliedRecordingIdentity(NON_ACCEPTED_IDENTITY_FIELDS, [b]);
  const { purpose, reportedContactName, reportedContactReference = null, channel, channelReference = null,
    statement, reportedStatement = null, idempotencyKey, evidenceIds = [] } = b;
  const text = (v: unknown, max: number) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max;
  if (Object.keys(b).some(k => !['purpose','reportedContactName','reportedContactReference','channel','channelReference','statement','reportedStatement','idempotencyKey','evidenceIds'].includes(k)) ||
      !purposes.includes(String(purpose)) || !text(reportedContactName, 200) ||
      ![null, 'CONFIRM', 'REJECT', 'OTHER'].includes(reportedStatement as any) ||
      !['PHONE','EMAIL','IN_PERSON','MESSAGING','OTHER'].includes(String(channel)) || !text(statement, 4000) || !text(idempotencyKey, 128) ||
      [reportedContactReference, channelReference].some(v => v !== null && (typeof v !== 'string' || v.length > 200)) ||
      !Array.isArray(evidenceIds) || evidenceIds.length > 100 || evidenceIds.some(v => typeof v !== 'string' || !uuid.test(v))) throw invalid();
  const column = recorder.careActorId ? 'recorded_by_care_actor_id' : 'recorded_by_user_id';
  const actorId = recorder.careActorId ?? recorder.userId;
  const key = (idempotencyKey as string).trim();
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${column}:${actorId}:${key}`]);
  const evidence = [...new Set(evidenceIds as string[])].sort();
  if (evidence.length) {
    const owned = await tx.query(`SELECT id FROM evidence_submissions WHERE id=ANY($1::uuid[]) AND execution_type='HANDYMAN_REQUEST'
      AND execution_id=$2 AND client_id=$3 AND status='ACTIVE' FOR SHARE`, [evidence, scope.requestId, scope.clientId]);
    if (owned.rowCount !== evidence.length) throw AppError.badRequest('Evidence must be active request-owned evidence for this request.');
  }
  const prior = await tx.query(`SELECT c.*, COALESCE((SELECT array_agg(evidence_submission_id ORDER BY evidence_submission_id)
    FROM handyman_care_communication_evidence WHERE communication_id=c.id), ARRAY[]::uuid[]) AS evidence_ids
    FROM handyman_care_communications c WHERE ${column}=$1 AND idempotency_key=$2`, [actorId, key]);
  if (prior.rows[0]) {
    const p = prior.rows[0];
    if (p.client_id !== scope.clientId || p.handyman_request_id !== scope.requestId || p.building_id !== scope.buildingId ||
        p.purpose !== purpose || p.reported_contact_name !== (reportedContactName as string).trim() || p.reported_contact_reference !== reportedContactReference ||
        p.channel !== channel || p.channel_reference !== channelReference || p.statement !== (statement as string).trim() ||
        p.reported_statement !== reportedStatement || JSON.stringify(p.evidence_ids) !== JSON.stringify(evidence)) {
      throw AppError.badRequest('Idempotency key was already used for a different communication.');
    }
    return { ...p, evidenceIds: p.evidence_ids, replayed: true };
  }
  const id = randomUUID();
  const inserted = await tx.query(`INSERT INTO handyman_care_communications
    (id,client_id,building_id,handyman_request_id,purpose,reported_contact_name,reported_contact_reference,channel,channel_reference,
      statement,reported_statement,${column},idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
  [id, scope.clientId, scope.buildingId, scope.requestId, purpose, (reportedContactName as string).trim(), reportedContactReference,
    channel, channelReference, (statement as string).trim(), reportedStatement, actorId, key]);
  for (const evidenceId of evidence) await tx.query('INSERT INTO handyman_care_communication_evidence(communication_id,evidence_submission_id) VALUES($1,$2)', [id,evidenceId]);
  return { ...inserted.rows[0], evidenceIds: evidence };
}
