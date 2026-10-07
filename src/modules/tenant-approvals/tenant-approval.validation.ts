import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { isValidRequestType, normalizeRequestType } from '../work-requests';
import {
  TENANT_APPROVAL_REQUEST_TYPES,
  isTenantApprovalRequestType,
  type CreateTenantApprovalInput,
  type TenantApprovalDecisionInput,
  type TenantApprovalPendingFilters,
  type TenantApprovalRequestType,
} from './tenant-approval.types';

type Detail = { field: string; message: string };
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function fail(details: Detail[]): never {
  throw AppError.validation('Request validation failed.', details);
}
export function parseTenantApprovalIdParam(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) fail([{ field: 'tenantApprovalId', message: 'tenantApprovalId must be a valid UUID.' }]);
  return value;
}

export function parseCreateTenantApprovalBody(body: unknown): CreateTenantApprovalInput {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: Detail[] = [];
  const requestType = readRequestType(body.requestType, details);
  const requestId = readId(body.requestId, 'requestId', true, details);
  const approvalType = readApprovalType(body.approvalType, details);
  const approverUserId = readId(body.approverUserId, 'approverUserId', true, details);
  if (!requestType || !requestId || !approvalType || !approverUserId || details.length) fail(details);
  return { requestType, requestId, approvalType, approverUserId };
}

export function parseTenantApprovalDecisionBody(
  body: unknown,
  requireNotes: boolean,
): TenantApprovalDecisionInput {
  if (!isRecord(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: Detail[] = [];
  const decisionNotes = readString(
    body.decisionNotes,
    'decisionNotes',
    1000,
    requireNotes,
    details,
  );
  if (details.length) fail(details);
  return { ...(decisionNotes ? { decisionNotes } : {}) };
}

export function parseTenantApprovalPendingFilters(
  query: unknown,
): TenantApprovalPendingFilters {
  if (!isRecord(query)) return {};
  const details: Detail[] = [];
  const buildingId = readId(query.buildingId, 'buildingId', false, details);
  const tenantCompanyId = readId(query.tenantCompanyId, 'tenantCompanyId', false, details);
  const approverUserId = readId(query.approverUserId, 'approverUserId', false, details);
  const utilityCalculationId = readId(
    query.utilityCalculationId, 'utilityCalculationId', false, details,
  );
  const requestType = query.requestType === undefined
    ? undefined : readRequestType(query.requestType, details);
  const approvalType = query.approvalType === undefined
    ? undefined : readApprovalType(query.approvalType, details);
  if (details.length) fail(details);
  return {
    ...(buildingId ? { buildingId } : {}),
    ...(tenantCompanyId ? { tenantCompanyId } : {}),
    ...(approverUserId ? { approverUserId } : {}),
    ...(requestType ? { requestType } : {}),
    ...(approvalType ? { approvalType } : {}),
    ...(utilityCalculationId ? { utilityCalculationId } : {}),
  };
}

function readId(
  value: unknown,
  field: string,
  required: boolean,
  details: Detail[],
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${field} ${required ? 'is required and ' : ''}must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}
function readRequestType(value: unknown, details: Detail[]): TenantApprovalRequestType | undefined {
  if (!isTenantApprovalRequestType(value)) {
    details.push({ field: 'requestType', message: `requestType must be one of: ${TENANT_APPROVAL_REQUEST_TYPES.join(', ')}.` });
    return undefined;
  }
  return value;
}
function readApprovalType(value: unknown, details: Detail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'approvalType', message: 'approvalType is required.' });
    return undefined;
  }
  const result = normalizeRequestType(value);
  if (!isValidRequestType(result)) {
    details.push({ field: 'approvalType', message: 'approvalType must be a valid data-driven code.' });
    return undefined;
  }
  return result;
}
function readString(
  value: unknown,
  field: string,
  max: number,
  required: boolean,
  details: Detail[],
): string | undefined {
  if ((value === undefined || value === null || value === '') && !required) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    details.push({ field, message: `${field} is required.` });
    return undefined;
  }
  const result = value.trim();
  if (result.length > max) {
    details.push({ field, message: `${field} must be at most ${max} characters.` });
    return undefined;
  }
  return result;
}
