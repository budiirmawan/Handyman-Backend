import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { AppError } from '../../shared/errors';
import { stableJson } from '../../shared/stable-json';
import { isValidUuid } from '../clients';
import { createEvidenceStorage, evidenceStorageKey } from '../evidence/storage';
import { authorizeCareCommercialRequest } from '../handyman-commercial-consent/commercial-consent.service';
import { resolveCareWorkspacePrincipal, workspaceUnauthorized, type CareWorkspacePrincipal } from '../handyman-care-workspace/care-workspace.service';
import { handymanServiceRequestRepository } from '../handyman-requests/handyman-service-request.repository';

const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const invalid = () => AppError.validation('Invalid quotation delivery event.');
const missing = () => AppError.notFound('Quotation delivery resource not found.');
const conflict = (message: string) => new AppError({ code: 'HANDYMAN_QUOTATION_DELIVERY_CONFLICT', statusCode: 409, message });
const digest = /^[0-9a-f]{64}$/;
function uuid(v: unknown): string { if (typeof v !== 'string' || !isValidUuid(v)) throw invalid(); return v.toLowerCase(); }
function text(v: unknown, max: number): string {
  if (typeof v !== 'string' || !v.trim() || v.trim().length > max) throw invalid();
  return v.trim();
}
function optionalText(v: unknown, max: number): string | null { return v == null ? null : text(v, max); }
function reportedTime(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)) throw invalid();
  const time = new Date(v);
  if (!Number.isFinite(time.getTime()) || time.toISOString() !== v || time.getTime() > Date.now()) throw invalid();
  return v;
}

type Recorder = { userId: string; principal?: never } | { principal: CareWorkspacePrincipal; userId?: never };
type Scope = { requestId: string; quotationId: string; versionId: string; buildingId?: string };
type Command = {
  type: 'SENT'; pdfSha256: string; channel: 'WHATSAPP' | 'EMAIL' | 'DIRECT';
  recipientName: string; recipientContact: string | null; recipientPicId: string | null;
  evidenceId: string | null; occurredAt: string | null; idempotencyKey: string;
} | {
  type: 'DELIVERED'; pdfSha256: string; sentEventId: string; evidenceId: string;
  evidenceKind: 'PROVIDER_RECEIPT' | 'TENANT_ACKNOWLEDGEMENT'; reviewed: true; occurredAt: string | null; idempotencyKey: string;
};

function parseCommand(value: unknown): Command {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const b = value as Record<string, unknown>;
  if (typeof b.pdfSha256 !== 'string' || !digest.test(b.pdfSha256)) throw invalid();
  const pdfSha256 = b.pdfSha256, idempotencyKey = text(b.idempotencyKey, 128), occurredAt = reportedTime(b.occurredAt);
  if (b.type === 'SENT') {
    if (Object.keys(b).some(k => !['type','pdfSha256','channel','recipientName','recipientContact','recipientPicId','evidenceId','occurredAt','idempotencyKey'].includes(k)) ||
      typeof b.channel !== 'string' || !['WHATSAPP','EMAIL','DIRECT'].includes(b.channel)) throw invalid();
    const channel = b.channel as 'WHATSAPP' | 'EMAIL' | 'DIRECT';
    const recipientContact = optionalText(b.recipientContact, 200);
    if (channel !== 'DIRECT' && !recipientContact) throw invalid();
    return { type: 'SENT', pdfSha256, channel, recipientName: text(b.recipientName, 200), recipientContact,
      recipientPicId: b.recipientPicId == null ? null : uuid(b.recipientPicId), evidenceId: b.evidenceId == null ? null : uuid(b.evidenceId), occurredAt, idempotencyKey };
  }
  if (b.type === 'DELIVERED') {
    if (Object.keys(b).some(k => !['type','pdfSha256','sentEventId','evidenceId','evidenceKind','reviewed','occurredAt','idempotencyKey'].includes(k)) ||
        typeof b.evidenceKind !== 'string' || !['PROVIDER_RECEIPT','TENANT_ACKNOWLEDGEMENT'].includes(b.evidenceKind) || b.reviewed !== true) throw invalid();
    return { type: 'DELIVERED', pdfSha256, sentEventId: uuid(b.sentEventId), evidenceId: uuid(b.evidenceId),
      evidenceKind: b.evidenceKind as 'PROVIDER_RECEIPT' | 'TENANT_ACKNOWLEDGEMENT', reviewed: true, occurredAt, idempotencyKey };
  }
  // DOWNLOADED is written only by the authorized PDF response, never by an API claim.
  throw invalid();
}

