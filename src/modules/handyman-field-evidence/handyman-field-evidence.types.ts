export const HANDYMAN_FIELD_EVIDENCE_PURPOSES = [
  'VARIATION_FINDING',
  'MATERIAL_RECEIPT',
  'INSPECTION_EVIDENCE',
  'BEFORE_AFTER_WORK',
  'QC_EVIDENCE',
] as const;
export type HandymanFieldEvidencePurpose =
  (typeof HANDYMAN_FIELD_EVIDENCE_PURPOSES)[number];

export const HANDYMAN_FIELD_EVIDENCE_UPLOAD_STATUSES = [
  'PENDING_BYTES',
  'STAGED_BYTES',
  'VERIFIED',
] as const;
export type HandymanFieldEvidenceUploadStatus =
  (typeof HANDYMAN_FIELD_EVIDENCE_UPLOAD_STATUSES)[number];

export const HANDYMAN_FIELD_EVIDENCE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const;
export type HandymanFieldEvidenceMimeType =
  (typeof HANDYMAN_FIELD_EVIDENCE_MIME_TYPES)[number];

export const HANDYMAN_FIELD_EVIDENCE_MAX_BYTES = 15 * 1024 * 1024; // 15 MB

export interface HandymanFieldEvidenceUploadRecord {
  id: string;
  clientId: string;
  tenantCompanyId: string;
  buildingId: string;
  handymanRequestId: string;
  executionScopeId: string | null;
  /** CR-HM-MOBILE-EVIDENCE-E2E-01 PART 01A-BE — authoritative Work Session
   * binding for execution-photo submissions; null for historical and
   * non-session evidence (arrival/inspection, pre-session uploads). */
  workSessionId: string | null;
  variationId: string | null;
  materialPurchaseRecordId: string | null;
  purpose: HandymanFieldEvidencePurpose;
  uploadStatus: HandymanFieldEvidenceUploadStatus;
  uploadCompleted: boolean;
  originalFileName: string;
  mimeType: HandymanFieldEvidenceMimeType;
  storageKey: string;
  declaredByteSize: number | null;
  verifiedByteSize: number;
  sha256Checksum: string | null;
  attachmentReference: string | null;
  downloadPath: string | null;
  previewPath: string | null;
  uploadedByUserId: string;
  uploadedByRole: 'PIC_PEKERJAAN' | 'INSPECTOR' | 'OPERATIONS_MANAGER';
  notes: string | null;
  idempotencyKey: string;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
