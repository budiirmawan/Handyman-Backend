/**
 * BE-22H — Expiry.
 * Expiry belongs to valid Document/version, tracks expiry date and derived state.
 */

export type ExpiryState = 'ACTIVE' | 'EXPIRING' | 'EXPIRED';

export type DocumentExpiryRecord = {
  documentId: string;
  versionId?: string | null;
  expiryDate: Date | null;
  expiryState: ExpiryState;
};

export type PublicDocumentExpiry = {
  documentId: string;
  versionId?: string | null;
  expiryDate: string | null;
  expiryState: ExpiryState;
  clientId?: string;
  buildingId?: string | null;
};

export type SetExpiryInput = {
  expiryDate: Date | null;
};
