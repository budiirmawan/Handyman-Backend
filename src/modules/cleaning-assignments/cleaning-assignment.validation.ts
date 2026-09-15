import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  ASSIGNEE_TYPES,
  isAssigneeType,
  type AssigneeType,
  type CreateCleaningAssignmentInput,
} from './cleaning-assignment.types';

export type ValidationDetail = {
  field: string;
  message: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseDailyCleaningIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'id', message: 'Daily cleaning task id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseWorkforceIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'workforceId', message: 'Workforce profile id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseTeamIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'teamId', message: 'Team id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreateCleaningAssignmentBody(
  body: unknown,
): Omit<CreateCleaningAssignmentInput, 'taskId' | 'assignedByUserId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  let assigneeType: AssigneeType | undefined;
  if (!isAssigneeType(body.assigneeType)) {
    details.push({
      field: 'assigneeType',
      message: `assigneeType must be one of: ${ASSIGNEE_TYPES.join(', ')}.`,
    });
  } else {
    assigneeType = body.assigneeType;
  }

  let workforceProfileId: string | null | undefined;
  if (body.workforceProfileId !== undefined && body.workforceProfileId !== null) {
    if (
      typeof body.workforceProfileId !== 'string' ||
      !isValidUuid(body.workforceProfileId.trim())
    ) {
      details.push({
        field: 'workforceProfileId',
        message: 'workforceProfileId must be a valid UUID.',
      });
    } else {
      workforceProfileId = body.workforceProfileId.trim().toLowerCase();
    }
  }

  let teamId: string | null | undefined;
  if (body.teamId !== undefined && body.teamId !== null) {
    if (typeof body.teamId !== 'string' || !isValidUuid(body.teamId.trim())) {
      details.push({
        field: 'teamId',
        message: 'teamId must be a valid UUID.',
      });
    } else {
      teamId = body.teamId.trim().toLowerCase();
    }
  }

  if (assigneeType === 'WORKFORCE' && !workforceProfileId) {
    details.push({
      field: 'workforceProfileId',
      message: 'workforceProfileId is required when assigneeType is WORKFORCE.',
    });
  }

  if (assigneeType === 'TEAM' && !teamId) {
    details.push({
      field: 'teamId',
      message: 'teamId is required when assigneeType is TEAM.',
    });
  }

  if (details.length > 0 || !assigneeType) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    assigneeType,
    workforceProfileId: workforceProfileId ?? null,
    teamId: teamId ?? null,
  };
}
