import { randomUUID } from 'node:crypto';
import { getPool, withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { assertBuildingScopedResourceAccess } from '../context-access';
import { assertVerifiedManagedEvidenceReference } from '../handyman-field-evidence';
import { assertHandymanQuotationPricingAuthority } from '../handyman-quotations/handyman-quotation-access';
import { recordOperationalEvent } from '../operational-events';

type RequestRow = {
  id: string; client_id: string; building_id: string; tenant_company_id: string;
  space_id: string | null; status: string;
};
type LinkRow = {
  id: string; inspection_request_id: string; work_request_id: string;
  inspection_id: string; evidence_upload_id: string; evidence_sha256: string;
  evidence_byte_size: number; fee_execution_scope_id: string; fee_request_id: string;
  created_by_user_id: string; created_at: Date;
};
const LINK_SELECT = `SELECT l.*, s.handyman_request_id AS fee_request_id
  FROM handyman_inspection_work_links l
  JOIN handyman_execution_scopes s ON s.id=l.fee_execution_scope_id`;

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isValidUuid(value)) {
    throw AppError.validation(`${field} must be a valid UUID.`);
  }
  return value.toLowerCase();
}
function conflict(message: string): AppError {
  return new AppError({ code: ERROR_CODES.CONFLICT, statusCode: 409, message });
}
function publicLink(row: LinkRow) {
  return {
    id: row.id, inspectionRequestId: row.inspection_request_id,
    workRequestId: row.work_request_id, inspectionId: row.inspection_id,
    evidenceUploadId: row.evidence_upload_id, evidenceSha256: row.evidence_sha256,
    evidenceByteSize: row.evidence_byte_size, feeExecutionScopeId: row.fee_execution_scope_id,
    feeRequestId: row.fee_request_id, createdAt: row.created_at.toISOString(),
  };
}

/** Attach an existing INTAKE work request, never create or approve it. The
 * source is the recorded INSPECTED visit plus verified request-level bytes;
 * the already-agreed inspection fee retains its own request and ledger. */
