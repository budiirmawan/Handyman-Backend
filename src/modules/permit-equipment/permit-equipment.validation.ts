import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  isPermitContractorContextType,
  type PermitContractorContextType,
} from '../permits/permit.types';
import {
  PERMIT_EQUIPMENT_STATUSES,
  isPermitEquipmentStatus,
  type AddPermitEquipmentInput,
  type PermitEquipmentFilters,
  type PermitEquipmentStatus,
  type UpdatePermitEquipmentInput,
} from './permit-equipment.types';

type ValidationDetail = { field: string; message: string };
const ISO_TIMESTAMP_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function fail(details: ValidationDetail[]): never {
  throw AppError.validation('Request validation failed.', details);
}
export const parsePermitEquipmentIdParam = (raw: string): string =>
  parseId(raw, 'permitEquipmentId');
export const parsePermitEquipmentPermitIdParam = (raw: string): string =>
  parseId(raw, 'permitId');

export function parseAddPermitEquipmentBody(body: unknown): AddPermitEquipmentInput {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const controlled = [
    'equipmentName', 'equipmentType', 'identifierReference', 'status',
    'deactivatedAt', 'deactivatedByUserId', 'createdByUserId', 'createdAt',
    'updatedAt',
  ].find((field) => body[field] !== undefined);
  if (controlled) fail([{ field: controlled, message: 'This Equipment field is backend-resolved.' }]);
  const details: ValidationDetail[] = [];
  const permitApplicationId = readId(body.permitApplicationId, 'permitApplicationId', true, details);
  const buildingId = readId(body.buildingId, 'buildingId', true, details);
  const contractorContextType = readContractorType(body.contractorContextType, true, details);
  const contractorContextId = readId(body.contractorContextId, 'contractorContextId', true, details);
  const assetId = readId(body.assetId ?? body.equipmentAssetReference, 'assetId', true, details);
  const equipmentProfileId = readId(body.equipmentProfileId, 'equipmentProfileId', false, details);
  const assetIdentifierId = readId(body.assetIdentifierId, 'assetIdentifierId', false, details);
  const assetCertificationId = readId(body.assetCertificationId, 'assetCertificationId', false, details);
  const inspectionBindingId = readId(body.inspectionBindingId, 'inspectionBindingId', false, details);
  const inspectionExecutionId = readId(body.inspectionExecutionId, 'inspectionExecutionId', false, details);
  const validFrom = readTimestamp(body.validFrom, 'validFrom', false, details);
  const validUntil = readTimestamp(body.validUntil, 'validUntil', false, details);
  const notes = readNullableText(body.notes, 'notes', 2000, details);
  if ((inspectionBindingId === undefined) !== (inspectionExecutionId === undefined)) {
    details.push({ field: 'inspection', message: 'inspectionBindingId and inspectionExecutionId must be supplied together.' });
  }
  if (validFrom && validUntil && validUntil <= validFrom) {
    details.push({ field: 'validUntil', message: 'validUntil must be after validFrom.' });
  }
  if (!permitApplicationId || !buildingId || !contractorContextType ||
      !contractorContextId || !assetId || details.length) fail(details);
  return {
    permitApplicationId,
    buildingId,
    contractorContextType,
    contractorContextId,
    assetId,
    ...(equipmentProfileId ? { equipmentProfileId } : {}),
    ...(assetIdentifierId ? { assetIdentifierId } : {}),
    ...(assetCertificationId ? { assetCertificationId } : {}),
    ...(inspectionBindingId ? { inspectionBindingId } : {}),
    ...(inspectionExecutionId ? { inspectionExecutionId } : {}),
    ...(validFrom ? { validFrom } : {}),
    ...(validUntil ? { validUntil } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
}

export function parseUpdatePermitEquipmentBody(body: unknown): UpdatePermitEquipmentInput {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const immutable = [
    'permitId', 'permitApplicationId', 'buildingId', 'contractorContextType',
    'contractorContextId', 'contractorVendorId', 'assetId',
    'equipmentProfileId', 'status', 'deactivatedAt', 'deactivatedByUserId',
  ].find((field) => body[field] !== undefined);
  if (immutable) fail([{ field: immutable, message: 'This Equipment context field is immutable.' }]);
  const details: ValidationDetail[] = [];
  const assetIdentifierId = readNullableId(body.assetIdentifierId, 'assetIdentifierId', details);
  const assetCertificationId = readNullableId(body.assetCertificationId, 'assetCertificationId', details);
  const inspectionBindingId = readNullableId(body.inspectionBindingId, 'inspectionBindingId', details);
  const inspectionExecutionId = readNullableId(body.inspectionExecutionId, 'inspectionExecutionId', details);
  const validFrom = readTimestamp(body.validFrom, 'validFrom', false, details);
  const validUntil = readTimestamp(body.validUntil, 'validUntil', false, details);
  const notes = readNullableText(body.notes, 'notes', 2000, details);
  const parsed: UpdatePermitEquipmentInput = {
    ...(assetIdentifierId !== undefined ? { assetIdentifierId } : {}),
    ...(assetCertificationId !== undefined ? { assetCertificationId } : {}),
    ...(inspectionBindingId !== undefined ? { inspectionBindingId } : {}),
    ...(inspectionExecutionId !== undefined ? { inspectionExecutionId } : {}),
    ...(validFrom ? { validFrom } : {}),
    ...(validUntil ? { validUntil } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
  if (!Object.keys(parsed).length && !details.length) details.push({ field: 'body', message: 'At least one Equipment field is required.' });
  if (details.length) fail(details);
  return parsed;
}

export function parsePermitEquipmentFilters(query: unknown): PermitEquipmentFilters {
  if (!isRecord(query)) return {};
  const details: ValidationDetail[] = [];
  const permitId = readId(query.permitId, 'permitId', false, details);
  const permitApplicationId = readId(query.permitApplicationId, 'permitApplicationId', false, details);
  const buildingId = readId(query.buildingId, 'buildingId', false, details);
  const contractorContextType = readContractorType(query.contractorContextType ?? query.sourceType, false, details);
  const contractorContextId = readId(query.contractorContextId, 'contractorContextId', false, details);
  const contractorVendorId = readId(query.contractorVendorId ?? query.contractorId, 'contractorVendorId', false, details);
  const assetId = readId(query.assetId, 'assetId', false, details);
  const status = readStatus(query.status, details);
  if (details.length) fail(details);
  return {
    ...(permitId ? { permitId } : {}),
    ...(permitApplicationId ? { permitApplicationId } : {}),
    ...(buildingId ? { buildingId } : {}),
    ...(contractorContextType ? { contractorContextType } : {}),
    ...(contractorContextId ? { contractorContextId } : {}),
    ...(contractorVendorId ? { contractorVendorId } : {}),
    ...(assetId ? { assetId } : {}),
    ...(status ? { status } : {}),
  };
}

function parseId(raw: string, field: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) fail([{ field, message: `${field} must be a valid UUID.` }]);
  return value;
}
function readId(value: unknown, field: string, required: boolean, details: ValidationDetail[]): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${field}${required ? ' is required and' : ''} must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}
function readNullableId(value: unknown, field: string, details: ValidationDetail[]): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return readId(value, field, true, details);
}
function readContractorType(value: unknown, required: boolean, details: ValidationDetail[]): PermitContractorContextType | undefined {
  if (value === undefined && !required) return undefined;
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : value;
  if (!isPermitContractorContextType(normalized)) {
    details.push({ field: 'contractorContextType', message: 'contractorContextType must be TENANT_CONTRACTOR or VENDOR_CONTRACTOR.' });
    return undefined;
  }
  return normalized;
}
function readTimestamp(value: unknown, field: string, required: boolean, details: ValidationDetail[]): Date | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !ISO_TIMESTAMP_WITH_ZONE.test(value.trim())) {
    details.push({ field, message: `${field} must be an ISO-8601 date-time with a timezone.` });
    return undefined;
  }
  const parsed = new Date(value.trim());
  if (Number.isNaN(parsed.getTime())) {
    details.push({ field, message: `${field} must be valid.` });
    return undefined;
  }
  return parsed;
}
function readStatus(value: unknown, details: ValidationDetail[]): PermitEquipmentStatus | undefined {
  if (value === undefined) return undefined;
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : value;
  if (!isPermitEquipmentStatus(normalized)) {
    details.push({ field: 'status', message: `status must be one of: ${PERMIT_EQUIPMENT_STATUSES.join(', ')}.` });
    return undefined;
  }
  return normalized;
}
function readNullableText(value: unknown, field: string, maxLength: number, details: ValidationDetail[]): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a string or null.` });
    return undefined;
  }
  const result = value.trim();
  if (!result) return null;
  if (result.length > maxLength) {
    details.push({ field, message: `${field} is too long.` });
    return undefined;
  }
  return result;
}