/** The same active Care capability and exact-Building assignment as the local
 * Care authority, held through the write so a revocation cannot race it. */
async function hasLocalCareScope(tx: PoolClient, userId: string, clientId: string, buildingId: string): Promise<boolean> {
  const result = await tx.query(`SELECT u.id FROM users u
    JOIN user_role_assignments ura ON ura.user_id=u.id AND ura.status='ACTIVE'
    JOIN roles role ON role.id=ura.role_id AND role.status='ACTIVE'
    JOIN role_permission_assignments rpa ON rpa.role_id=role.id AND rpa.status='ACTIVE'
    JOIN permissions perm ON perm.id=rpa.permission_id AND perm.status='ACTIVE' AND perm.code='handyman.care.building'
    JOIN user_building_assignments a ON a.user_id=u.id AND a.status='ACTIVE'
    JOIN buildings b ON b.id=a.building_id AND b.status='ACTIVE'
    JOIN properties p ON p.id=b.property_id
    JOIN clients c ON c.id=p.client_id
    WHERE u.id=$1 AND u.status='ACTIVE' AND b.id=$2 AND c.id=$3
    LIMIT 1 FOR SHARE OF u,ura,role,rpa,perm,a,b,p,c`, [userId, buildingId, clientId]);
  return result.rowCount === 1;
}

async function authorize(tx: PoolClient, recorder: Recorder, requestId: string, buildingId?: string) {
  const request = await handymanServiceRequestRepository.findById(tx, requestId);
  if (!request || (buildingId && request.buildingId !== buildingId)) throw missing();
  if (recorder.principal) {
    await authorizeCareCommercialRequest(tx, recorder.principal, request);
  } else {
    if (!recorder.userId || !await hasLocalCareScope(tx, recorder.userId, request.clientId, request.buildingId)) throw missing();
  }
  return request;
}

/** A session or effective occupancy may expire while waiting for evidence I/O. */
async function recheckWorkspace(tx: PoolClient, recorder: Recorder, request: Awaited<ReturnType<typeof authorize>>) {
  if (recorder.principal) await authorizeCareCommercialRequest(tx, recorder.principal, request);
}

type Document = {
  id: string; client_id: string; request_id: string; quotation_id: string; quotation_version_id: string;
  pdf_sha256: string; pdf_bytes: Buffer; pdf_size: number; source_canonical: string; source_sha256: string;
  source_snapshot: unknown; status: string; issued_at: Date; valid_until: Date | null;
};
async function document(tx: PoolClient, requestId: string, versionId: string, quotationId?: string): Promise<Document> {
  const result = await tx.query<Document>(`SELECT d.*,v.status,v.valid_until FROM handyman_quotation_documents d
    JOIN handyman_quotation_versions v ON v.id=d.quotation_version_id AND v.quotation_id=d.quotation_id
    JOIN handyman_quotations q ON q.id=d.quotation_id AND q.client_id=d.client_id AND q.handyman_request_id=d.request_id
    WHERE d.request_id=$1 AND d.quotation_version_id=$2 AND ($3::uuid IS NULL OR d.quotation_id=$3)
      AND v.status<>'DRAFT' FOR SHARE OF v`, [requestId, versionId, quotationId ?? null]);
  const d = result.rows[0];
  if (!d) throw missing();
  if (!Buffer.isBuffer(d.pdf_bytes) || d.pdf_bytes.length !== d.pdf_size || d.pdf_size < 1 ||
      d.pdf_bytes.subarray(0,5).toString() !== '%PDF-' || sha(d.pdf_bytes) !== d.pdf_sha256 ||
      sha(d.source_canonical) !== d.source_sha256 || stableJson(d.source_snapshot) !== d.source_canonical) {
    throw conflict('Official quotation document failed integrity verification.');
  }
  return d;
}

