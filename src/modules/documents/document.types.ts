/**
 * BE-22A — Document Foundation.
 *
 * ONE shared Document foundation for INTERNAL, TENANT and VENDOR.
 * No separate engines. Reuses file reference convention (opaque pointer).
 * History preserved via operational_events; archive/version/expiry/approval
 * deferred to later BE-22 parts.
 */

export const DOCUMENT_STATUSES = ['DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export function isDocumentStatus(value: unknown): value is DocumentStatus {
  return (
    typeof value === 'string' &&
    (DOCUMENT_STATUSES as readonly string[]).includes(value)
  );
}

export const DOCUMENT_CONTEXT_TYPES = ['INTERNAL', 'TENANT', 'VENDOR'] as const;
export type DocumentContextType = (typeof DOCUMENT_CONTEXT_TYPES)[number];

export function isDocumentContextType(
  value: unknown,
): value is DocumentContextType {
  return (
    typeof value === 'string' &&
    (DOCUMENT_CONTEXT_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Source type clarifies the originating entity within a context.
 * Minimal set for BE-22A:
 *  - TENANT → TENANT_COMPANY
 *  - VENDOR → VENDOR
 *  - INTERNAL → no source or INTERNAL (optional)
 * Validation enforces allowed combinations and cross-client checks.
 */
export const DOCUMENT_SOURCE_TYPES = [
  'TENANT_COMPANY',
  'VENDOR',
  'INTERNAL',
] as const;
export type DocumentSourceType = (typeof DOCUMENT_SOURCE_TYPES)[number];

export function isDocumentSourceType(
  value: unknown,
): value is DocumentSourceType {
  return (
    typeof value === 'string' &&
    (DOCUMENT_SOURCE_TYPES as readonly string[]).includes(value)
  );
}

export type DocumentRecord = {
  id: string;
  clientId: string;
  buildingId: string | null;
  documentNumber: string;
  documentType: string;
  contextType: DocumentContextType;
  sourceType: DocumentSourceType | null;
  sourceId: string | null;
  title: string;
  description: string | null;
  fileReference: string | null;
  status: DocumentStatus;
  expiryDate: Date | null;
  archivedAt: Date | null;
  archivedByUserId: string | null;
  archiveReason: string | null;
  statusBeforeArchive: Exclude<DocumentStatus, 'ARCHIVED'> | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicDocument = {
  id: string;
  clientId: string;
  buildingId: string | null;
  documentNumber: string;
  documentType: string;
  contextType: DocumentContextType;
  sourceType: DocumentSourceType | null;
  sourceId: string | null;
  title: string;
  description: string | null;
  fileReference: string | null;
  status: DocumentStatus;
  expiryDate: string | null;
  archivedAt: string | null;
  archivedByUserId: string | null;
  archiveReason: string | null;
  statusBeforeArchive: Exclude<DocumentStatus, 'ARCHIVED'> | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateDocumentInput = {
  clientId: string;
  buildingId?: string | null;
  documentNumber: string;
  documentType: string;
  contextType: DocumentContextType;
  sourceType?: DocumentSourceType | null;
  sourceId?: string | null;
  title: string;
  description?: string | null;
  fileReference?: string | null;
  status?: DocumentStatus;
  expiryDate?: Date | null;
};

export type NewDocument = {
  clientId: string;
  buildingId: string | null;
  documentNumber: string;
  documentType: string;
  contextType: DocumentContextType;
  sourceType: DocumentSourceType | null;
  sourceId: string | null;
  title: string;
  description: string | null;
  fileReference: string | null;
  status: DocumentStatus;
  expiryDate: Date | null;
  createdByUserId: string;
};

export type UpdateDocumentInput = {
  documentType?: string;
  title?: string;
  description?: string | null;
  fileReference?: string | null;
  status?: DocumentStatus;
  buildingId?: string | null;
  expiryDate?: Date | null;
};

export type DocumentFilters = {
  documentType?: string;
  contextType?: DocumentContextType;
  buildingId?: string;
  status?: DocumentStatus;
  clientId?: string;
};
