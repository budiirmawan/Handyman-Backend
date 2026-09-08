import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { isBuildingReconciliationUtilityType, type CreateBuildingUtilityReconciliationInput } from './building-utility-reconciliation.types';

type Detail = { field: string; message: string };
const fail = (details: Detail[]): never => { throw AppError.validation('Request validation failed.', details); };
export function parseReconciliationId(raw: string, field = 'id'): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) fail([{ field, message: `${field} must be a valid UUID.` }]);
  return value;
}
export function parseCreateBuildingUtilityReconciliation(
  buildingId: string,
  body: unknown,
): CreateBuildingUtilityReconciliationInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const source = body as Record<string, unknown>;
  const details: Detail[] = [];
  const utilityType = isBuildingReconciliationUtilityType(source.utilityType) ? source.utilityType : undefined;
  if (!utilityType) details.push({ field: 'utilityType', message: 'utilityType must be ELECTRICITY or WATER.' });
  const periodStart = date(source.periodStart, 'periodStart', details);
  const periodEnd = date(source.periodEnd, 'periodEnd', details);
  if (periodStart && periodEnd && periodEnd <= periodStart) details.push({ field: 'periodEnd', message: 'periodEnd must be later than periodStart.' });
  if (!utilityType || !periodStart || !periodEnd || details.length) fail(details);
  return { buildingId, utilityType: utilityType!, periodStart: periodStart!, periodEnd: periodEnd! };
}
function date(value: unknown, field: string, details: Detail[]): Date | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    details.push({ field, message: `${field} must be a valid ISO-8601 timestamp.` });
    return undefined;
  }
  const result = new Date(value);
  if (Number.isNaN(result.getTime())) {
    details.push({ field, message: `${field} must be a valid ISO-8601 timestamp.` });
    return undefined;
  }
  return result;
}
