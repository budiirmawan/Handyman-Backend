import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type { VisitorIdentityType } from '../visitors';
import type {
  CreateVisitorPhotoInput,
  VisitorPhotoListFilters,
  VisitorPhotoOcrStatus,
  VisitorPhotoRecord,
  VisitorPhotoReviewStatus,
  VisitorPhotoStatus,
  VisitorPhotoType,
} from './visitor-photo.types';

/**
 * BE-13E — Visitor Photo / OCR Readiness repository.
 *
 * Stores safe file references + OCR metadata only — never binaries.
 * All access rules live in the service layer.
 */

type VisitorPhotoRow = {
  id: string;
  client_id: string;
  visitor_id: string;
  photo_type: VisitorPhotoType;
  file_reference: string;
  original_file_name: string;
  mime_type: string;
  file_size: string | number;
  captured_at: Date | null;
  ocr_status: VisitorPhotoOcrStatus;
  ocr_provider: string | null;
  ocr_error: string | null;
  ocr_processed_at: Date | null;
  extracted_full_name: string | null;
  extracted_identity_type: VisitorIdentityType | null;
  extracted_identity_number: string | null;
  review_status: VisitorPhotoReviewStatus;
  reviewed_by_user_id: string | null;
  reviewed_at: Date | null;
  status: VisitorPhotoStatus;
  created_by_user_id: string;
  created_at: Date;
  updated_at: Date;
};

const VISITOR_PHOTO_COLUMNS = `
  id, client_id, visitor_id, photo_type,
  file_reference, original_file_name, mime_type, file_size, captured_at,
  ocr_status, ocr_provider, ocr_error, ocr_processed_at,
  extracted_full_name, extracted_identity_type, extracted_identity_number,
  review_status, reviewed_by_user_id, reviewed_at,
  status, created_by_user_id, created_at, updated_at
`;

function mapRow(row: VisitorPhotoRow): VisitorPhotoRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    visitorId: row.visitor_id,
    photoType: row.photo_type,
    fileReference: row.file_reference,
    originalFileName: row.original_file_name,
    mimeType: row.mime_type,
    fileSize: Number(row.file_size),
    capturedAt: row.captured_at,
    ocrStatus: row.ocr_status,
    ocrProvider: row.ocr_provider,
    ocrError: row.ocr_error,
    ocrProcessedAt: row.ocr_processed_at,
    extractedFullName: row.extracted_full_name,
    extractedIdentityType: row.extracted_identity_type,
    extractedIdentityNumber: row.extracted_identity_number,
    reviewStatus: row.review_status,
    reviewedByUserId: row.reviewed_by_user_id,
    reviewedAt: row.reviewed_at,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function create(
  input: CreateVisitorPhotoInput & { clientId: string },
): Promise<VisitorPhotoRecord> {
  const result = await getPool().query<VisitorPhotoRow>(
    `INSERT INTO visitor_photos
       (id, client_id, visitor_id, photo_type,
        file_reference, original_file_name, mime_type, file_size,
        captured_at, ocr_status, ocr_provider, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING ${VISITOR_PHOTO_COLUMNS}`,
    [
      randomUUID(),
      input.clientId,
      input.visitorId,
      input.photoType,
      input.fileReference,
      input.originalFileName,
      input.mimeType,
      input.fileSize,
      input.capturedAt ?? null,
      input.requestOcr ? 'PENDING' : 'NOT_REQUESTED',
      input.ocrProvider ?? null,
      input.createdByUserId,
    ],
  );
  return mapRow(result.rows[0]);
}

export async function findById(
  id: string,
): Promise<VisitorPhotoRecord | null> {
  const result = await getPool().query<VisitorPhotoRow>(
    `SELECT ${VISITOR_PHOTO_COLUMNS}
     FROM visitor_photos WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function listByVisitor(
  visitorId: string,
  filter: VisitorPhotoListFilters = {},
): Promise<VisitorPhotoRecord[]> {
  const conditions = ['visitor_id = $1'];
  const values: unknown[] = [visitorId];

  if (filter.photoType) {
    values.push(filter.photoType);
    conditions.push(`photo_type = $${values.length}`);
  }
  if (filter.ocrStatus) {
    values.push(filter.ocrStatus);
    conditions.push(`ocr_status = $${values.length}`);
  }
  if (filter.reviewStatus) {
    values.push(filter.reviewStatus);
    conditions.push(`review_status = $${values.length}`);
  }
  if (filter.status) {
    values.push(filter.status);
    conditions.push(`status = $${values.length}`);
  }

  const result = await getPool().query<VisitorPhotoRow>(
    `SELECT ${VISITOR_PHOTO_COLUMNS}
     FROM visitor_photos
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC`,
    values,
  );
  return result.rows.map(mapRow);
}

export type VisitorPhotoUpdateColumns = {
  ocrStatus?: VisitorPhotoOcrStatus;
  ocrProvider?: string | null;
  ocrError?: string | null;
  ocrProcessedAt?: string | null;
  extractedFullName?: string | null;
  extractedIdentityType?: VisitorIdentityType | null;
  extractedIdentityNumber?: string | null;
  reviewStatus?: VisitorPhotoReviewStatus;
  reviewedByUserId?: string | null;
  reviewedAt?: string | null;
  status?: VisitorPhotoStatus;
};

export async function update(
  id: string,
  input: VisitorPhotoUpdateColumns,
): Promise<VisitorPhotoRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  const columnMap: [keyof VisitorPhotoUpdateColumns, string][] = [
    ['ocrStatus', 'ocr_status'],
    ['ocrProvider', 'ocr_provider'],
    ['ocrError', 'ocr_error'],
    ['ocrProcessedAt', 'ocr_processed_at'],
    ['extractedFullName', 'extracted_full_name'],
    ['extractedIdentityType', 'extracted_identity_type'],
    ['extractedIdentityNumber', 'extracted_identity_number'],
    ['reviewStatus', 'review_status'],
    ['reviewedByUserId', 'reviewed_by_user_id'],
    ['reviewedAt', 'reviewed_at'],
    ['status', 'status'],
  ];

  for (const [key, column] of columnMap) {
    if (input[key] !== undefined) {
      values.push(input[key]);
      sets.push(`${column} = $${values.length}`);
    }
  }

  if (sets.length === 0) {
    return findById(id);
  }

  values.push(id);
  const result = await getPool().query<VisitorPhotoRow>(
    `UPDATE visitor_photos
     SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $${values.length}
     RETURNING ${VISITOR_PHOTO_COLUMNS}`,
    values,
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export const visitorPhotoRepository = {
  create,
  findById,
  listByVisitor,
  update,
};