/** Only an actual protected request-owned file is accepted. A matching hash
 * verifies bytes, NOT what they mean or whether a delivery really occurred. */
async function evidenceChecksum(tx: PoolClient, evidenceId: string, clientId: string, requestId: string): Promise<string> {
  const result = await tx.query<{ file_reference: string; file_size: string; content_sha256: string }>(`
    SELECT file_reference,file_size,content_sha256 FROM evidence_submissions
    WHERE id=$1 AND client_id=$2 AND execution_type='HANDYMAN_REQUEST' AND execution_id=$3
      AND status='ACTIVE' AND retention_state<>'PURGED' AND file_reference=$4 AND file_size>0 AND hash_algorithm='SHA-256'
      AND content_sha256 IS NOT NULL AND content_hashed_at IS NOT NULL FOR SHARE`,
  [evidenceId, clientId, requestId, evidenceStorageKey(evidenceId)]);
  const row = result.rows[0];
  if (!row || !digest.test(row.content_sha256)) throw conflict('Protected, hashed request evidence is required.');
  try {
    const stored = await createEvidenceStorage().get(row.file_reference);
    if (stored.size !== Number(row.file_size) || stored.buffer.length !== stored.size || sha(stored.buffer) !== row.content_sha256) throw new Error('mismatch');
  } catch { throw conflict('Delivery evidence bytes are unavailable or failed integrity verification.'); }
  return row.content_sha256;
}

const fields = `id,client_id AS "clientId",building_id AS "buildingId",request_id AS "requestId",
 tenant_company_id AS "tenantCompanyId",quotation_id AS "quotationId",quotation_version_id AS "quotationVersionId",
 document_id AS "documentId",pdf_sha256 AS "pdfSha256",event_type AS "type",channel,recipient_name AS "recipientName",
 recipient_contact AS "recipientContact",recipient_pic_id AS "recipientPicId",sent_event_id AS "sentEventId",
 evidence_id AS "evidenceId",evidence_sha256 AS "evidenceSha256",evidence_kind AS "evidenceKind",
 recorded_by_user_id AS "recordedByUserId",recorded_by_care_actor_id AS "recordedByCareActorId",
 reported_occurred_at AS "reportedOccurredAt",recorded_at AS "recordedAt"`;

type Sent = { id: string; channel: string; recipient_name: string; recipient_contact: string | null; recipient_pic_id: string | null;
  recorded_by_user_id: string | null; recorded_by_care_actor_id: string | null; reported_occurred_at: Date | null };

