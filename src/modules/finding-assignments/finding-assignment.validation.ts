import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  FINDING_ASSIGNEE_TYPES,
  isFindingAssigneeType,
  type AssignFindingInput,
  type FindingAssigneeType,
} from './finding-assignment.types';

type Detail = { field: string; message: string };
type AssignmentBody = Omit<AssignFindingInput, 'findingId' | 'assignedByUserId'>;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
function fail(details: Detail[]): never {
  throw AppError.validation('Request validation failed.', details);
}
export function parseFindingAssignmentIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) fail([{ field: 'assignmentId', message: 'Assignment id must be a valid UUID.' }]);
  return value.toLowerCase();
}
export function parseAssignFindingBody(body: unknown): AssignmentBody {
  if (!record(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  const details: Detail[] = [];
  const assigneeType = readType(body.assigneeType, details);
  const workforceProfileId = readUuid(body.workforceProfileId, 'workforceProfileId', details);
  const teamId = readUuid(body.teamId, 'teamId', details);
  const vendorId = readUuid(body.vendorId, 'vendorId', details);
  if (assigneeType === 'WORKFORCE' && !workforceProfileId) required('workforceProfileId', assigneeType, details);
  if (assigneeType === 'TEAM' && !teamId) required('teamId', assigneeType, details);
  if (assigneeType === 'VENDOR' && !vendorId) required('vendorId', assigneeType, details);
  if (assigneeType === 'VENDOR_WORKFORCE') {
    if (!vendorId) required('vendorId', assigneeType, details);
    if (!workforceProfileId) required('workforceProfileId', assigneeType, details);
  }
  if (!assigneeType || details.length) fail(details);
  return {
    assigneeType,
    ...(workforceProfileId ? { workforceProfileId } : {}),
    ...(teamId ? { teamId } : {}),
    ...(vendorId ? { vendorId } : {}),
  };
}
export function parseUpdateFindingAssignmentBody(
  body: unknown,
): { deactivate: true } | { reassign: AssignmentBody } {
  if (!record(body)) fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  if (body.status !== undefined) {
    if (body.status !== 'INACTIVE') {
      fail([{ field: 'status', message: 'Assignment status update must be INACTIVE.' }]);
    }
    return { deactivate: true };
  }
  return { reassign: parseAssignFindingBody(body) };
}
function readType(value: unknown, details: Detail[]): FindingAssigneeType | undefined {
  if (!isFindingAssigneeType(value)) {
    details.push({ field: 'assigneeType', message: `Assignee type must be one of: ${FINDING_ASSIGNEE_TYPES.join(', ')}.` });
    return;
  }
  return value;
}
function readUuid(value: unknown, field: string, details: Detail[]): string | undefined {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return;
  }
  return value.trim().toLowerCase();
}
function required(field: string, type: FindingAssigneeType, details: Detail[]): void {
  details.push({ field, message: `${field} is required for a ${type} assignment.` });
}
