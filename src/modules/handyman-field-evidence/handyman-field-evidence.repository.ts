import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanFieldEvidenceMimeType,
  HandymanFieldEvidencePurpose,
  HandymanFieldEvidenceUploadRecord,
  HandymanFieldEvidenceUploadStatus,
} from './handyman-field-evidence.types';

type DbExecutor = Pick<PoolClient, 'query'>;

interface EvidenceRow {
  id: string;
  client_id: string;
  tenant_company_id: string;
  building_id: string;
  handyman_request_id: string;
  execution_scope_id: string | null;
  variation_id: string | null;
  material_purchase_record_id: string | null;
  purpose: HandymanFieldEvidencePurpose;
  upload_status: HandymanFieldEvidenceUploadStatus;
  original_file_name: string;
  mime_type: HandymanFieldEvidenceMimeType;
  storage_key: string;
  declared_byte_size: number | null;
  verified_byte_size: number;
  sha256_checksum: string | null;
  attachment_reference: string | null;
  uploaded_by_user_id: string;
  uploaded_by_role: 'PIC_PEKERJAAN' | 'INSPECTOR' | 'OPERATIONS_MANAGER';
  notes: string | null;
  idempotency_key: string;
  verified_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function toIso(val: Date | string | null): string | null {
  if (!val) return null;
  return val instanceof Date ? val.toISOString() : new Date(val).toISOString();
}

function mapEvidenceRow(row: EvidenceRow): HandymanFieldEvidenceUploadRecord {
  const isVerified = row.upload_status === 'VERIFIED';
  const contentPath = isVerified
    ? `/api/v1/handyman/field/evidence/${row.id}/content`
    : null;
  return {
    id: row.id,
    clientId: row.client_id,
    tenantCompanyId: row.tenant_company_id,
    buildingId: row.building_id,
    handymanRequestId: row.handyman_request_id,
    executionScopeId: row.execution_scope_id,
    variationId: row.variation_id,
    materialPurchaseRecordId: row.material_purchase_record_id,
    purpose: row.purpose,
    uploadStatus: row.upload_status,
    uploadCompleted: isVerified,
    originalFileName: row.original_file_name,
    mimeType: row.mime_type,
    storageKey: row.storage_key,
    declaredByteSize:
      row.declared_byte_size !== null ? Number(row.declared_byte_size) : null,
    verifiedByteSize: Number(row.verified_byte_size),
    sha256Checksum: row.sha256_checksum,
    attachmentReference: row.attachment_reference,
    downloadPath: contentPath,
    previewPath: contentPath,
    uploadedByUserId: row.uploaded_by_user_id,
    uploadedByRole: row.uploaded_by_role,
    notes: row.notes,
    idempotencyKey: row.idempotency_key,
    verifiedAt: toIso(row.verified_at),
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!,
  };
}

const EVIDENCE_COLUMNS = `
  id, client_id, tenant_company_id, building_id, handyman_request_id,
  execution_scope_id, variation_id, material_purchase_record_id,
  purpose, upload_status, original_file_name, mime_type, storage_key,
  declared_byte_size, verified_byte_size, sha256_checksum,
  attachment_reference, uploaded_by_user_id, uploaded_by_role,
  notes, idempotency_key, verified_at, created_at, updated_at
`;

export const handymanFieldEvidenceRepository = {
  async findById(
    evidenceId: string,
    tx?: DbExecutor,
  ): Promise<HandymanFieldEvidenceUploadRecord | null> {
    const db = tx ?? getPool();
    const res = await db.query<EvidenceRow>(
      `SELECT ${EVIDENCE_COLUMNS}
         FROM handyman_field_evidence_uploads
        WHERE id = $1`,
      [evidenceId],
    );
    return res.rows[0] ? mapEvidenceRow(res.rows[0]) : null;
  },

  async findByIdForUpdate(
    tx: DbExecutor,
    evidenceId: string,
  ): Promise<HandymanFieldEvidenceUploadRecord | null> {
    const res = await tx.query<EvidenceRow>(
      `SELECT ${EVIDENCE_COLUMNS}
         FROM handyman_field_evidence_uploads
        WHERE id = $1
        FOR UPDATE`,
      [evidenceId],
    );
    return res.rows[0] ? mapEvidenceRow(res.rows[0]) : null;
  },

  async findByIdempotencyKey(
    tx: DbExecutor,
    clientId: string,
    uploadedByUserId: string,
    idempotencyKey: string,
  ): Promise<HandymanFieldEvidenceUploadRecord | null> {
    const res = await tx.query<EvidenceRow>(
      `SELECT ${EVIDENCE_COLUMNS}
         FROM handyman_field_evidence_uploads
        WHERE client_id = $1
          AND uploaded_by_user_id = $2
          AND idempotency_key = $3`,
      [clientId, uploadedByUserId, idempotencyKey],
    );
    return res.rows[0] ? mapEvidenceRow(res.rows[0]) : null;
  },

  async insertUpload(
    tx: DbExecutor,
    input: {
      id: string;
      clientId: string;
      tenantCompanyId: string;
      buildingId: string;
      handymanRequestId: string;
      executionScopeId: string | null;
      variationId: string | null;
      materialPurchaseRecordId: string | null;
      purpose: HandymanFieldEvidencePurpose;
      uploadStatus: HandymanFieldEvidenceUploadStatus;
      originalFileName: string;
      mimeType: HandymanFieldEvidenceMimeType;
      storageKey: string;
      declaredByteSize: number | null;
      verifiedByteSize: number;
      sha256Checksum: string | null;
      attachmentReference: string | null;
      uploadedByUserId: string;
      uploadedByRole: 'PIC_PEKERJAAN' | 'INSPECTOR' | 'OPERATIONS_MANAGER';
      notes: string | null;
      idempotencyKey: string;
      verifiedAt: Date | null;
    },
  ): Promise<HandymanFieldEvidenceUploadRecord> {
    const res = await tx.query<EvidenceRow>(
      `INSERT INTO handyman_field_evidence_uploads (
         id, client_id, tenant_company_id, building_id, handyman_request_id,
         execution_scope_id, variation_id, material_purchase_record_id,
         purpose, upload_status, original_file_name, mime_type, storage_key,
         declared_byte_size, verified_byte_size, sha256_checksum,
         attachment_reference, uploaded_by_user_id, uploaded_by_role,
         notes, idempotency_key, verified_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         $14, $15, $16, $17, $18, $19, $20, $21, $22
       )
       RETURNING ${EVIDENCE_COLUMNS}`,
      [
        input.id,
        input.clientId,
        input.tenantCompanyId,
        input.buildingId,
        input.handymanRequestId,
        input.executionScopeId,
        input.variationId,
        input.materialPurchaseRecordId,
        input.purpose,
        input.uploadStatus,
        input.originalFileName,
        input.mimeType,
        input.storageKey,
        input.declaredByteSize,
        input.verifiedByteSize,
        input.sha256Checksum,
        input.attachmentReference,
        input.uploadedByUserId,
        input.uploadedByRole,
        input.notes,
        input.idempotencyKey,
        input.verifiedAt,
      ],
    );
    return mapEvidenceRow(res.rows[0]);
  },

  async updateStagedBytes(
    tx: DbExecutor,
    input: {
      evidenceId: string;
      verifiedByteSize: number;
      sha256Checksum: string;
    },
  ): Promise<HandymanFieldEvidenceUploadRecord> {
    const res = await tx.query<EvidenceRow>(
      `UPDATE handyman_field_evidence_uploads
          SET upload_status = 'STAGED_BYTES',
              verified_byte_size = $2,
              sha256_checksum = $3,
              updated_at = NOW()
        WHERE id = $1
          AND upload_status IN ('PENDING_BYTES', 'STAGED_BYTES')
        RETURNING ${EVIDENCE_COLUMNS}`,
      [input.evidenceId, input.verifiedByteSize, input.sha256Checksum],
    );
    return mapEvidenceRow(res.rows[0]);
  },

  async markVerified(
    tx: DbExecutor,
    input: {
      evidenceId: string;
      attachmentReference: string;
    },
  ): Promise<HandymanFieldEvidenceUploadRecord> {
    const res = await tx.query<EvidenceRow>(
      `UPDATE handyman_field_evidence_uploads
          SET upload_status = 'VERIFIED',
              attachment_reference = $2,
              verified_at = NOW(),
              updated_at = NOW()
        WHERE id = $1
        RETURNING ${EVIDENCE_COLUMNS}`,
      [input.evidenceId, input.attachmentReference],
    );
    return mapEvidenceRow(res.rows[0]);
  },

  async listByExecutionScope(
    executionScopeId: string,
    tx?: DbExecutor,
  ): Promise<HandymanFieldEvidenceUploadRecord[]> {
    const db = tx ?? getPool();
    const res = await db.query<EvidenceRow>(
      `SELECT ${EVIDENCE_COLUMNS}
         FROM handyman_field_evidence_uploads
        WHERE execution_scope_id = $1
        ORDER BY created_at ASC, id ASC`,
      [executionScopeId],
    );
    return res.rows.map(mapEvidenceRow);
  },

  async listByRequest(
    handymanRequestId: string,
    tx?: DbExecutor,
  ): Promise<HandymanFieldEvidenceUploadRecord[]> {
    const db = tx ?? getPool();
    const res = await db.query<EvidenceRow>(
      `SELECT ${EVIDENCE_COLUMNS}
         FROM handyman_field_evidence_uploads
        WHERE handyman_request_id = $1
        ORDER BY created_at ASC, id ASC`,
      [handymanRequestId],
    );
    return res.rows.map(mapEvidenceRow);
  },
};