export async function recordQuotationDelivery(recorder: Recorder, rawScope: Scope, body: unknown) {
  const scope = { requestId: uuid(rawScope.requestId), quotationId: uuid(rawScope.quotationId), versionId: uuid(rawScope.versionId),
    buildingId: rawScope.buildingId ? uuid(rawScope.buildingId) : undefined };
  const command = parseCommand(body);
  return withTransaction(async tx => {
    const request = await authorize(tx, recorder, scope.requestId, scope.buildingId);
    const doc = await document(tx, request.id, scope.versionId, scope.quotationId);
    if (command.pdfSha256 !== doc.pdf_sha256) throw conflict('The supplied PDF checksum does not match this official version.');
    if (command.occurredAt && new Date(command.occurredAt).getTime() < doc.issued_at.getTime()) {
      throw conflict('A reported delivery time cannot precede the official quotation.');
    }
    const column = recorder.userId ? 'recorded_by_user_id' : 'recorded_by_care_actor_id';
    const actorId = recorder.userId ?? recorder.principal!.careActorId;
    const payloadHash = sha(stableJson({ requestId: request.id, quotationId: doc.quotation_id, versionId: doc.quotation_version_id, command }));
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`quotation-delivery:${column}:${actorId}:${command.idempotencyKey}`]);
    const previous = await tx.query(`SELECT ${fields},payload_sha256 FROM handyman_quotation_delivery_events
      WHERE ${column}=$1 AND idempotency_key=$2`, [actorId, command.idempotencyKey]);
    if (previous.rows[0]) {
      if (previous.rows[0].payload_sha256 !== payloadHash) throw conflict('Idempotency key belongs to a different delivery fact.');
      const { payload_sha256: _, ...event } = previous.rows[0];
      return { event, replayed: true };
    }

    let channel: string, name: string, contact: string | null, picId: string | null, sentId: string | null = null;
    let evidenceId: string | null, evidenceKind: string | null = null;
    if (command.type === 'SENT') {
      if (doc.status !== 'ISSUED' || !doc.valid_until || doc.valid_until.getTime() <= Date.now()) {
        throw conflict('Only a currently valid ISSUED quotation can be sent.');
      }
      ({ channel, recipientName: name, recipientContact: contact, recipientPicId: picId, evidenceId } = command);
      if (picId) {
        const pic = await tx.query(`SELECT id FROM tenant_pics WHERE id=$1 AND tenant_company_id=$2 AND status='ACTIVE' FOR SHARE`, [picId, request.tenantCompanyId]);
        if (!pic.rowCount) throw conflict('Recipient PIC must belong to this tenant.');
      }
    } else {
      const sent = await tx.query<Sent>(`SELECT id,channel,recipient_name,recipient_contact,recipient_pic_id,recorded_by_user_id,recorded_by_care_actor_id,reported_occurred_at
        FROM handyman_quotation_delivery_events WHERE id=$1 AND event_type='SENT' AND client_id=$2 AND request_id=$3
          AND quotation_id=$4 AND quotation_version_id=$5 AND document_id=$6 AND pdf_sha256=$7`,
      [command.sentEventId, request.clientId, request.id, doc.quotation_id, doc.quotation_version_id, doc.id, doc.pdf_sha256]);
      const s = sent.rows[0];
      if (!s) throw missing();
      if (command.occurredAt && s.reported_occurred_at && new Date(command.occurredAt) < s.reported_occurred_at) {
        throw conflict('Delivery cannot precede the reported send time.');
      }
      // Different authenticated reviewers in the SAME identity realm: local
      // and workspace identities have no reliable cross-realm person mapping.
      const independent = recorder.userId ? !!s.recorded_by_user_id && s.recorded_by_user_id !== recorder.userId
        : !!s.recorded_by_care_actor_id && s.recorded_by_care_actor_id !== recorder.principal!.careActorId;
      if (!independent) throw conflict('A different Care actor in the same identity realm must independently review delivery proof.');
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`quotation-delivery-confirmation:${s.id}`]);
      const already = await tx.query(`SELECT id FROM handyman_quotation_delivery_events WHERE sent_event_id=$1 AND event_type='DELIVERED'`, [s.id]);
      if (already.rowCount) throw conflict('This send already has a delivery confirmation.');
      channel = s.channel; name = s.recipient_name; contact = s.recipient_contact; picId = s.recipient_pic_id;
      sentId = s.id; evidenceId = command.evidenceId; evidenceKind = command.evidenceKind;
    }
    const evidenceSha = evidenceId ? await evidenceChecksum(tx, evidenceId, request.clientId, request.id) : null;
    await recheckWorkspace(tx, recorder, request);
    const result = await tx.query(`INSERT INTO handyman_quotation_delivery_events
      (id,client_id,building_id,request_id,tenant_company_id,quotation_id,quotation_version_id,document_id,pdf_sha256,
       event_type,channel,recipient_name,recipient_contact,recipient_pic_id,sent_event_id,evidence_id,evidence_sha256,evidence_kind,
       recorded_by_user_id,recorded_by_care_actor_id,idempotency_key,payload_sha256,reported_occurred_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING ${fields}`,
    [randomUUID(), request.clientId, request.buildingId, request.id, request.tenantCompanyId, doc.quotation_id, doc.quotation_version_id,
      doc.id, doc.pdf_sha256, command.type, channel, name, contact, picId, sentId, evidenceId, evidenceSha, evidenceKind,
      recorder.userId ?? null, recorder.principal?.careActorId ?? null, command.idempotencyKey, payloadHash, command.occurredAt]);
    return { event: result.rows[0], replayed: false };
  });
}

