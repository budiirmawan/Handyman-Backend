/**
 * BE-22G — Document Version.
 * Versions belong to an existing Document, preserve complete history,
 * previous versions must not be overwritten, track current/latest.
 */

export type DocumentVersionRecord = {
  id: string;
  documentId: string;
  versionNumber: number;
  title: string;
  description: string | null;
  fileReference: string | null;
  documentType: string;
  status: string;
  expiryDate: Date | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicDocumentVersion = {
  id: string;
  documentId: string;
  versionNumber: number;
  title: string;
  description: string | null;
  fileReference: string | null;
  documentType: string;
  status: string;
  expiryDate: string | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateDocumentVersionInput = {
  title?: string;
  description?: string | null;
  fileReference?: string | null;
  documentType?: string;
  status?: string;
  expiryDate?: Date | null;
};

export type DocumentVersionFilters = {
  documentId: string;
};
