import { AppError, ERROR_CODES } from '../../shared/errors';
export const RESIDENT_CHANNELS = ['WALK_IN','WHATSAPP','EMAIL','PHONE','OTHER'] as const;
export type ResidentChannel = (typeof RESIDENT_CHANNELS)[number];
export function careQuoteConflict() {
  return new AppError({ code: ERROR_CODES.HANDYMAN_CARE_QUOTATION_CONFLICT, statusCode: 409,
    message: 'Quotation assistance is stale, already used, or lacks a current explicit PIC binding.' });
}
export function careQuoteNotFound() {
  return new AppError({ code: ERROR_CODES.HANDYMAN_CARE_WORKSPACE_RESOURCE_NOT_FOUND, statusCode: 404,
    message: 'Care workspace resource not found.' });
}
export function assistanceUuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw AppError.validation('A valid UUID is required.');
  }
  return value.toLowerCase();
}
export function residentChannel(value: unknown): ResidentChannel {
  if (typeof value !== 'string' || !(RESIDENT_CHANNELS as readonly string[]).includes(value)) {
    throw AppError.validation('Channel must be WALK_IN, WHATSAPP, EMAIL, PHONE or OTHER.');
  }
  return value as ResidentChannel;
}
export function assistanceObject(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) {
    throw AppError.validation('Unexpected quotation assistance fields.');
  }
  return value as Record<string, unknown>;
}
export function assistanceSelection(query: unknown, pagination = false) {
  const q = assistanceObject(query, ['propertyId','tenantCompanyId','buildingId','spaceId', ...(pagination ? ['afterVersionId','limit'] : [])]);
  const limit = q.limit === undefined ? 25 : Number(q.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw AppError.validation('limit must be 1-100.');
  return { propertyId: assistanceUuid(q.propertyId), tenantCompanyId: assistanceUuid(q.tenantCompanyId),
    buildingId: assistanceUuid(q.buildingId), spaceId: q.spaceId === undefined ? null : assistanceUuid(q.spaceId),
    afterVersionId: q.afterVersionId === undefined ? null : assistanceUuid(q.afterVersionId), limit };
}
export async function assistanceWrite<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) {
    const e = error as { code?: string; constraint?: string };
    if ((e.code === '23505' && e.constraint?.startsWith('handyman_care_quotation_')) || e.constraint === 'handyman_care_quotation_conflict') throw careQuoteConflict();
    throw error;
  }
}