export async function listQuotationDelivery(recorder: Recorder, rawScope: Scope) {
  const scope = { requestId: uuid(rawScope.requestId), quotationId: uuid(rawScope.quotationId), versionId: uuid(rawScope.versionId),
    buildingId: rawScope.buildingId ? uuid(rawScope.buildingId) : undefined };
  return withTransaction(async tx => {
    const request = await authorize(tx, recorder, scope.requestId, scope.buildingId);
    const doc = await document(tx, request.id, scope.versionId, scope.quotationId);
    const result = await tx.query(`SELECT ${fields} FROM handyman_quotation_delivery_events
      WHERE client_id=$1 AND request_id=$2 AND quotation_id=$3 AND quotation_version_id=$4 AND document_id=$5
      ORDER BY recorded_at,id`, [request.clientId, request.id, doc.quotation_id, doc.quotation_version_id, doc.id]);
    await recheckWorkspace(tx, recorder, request);
    return result.rows;
  });
}

async function insertDownloaded(tx: PoolClient, recorder: Recorder, request: Awaited<ReturnType<typeof authorize>>, doc: Document, expectedSha: string) {
  if (doc.pdf_sha256 !== expectedSha) throw conflict('Downloaded PDF checksum does not match the official version.');
  await recheckWorkspace(tx, recorder, request);
  await tx.query(`INSERT INTO handyman_quotation_delivery_events
    (id,client_id,building_id,request_id,tenant_company_id,quotation_id,quotation_version_id,document_id,pdf_sha256,event_type,recorded_by_user_id,recorded_by_care_actor_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'DOWNLOADED',$10,$11)`,
  [randomUUID(),request.clientId,request.buildingId,request.id,request.tenantCompanyId,doc.quotation_id,doc.quotation_version_id,
    doc.id,doc.pdf_sha256,recorder.userId ?? null,recorder.principal?.careActorId ?? null]);
}

/** Record that the server served the PDF to Care, never that it reached a tenant. */
export async function recordLocalCareDownload(userId: string, versionId: string, expectedSha: string) {
  return withTransaction(async tx => {
    const parent = await tx.query<{ request_id: string; client_id: string; building_id: string }>(`
      SELECT d.request_id,d.client_id,r.building_id FROM handyman_quotation_documents d
      JOIN handyman_service_requests r ON r.id=d.request_id AND r.client_id=d.client_id
      WHERE d.quotation_version_id=$1`, [uuid(versionId)]);
    const p = parent.rows[0];
    // Operations may download too. Only exact-Building Care gets a Care event.
    if (!p || !await hasLocalCareScope(tx, userId, p.client_id, p.building_id)) return;
    const recorder: Recorder = { userId };
    const request = await authorize(tx, recorder, p.request_id, p.building_id);
    const doc = await document(tx, request.id, uuid(versionId));
    await insertDownloaded(tx, recorder, request, doc, expectedSha);
  });
}

export async function recordWorkspaceCareDownload(token: string, requestId: string, versionId: string, expectedSha: string) {
  const principal = await resolveCareWorkspacePrincipal(token);
  const recorder: Recorder = { principal };
  return withTransaction(async tx => {
    const request = await authorize(tx, recorder, uuid(requestId));
    const doc = await document(tx, request.id, uuid(versionId));
    await insertDownloaded(tx, recorder, request, doc, expectedSha);
  });
}

export async function workspaceRecorder(authorization: string | undefined): Promise<Recorder> {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
  if (!match) throw workspaceUnauthorized();
  return { principal: await resolveCareWorkspacePrincipal(match[1]) };
}