export async function linkInspectedWorkRequest(
  inspectionRequestInput: unknown,
  body: unknown,
  actorInput: unknown,
) {
  const inspectionRequestId = uuid(inspectionRequestInput, 'inspectionRequestId');
  const actor = uuid(actorInput, 'actorUserId');
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(k => !['workRequestId', 'inspectionEvidenceReference'].includes(k))) {
    throw AppError.validation('A workRequestId and inspectionEvidenceReference are required.');
  }
  const input = body as Record<string, unknown>;
  const workRequestId = uuid(input.workRequestId, 'workRequestId');
  const reference = typeof input.inspectionEvidenceReference === 'string' ? input.inspectionEvidenceReference.trim() : '';
  if (!reference) throw AppError.validation('inspectionEvidenceReference is required.');
  if (inspectionRequestId === workRequestId) throw conflict('Inspection and work must be separate requests.');

  try {
    return await withTransaction(async tx => {
      const requests = await tx.query<RequestRow>(`SELECT id,client_id,building_id,tenant_company_id,space_id,status
        FROM handyman_service_requests WHERE id IN ($1,$2) ORDER BY id FOR UPDATE`, [inspectionRequestId, workRequestId]);
      const parent = requests.rows.find(r => r.id === inspectionRequestId);
      if (!parent) throw AppError.notFound('Inspection request not found.');
      await assertBuildingScopedResourceAccess(actor, { clientId: parent.client_id, buildingId: parent.building_id }, tx);
      await assertHandymanQuotationPricingAuthority({ actorUserId: actor, clientId: parent.client_id,
        handymanRequestId: parent.id, tenantCompanyId: parent.tenant_company_id }, tx);
      const work = requests.rows.find(r => r.id === workRequestId);
      if (!work || work.client_id !== parent.client_id || work.building_id !== parent.building_id ||
          work.tenant_company_id !== parent.tenant_company_id || work.space_id !== parent.space_id) {
        throw conflict('Inspection and work requests must match Client, Building, customer and space.');
      }
      const previous = await tx.query<LinkRow>(`${LINK_SELECT}
        WHERE l.inspection_request_id=$1 OR l.work_request_id=$2`, [parent.id, work.id]);
      if (previous.rows.length) {
        const row = previous.rows[0];
        if (previous.rows.length === 1 && row.inspection_request_id === parent.id && row.work_request_id === work.id &&
            reference === `hm-ev://${row.evidence_upload_id}`) {
          return { ...publicLink(row), replayed: true };
        }
        throw conflict('Inspection or work request is already linked to a different source.');
      }
      if (work.status !== 'INTAKE' || !['DIAGNOSIS', 'READY_FOR_NEXT_STEP'].includes(parent.status)) {
        throw conflict('Link an INSPECTED request to an untriaged work request before either is quoted.');
      }
      const source = (await tx.query<{ inspection_id: string; fee_scope_id: string; treatment: string }>(`
        SELECT i.id AS inspection_id, ft.fee_execution_scope_id AS fee_scope_id, ft.treatment
          FROM handyman_request_inspections i
          JOIN handyman_inspection_fee_terms ft ON ft.handyman_request_id=i.handyman_request_id
           AND ft.treatment IN ('PAID_SEPARATE','PAID_CREDITED') AND ft.fee_execution_scope_id IS NOT NULL
          JOIN handyman_execution_scopes s ON s.id=ft.fee_execution_scope_id
          JOIN handyman_quotation_versions v ON v.id=s.approved_quotation_version_id AND v.status='APPROVED'
          JOIN handyman_quotation_decisions d ON d.id=s.quotation_decision_id
           AND d.quotation_version_id=v.id AND d.decision='APPROVE'
          JOIN handyman_inspection_fee_offers o ON o.quotation_version_id=v.id
           AND o.handyman_request_id=i.handyman_request_id AND o.treatment=ft.treatment
         WHERE i.handyman_request_id=$1 AND i.client_id=$2 AND i.building_id=$3
           AND i.inspection_result='INSPECTED'`, [parent.id, parent.client_id, parent.building_id])).rows[0];
      if (!source) throw conflict('An INSPECTED result and an agreed, customer-approved paid inspection fee are required.');
      if (source.treatment === 'PAID_CREDITED') {
        throw conflict('PAID_CREDITED cannot be linked: the existing explicit inspection-credit contract only recognizes work on the inspected request.');
      }
      const evidence = await assertVerifiedManagedEvidenceReference(tx, {
        clientId: parent.client_id, buildingId: parent.building_id,
        handymanRequestId: parent.id, executionScopeId: null,
      }, reference, { requiredPurpose: 'INSPECTION_EVIDENCE' });
      if (!evidence) throw conflict('Verified inspection report evidence is required.');
      const inserted = await tx.query<{ id: string }>(`INSERT INTO handyman_inspection_work_links
        (id,client_id,building_id,tenant_company_id,space_id,inspection_request_id,work_request_id,
         inspection_id,evidence_upload_id,evidence_sha256,evidence_byte_size,fee_execution_scope_id,created_by_user_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [randomUUID(), parent.client_id, parent.building_id, parent.tenant_company_id, parent.space_id,
        parent.id, work.id, source.inspection_id, evidence.id, evidence.sha256Checksum,
        evidence.verifiedByteSize, source.fee_scope_id, actor]);
      const row = (await tx.query<LinkRow>(`${LINK_SELECT} WHERE l.id=$1`, [inserted.rows[0].id])).rows[0];
      await recordOperationalEvent({ clientId: parent.client_id, buildingId: parent.building_id, actorUserId: actor,
        eventType: 'HANDYMAN_INSPECTION_WORK_LINKED', entityType: 'HANDYMAN_SERVICE_REQUEST', entityId: work.id,
        summary: 'Work request linked to a completed paid inspection and verified evidence.',
        metadata: { linkId: row.id, inspectionRequestId: parent.id, workRequestId: work.id,
          inspectionId: row.inspection_id, evidenceUploadId: row.evidence_upload_id,
          feeExecutionScopeId: row.fee_execution_scope_id } }, tx);
      return { ...publicLink(row), replayed: false };
    });
  } catch (error) {
    if (['23505', '23514'].includes((error as { code?: string }).code ?? '')) {
      throw conflict('Inspection/work linkage conflicts with the existing source, scope or request state.');
    }
    throw error;
  }
}

/** Scoped reference read for either side; no commercial decision is implied. */
export async function readInspectionWorkLink(requestInput: unknown, actorInput: unknown) {
  const requestId = uuid(requestInput, 'requestId'), actor = uuid(actorInput, 'actorUserId');
  const db = getPool();
  const request = (await db.query<RequestRow>(`SELECT id,client_id,building_id,tenant_company_id,space_id,status
    FROM handyman_service_requests WHERE id=$1`, [requestId])).rows[0];
  if (!request) throw AppError.notFound('Request not found.');
  await assertBuildingScopedResourceAccess(actor, { clientId: request.client_id, buildingId: request.building_id });
  const row = (await db.query<LinkRow>(`${LINK_SELECT}
    WHERE l.inspection_request_id=$1 OR l.work_request_id=$1`, [requestId])).rows[0];
  return row ? publicLink(row) : null;
}
