import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { AppError } from '../../shared/errors';
import { stableJson } from '../../shared/stable-json';
import { isValidUuid } from '../clients';
import {
  authorizeCareDelivery, parseCareDeliveryCommand, recheckCareDeliveryWorkspace, verifyCareDeliveryEvidence,
  type CareDeliveryRecorder,
} from '../handyman-quotations/handyman-quotation-delivery.service';
import { verifyStoredVariationOffer, type VariationOfferStored } from './handyman-variation-offer-document.service';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const invalid = () => AppError.validation('Invalid variation delivery event.');
const missing = () => AppError.notFound('Variation delivery resource not found.');
const conflict = (message: string) => new AppError({ code: 'HANDYMAN_VARIATION_DELIVERY_CONFLICT', statusCode: 409, message });

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !isValidUuid(value)) throw invalid();
  return value.toLowerCase();
}
type Scope = { requestId: string; variationId: string; offerDocumentId: string; offerVersion: string; buildingId?: string };
function parseScope(scope: Scope) {
  if (typeof scope.offerVersion !== 'string' || !/^[1-9]\d*$/.test(scope.offerVersion)) throw invalid();
  const offerVersion = Number(scope.offerVersion);
  if (!Number.isSafeInteger(offerVersion) || offerVersion > 2147483647) throw invalid();
  return { requestId: uuid(scope.requestId), variationId: uuid(scope.variationId), offerDocumentId: uuid(scope.offerDocumentId),
    offerVersion, buildingId: scope.buildingId === undefined ? undefined : uuid(scope.buildingId) };
}
type Document = VariationOfferStored & {
  variation_status: string; tenant_decision_outcome: string | null; quotation_status: string; valid_until: Date | null;
};
async function document(tx: PoolClient, scope: ReturnType<typeof parseScope>, clientId: string): Promise<Document> {
  const row = (await tx.query<Document>(`SELECT d.*,v.status AS variation_status,v.tenant_decision_outcome,
      qv.status AS quotation_status,qv.valid_until
    FROM handyman_variation_offer_documents d
    JOIN handyman_scope_variations v ON v.id=d.variation_id AND v.client_id=d.client_id
      AND v.execution_scope_id=d.execution_scope_id AND v.handyman_request_id=d.request_id
      AND v.revised_quotation_version_id=d.revised_quotation_version_id
    JOIN handyman_execution_scopes s ON s.id=d.execution_scope_id AND s.client_id=d.client_id AND s.handyman_request_id=d.request_id
    JOIN handyman_service_requests r ON r.id=d.request_id AND r.client_id=d.client_id
      AND r.building_id=v.building_id AND r.tenant_company_id=v.tenant_company_id
    JOIN handyman_quotation_versions qv ON qv.id=d.revised_quotation_version_id AND qv.quotation_id=s.quotation_id
    WHERE d.id=$1 AND d.variation_id=$2 AND d.variation_version=$3 AND d.request_id=$4 AND d.client_id=$5
      AND qv.status<>'DRAFT' FOR SHARE OF v,qv`,
  [scope.offerDocumentId, scope.variationId, scope.offerVersion, scope.requestId, clientId])).rows[0];
  if (!row) throw missing();
  verifyStoredVariationOffer(row);
  return row;
}

const fields = `id,client_id AS "clientId",building_id AS "buildingId",request_id AS "requestId",
 tenant_company_id AS "tenantCompanyId",execution_scope_id AS "executionScopeId",variation_id AS "variationId",
 offer_document_id AS "offerDocumentId",offer_version AS "offerVersion",revised_quotation_version_id AS "revisedQuotationVersionId",
 pdf_sha256 AS "pdfSha256",event_type AS "type",channel,recipient_name AS "recipientName",recipient_contact AS "recipientContact",
 recipient_pic_id AS "recipientPicId",sent_event_id AS "sentEventId",evidence_id AS "evidenceId",evidence_sha256 AS "evidenceSha256",
 evidence_kind AS "evidenceKind",recorded_by_user_id AS "recordedByUserId",recorded_by_care_actor_id AS "recordedByCareActorId",
 reported_occurred_at AS "reportedOccurredAt",recorded_at AS "recordedAt"`;
