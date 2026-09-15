/**
 * BE-13E — Visitor Photo / OCR Readiness domain types.
 *
 * Photo-evidence and OCR-readiness rows attached to the shared BE-13A
 * visitor identity. Follows the BE-07 evidence convention: safe file
 * REFERENCES + metadata only — no image binaries in PostgreSQL, no
 * custom OCR/AI engine (only request/result metadata from an external
 * processor).
 *
 * OCR lifecycle (metadata only, backend-authoritative):
 *   NOT_REQUESTED → PENDING → PROCESSED | FAILED
 *
 * Review boundary: extracted identity fields are STAGED on the photo
 * row and never silently applied to the authoritative visitor master.
 * An explicit review action is required:
 *   UNREVIEWED → APPLIED (routes through the BE-13A service) |
 *                REJECTED
 */

import type { VisitorIdentityType } from '../visitors';

export const VISITOR_PHOTO_TYPES = [
  'VISITOR_PHOTO',
  'IDENTITY_DOCUMENT',
] as const;

export type VisitorPhotoType = (typeof VISITOR_PHOTO_TYPES)[number];

export function isVisitorPhotoType(
  value: unknown,
): value is VisitorPhotoType {
  return (
    typeof value === 'string' &&
    (VISITOR_PHOTO_TYPES as readonly string[]).includes(value)
  );
}

export const VISITOR_PHOTO_OCR_STATUSES = [
  'NOT_REQUESTED',
  'PENDING',
  'PROCESSED',
  'FAILED',
] as const;

export type VisitorPhotoOcrStatus =
  (typeof VISITOR_PHOTO_OCR_STATUSES)[number];

export function isVisitorPhotoOcrStatus(
  value: unknown,
): value is VisitorPhotoOcrStatus {
  return (
    typeof value === 'string' &&
    (VISITOR_PHOTO_OCR_STATUSES as readonly string[]).includes(value)
  );
}

export const VISITOR_PHOTO_REVIEW_STATUSES = [
  'UNREVIEWED',
  'APPLIED',
  'REJECTED',
] as const;

export type VisitorPhotoReviewStatus =
  (typeof VISITOR_PHOTO_REVIEW_STATUSES)[number];

export function isVisitorPhotoReviewStatus(
  value: unknown,
): value is VisitorPhotoReviewStatus {
  return (
    typeof value === 'string' &&
    (VISITOR_PHOTO_REVIEW_STATUSES as readonly string[]).includes(value)
  );
}

export const VISITOR_PHOTO_STATUSES = ['ACTIVE', 'REMOVED'] as const;

export type VisitorPhotoStatus = (typeof VISITOR_PHOTO_STATUSES)[number];

export function isVisitorPhotoStatus(
  value: unknown,
): value is VisitorPhotoStatus {
  return (
    typeof value === 'string' &&
    (VISITOR_PHOTO_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type VisitorPhotoRecord = {
  id: string;
  clientId: string;
  visitorId: string;
  photoType: VisitorPhotoType;
  fileReference: string;
  originalFileName: string;
  mimeType: string;
  fileSize: number;
  capturedAt: Date | null;
  ocrStatus: VisitorPhotoOcrStatus;
  ocrProvider: string | null;
  ocrError: string | null;
  ocrProcessedAt: Date | null;
  extractedFullName: string | null;
  extractedIdentityType: VisitorIdentityType | null;
  extractedIdentityNumber: string | null;
  reviewStatus: VisitorPhotoReviewStatus;
  reviewedByUserId: string | null;
  reviewedAt: Date | null;
  status: VisitorPhotoStatus;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicVisitorPhoto = {
  id: string;
  clientId: string;
  visitorId: string;
  photoType: VisitorPhotoType;
  fileReference: string;
  originalFileName: string;
  mimeType: string;
  fileSize: number;
  capturedAt: string | null;
  ocrStatus: VisitorPhotoOcrStatus;
  ocrProvider: string | null;
  ocrError: string | null;
  ocrProcessedAt: string | null;
  extractedFullName: string | null;
  extractedIdentityType: VisitorIdentityType | null;
  extractedIdentityNumber: string | null;
  reviewStatus: VisitorPhotoReviewStatus;
  reviewedByUserId: string | null;
  reviewedAt: string | null;
  status: VisitorPhotoStatus;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateVisitorPhotoInput = {
  visitorId: string;
  photoType: VisitorPhotoType;
  fileReference: string;
  originalFileName: string;
  mimeType: string;
  fileSize: number;
  /** ISO timestamp. */
  capturedAt?: string | null;
  /** Marks the photo as queued for external OCR at attach time. */
  requestOcr?: boolean;
  ocrProvider?: string | null;
  createdByUserId: string;
};

/**
 * External OCR result metadata. PROCESSED carries extracted fields;
 * FAILED carries the error text. Never touches the visitor master.
 */
export type RecordVisitorPhotoOcrResultInput = {
  ocrStatus: 'PENDING' | 'PROCESSED' | 'FAILED';
  ocrProvider?: string | null;
  ocrError?: string | null;
  /** ISO timestamp; defaults to now for PROCESSED / FAILED. */
  ocrProcessedAt?: string | null;
  extractedFullName?: string | null;
  extractedIdentityType?: VisitorIdentityType | null;
  extractedIdentityNumber?: string | null;
};

/** Explicit review decision over staged OCR output. */
export type ReviewVisitorPhotoInput = {
  decision: 'APPLY' | 'REJECT';
  /**
   * Optional subset of extracted fields to apply (APPLY only). When
   * omitted, all non-null staged fields are applied.
   */
  applyFullName?: boolean;
  applyIdentity?: boolean;
};

export type VisitorPhotoListFilters = {
  photoType?: VisitorPhotoType;
  ocrStatus?: VisitorPhotoOcrStatus;
  reviewStatus?: VisitorPhotoReviewStatus;
  status?: VisitorPhotoStatus;
};
