import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  isValidRequestType,
  normalizeRequestType,
} from '../work-requests';
import type {
  CreatePermitApprovalInput,
  PermitApprovalDecisionInput,
  PermitApprovalPendingFilters,
} from './permit-approval.types';

type ValidationDetail = { field: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(details: ValidationDetail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

export const parsePermitApprovalIdParam = (raw: string): string =>
  parseId(raw, 'permitApprovalId');
export const parsePermitApprovalApplicationIdParam = (raw: string): string =>
  parseId(raw, 'permitApplicationId');

export function parseCreatePermitApprovalBody(
  body: unknown,
): CreatePermitApprovalInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const details: ValidationDetail[] = [];
  const approvalStage = readCode(
    body.approvalStage,
    'approvalStage',
    details,
  );
  const approvalType = readCode(body.approvalType, 'approvalType', details);
  const approverUserId = readId(
    body.approverUserId,
    'approverUserId',
    true,
    details,
  );
  const notes = readNotes(body.notes, false, details);
  if (!approvalStage || !approvalType || !approverUserId || details.length > 0) {
    fail(details);
  }
  return {
    approvalStage,
    approvalType,
    approverUserId,
    ...(notes !== undefined ? { notes } : {}),
  };
}

export function parsePermitApprovalDecisionBody(
  body: unknown,
  notesRequired: boolean,
): PermitApprovalDecisionInput {
  if (body === undefined || body === null) {
    if (notesRequired) {
      fail([{ field: 'decisionNotes', message: 'decisionNotes is required.' }]);
    }
    return {};
  }
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const details: ValidationDetail[] = [];
  const decisionNotes = readNotes(
    body.decisionNotes ?? body.notes,
    notesRequired,
    details,
  );
  if (details.length > 0) fail(details);
  return decisionNotes === undefined ? {} : { decisionNotes };
}

export function parsePermitApprovalPendingFilters(
  query: unknown,
): PermitApprovalPendingFilters {
  if (!isRecord(query)) return {};
  const details: ValidationDetail[] = [];
  const buildingId = readId(query.buildingId, 'buildingId', false, details);
  const approverUserId = readId(
    query.approverUserId,
    'approverUserId',
    false,
    details,
  );
  const approvalStage = query.approvalStage === undefined
    ? undefined
    : readCode(query.approvalStage, 'approvalStage', details);
  const approvalType = query.approvalType === undefined
    ? undefined
    : readCode(query.approvalType, 'approvalType', details);
  if (details.length > 0) fail(details);
  return {
    ...(buildingId ? { buildingId } : {}),
    ...(approverUserId ? { approverUserId } : {}),
    ...(approvalStage ? { approvalStage } : {}),
    ...(approvalType ? { approvalType } : {}),
  };
}

function parseId(raw: string, field: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) {
    fail([{ field, message: `${field} must be a valid UUID.` }]);
  }
  return value;
}

function readId(
  value: unknown,
  field: string,
  required: boolean,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({
      field,
      message: `${field}${required ? ' is required and' : ''} must be a valid UUID.`,
    });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readCode(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} is required.` });
    return undefined;
  }
  const normalized = normalizeRequestType(value);
  if (!isValidRequestType(normalized)) {
    details.push({ field, message: `${field} must be a valid data-driven code.` });
    return undefined;
  }
  return normalized;
}

function readNotes(
  value: unknown,
  required: boolean,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined || value === null) {
    if (required) {
      details.push({ field: 'decisionNotes', message: 'decisionNotes is required.' });
    }
    return value === null ? null : undefined;
  }
  if (typeof value !== 'string') {
    details.push({ field: 'decisionNotes', message: 'decisionNotes must be a string.' });
    return undefined;
  }
  const result = value.trim();
  if (required && result === '') {
    details.push({ field: 'decisionNotes', message: 'decisionNotes is required.' });
    return undefined;
  }
  if (result.length > 4000) {
    details.push({
      field: 'decisionNotes',
      message: 'decisionNotes must be at most 4000 characters.',
    });
    return undefined;
  }
  return result === '' ? null : result;
}