type Sent = { id: string; channel: string; recipient_name: string; recipient_contact: string | null; recipient_pic_id: string | null;
  recorded_by_user_id: string | null; recorded_by_care_actor_id: string | null; reported_occurred_at: Date | null };

/** Manual assertions only: neither a served PDF nor this journal is tenant consent. */
export async function recordVariationDelivery(recorder: CareDeliveryRecorder, rawScope: Scope, body: unknown) {
  const scope = parseScope(rawScope);
  let command: ReturnType<typeof parseCareDeliveryCommand>;
  try { command = parseCareDeliveryCommand(body); }
  catch (error) {
    if (error instanceof AppError && error.code === 'VALIDATION_ERROR') throw invalid();
    throw error;
  }
  return withTransaction(async tx => {
    const request = await authorizeCareDelivery(tx, recorder, scope.requestId, scope.buildingId, missing);
    const doc = await document(tx, scope, request.clientId);
    if (command.pdfSha256 !== doc.pdf_sha256) throw conflict('The supplied PDF checksum does not match this official offer.');
    if (command.occurredAt && new Date(command.occurredAt).getTime() < doc.issued_at.getTime()) {
      throw conflict('A reported delivery time cannot precede the official offer.');
    }
    const column = recorder.userId ? 'recorded_by_user_id' : 'recorded_by_care_actor_id';
    const actorId = recorder.userId ?? recorder.principal!.careActorId;
    const payloadHash = sha(stableJson({ requestId: request.id, variationId: doc.variation_id,
      offerDocumentId: doc.id, offerVersion: doc.variation_version, command }));
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`variation-delivery:${column}:${actorId}:${command.idempotencyKey}`]);
    const previous = (await tx.query(`SELECT ${fields},payload_sha256 FROM handyman_variation_delivery_events
      WHERE ${column}=$1 AND idempotency_key=$2`, [actorId, command.idempotencyKey])).rows[0];
    if (previous) {
      if (previous.payload_sha256 !== payloadHash) throw conflict('Idempotency key belongs to a different delivery fact.');
      await recheckCareDeliveryWorkspace(tx, recorder, request);
      const { payload_sha256: _, ...event } = previous;
      return { event, replayed: true };
    }

    let channel: string, name: string, contact: string | null, picId: string | null, sentId: string | null = null;
    let evidenceId: string | null, evidenceKind: string | null = null;
    if (command.type === 'SENT') {
      if (doc.variation_status !== 'REVISED_QUOTATION' || doc.tenant_decision_outcome !== null ||
          doc.quotation_status !== 'ISSUED' || !doc.valid_until || doc.valid_until.getTime() <= Date.now()) {
        throw conflict('Only a currently valid, undecided issued variation offer can be sent.');
      }
      ({ channel, recipientName: name, recipientContact: contact, recipientPicId: picId, evidenceId } = command);
      if (picId) {
        const pic = await tx.query(`SELECT id FROM tenant_pics WHERE id=$1 AND tenant_company_id=$2 AND status='ACTIVE' FOR SHARE`,
          [picId, request.tenantCompanyId]);
        if (!pic.rowCount) throw conflict('Recipient PIC must belong to this tenant.');
      }
    } else {
      const s = (await tx.query<Sent>(`SELECT id,channel,recipient_name,recipient_contact,recipient_pic_id,
          recorded_by_user_id,recorded_by_care_actor_id,reported_occurred_at
        FROM handyman_variation_delivery_events WHERE id=$1 AND event_type='SENT' AND client_id=$2 AND request_id=$3
          AND variation_id=$4 AND offer_document_id=$5 AND offer_version=$6 AND pdf_sha256=$7`,
      [command.sentEventId, request.clientId, request.id, doc.variation_id, doc.id, doc.variation_version, doc.pdf_sha256])).rows[0];
      if (!s) throw missing();
      if (command.occurredAt && s.reported_occurred_at && new Date(command.occurredAt) < s.reported_occurred_at) {
        throw conflict('Delivery cannot precede the reported send time.');
      }
      // Different authenticated reviewers in the same identity realm. There is
      // no reliable mapping between local users and workspace Care actors.
      const independent = recorder.userId ? !!s.recorded_by_user_id && s.recorded_by_user_id !== recorder.userId
        : !!s.recorded_by_care_actor_id && s.recorded_by_care_actor_id !== recorder.principal!.careActorId;
      if (!independent) throw conflict('A different Care actor in the same identity realm must independently review delivery proof.');
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`variation-delivery-confirmation:${s.id}`]);
      const already = await tx.query(`SELECT id FROM handyman_variation_delivery_events WHERE sent_event_id=$1 AND event_type='DELIVERED'`, [s.id]);
      if (already.rowCount) throw conflict('This send already has a delivery confirmation.');
      channel = s.channel; name = s.recipient_name; contact = s.recipient_contact; picId = s.recipient_pic_id;
      sentId = s.id; evidenceId = command.evidenceId; evidenceKind = command.evidenceKind;
    }
    const evidenceSha = evidenceId ? await verifyCareDeliveryEvidence(tx, evidenceId, request.clientId, request.id, conflict) : null;
    await recheckCareDeliveryWorkspace(tx, recorder, request);
    // The held lifecycle locks prevent changes, but not expiry during storage I/O.
    if (command.type === 'SENT') {
      const live = await tx.query<{ valid: boolean }>(`SELECT status='ISSUED' AND valid_until>clock_timestamp() AS valid
        FROM handyman_quotation_versions WHERE id=$1`, [doc.revised_quotation_version_id]);
      if (!live.rows[0]?.valid) throw conflict('The variation offer expired before the send was recorded.');
    }
    const result = await tx.query(`INSERT INTO handyman_variation_delivery_events
      (id,client_id,building_id,request_id,tenant_company_id,execution_scope_id,variation_id,offer_document_id,offer_version,
       revised_quotation_version_id,pdf_sha256,event_type,channel,recipient_name,recipient_contact,recipient_pic_id,
       sent_event_id,evidence_id,evidence_sha256,evidence_kind,recorded_by_user_id,recorded_by_care_actor_id,
       idempotency_key,payload_sha256,reported_occurred_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25) RETURNING ${fields}`,
    [randomUUID(), request.clientId, request.buildingId, request.id, request.tenantCompanyId, doc.execution_scope_id,
      doc.variation_id, doc.id, doc.variation_version, doc.revised_quotation_version_id, doc.pdf_sha256, command.type,
      channel, name, contact, picId, sentId, evidenceId, evidenceSha, evidenceKind, recorder.userId ?? null,
      recorder.principal?.careActorId ?? null, command.idempotencyKey, payloadHash, command.occurredAt]);
    return { event: result.rows[0], replayed: false };
  });
}

export async function listVariationDelivery(recorder: CareDeliveryRecorder, rawScope: Scope) {
  const scope = parseScope(rawScope);
  return withTransaction(async tx => {
    const request = await authorizeCareDelivery(tx, recorder, scope.requestId, scope.buildingId, missing);
    const doc = await document(tx, scope, request.clientId);
    const result = await tx.query(`SELECT ${fields} FROM handyman_variation_delivery_events
      WHERE client_id=$1 AND request_id=$2 AND variation_id=$3 AND offer_document_id=$4 AND offer_version=$5
      ORDER BY recorded_at,id`, [request.clientId, request.id, doc.variation_id, doc.id, doc.variation_version]);
    await recheckCareDeliveryWorkspace(tx, recorder, request);
    return result.rows;
  });
}
