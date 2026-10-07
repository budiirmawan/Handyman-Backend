import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';

export function parseDocumentIdParam(raw: string): string {
  const v = raw.trim().toLowerCase();
  if (!isValidUuid(v)) throw AppError.validation('Request validation failed.', [{ field: 'documentId', message: 'Document id must be a valid UUID.' }]);
  return v;
}
export function parseVersionIdParam(raw: string): string {
  const v = raw.trim().toLowerCase();
  if (!isValidUuid(v)) throw AppError.validation('Request validation failed.', [{ field: 'versionId', message: 'Version id must be a valid UUID.' }]);
  return v;
}
export function parseSetExpiryBody(body: unknown): { expiryDate: Date | null } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw AppError.validation('Request validation failed.', [{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const raw = (body as any).expiryDate;
  if (raw === undefined) throw AppError.validation('Request validation failed.', [{ field: 'expiryDate', message: 'expiryDate is required (use null to clear).' }]);
  if (raw === null) return { expiryDate: null };
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw AppError.validation('Request validation failed.', [{ field: 'expiryDate', message: 'expiryDate must be an ISO-8601 date string or null.' }]);
  }
  const d = new Date(raw.trim());
  if (Number.isNaN(d.getTime())) {
    throw AppError.validation('Request validation failed.', [{ field: 'expiryDate', message: 'expiryDate must be a valid date.' }]);
  }
  return { expiryDate: d };
}
