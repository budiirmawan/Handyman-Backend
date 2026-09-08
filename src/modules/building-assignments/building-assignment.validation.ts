import { AppError } from '../../shared/errors';
import { isValidUuid, parseUserIdParam } from '../users';
import { parseBuildingIdParam } from '../buildings';
import type { CreateUserBuildingAssignmentInput } from './building-assignment.types';

export type ValidationDetail = {
  field: string;
  message: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseAssignmentUserIdParam(raw: string): string {
  return parseUserIdParam(raw);
}

export function parseAssignmentBuildingIdParam(raw: string): string {
  return parseBuildingIdParam(raw);
}

export function parseCreateAssignmentBody(
  body: unknown,
): CreateUserBuildingAssignmentInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const rawBuildingId =
    typeof body.buildingId === 'string' ? body.buildingId.trim() : '';

  if (!isValidUuid(rawBuildingId)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'buildingId', message: 'buildingId is required and must be a valid UUID.' },
    ]);
  }

  return { buildingId: rawBuildingId.toLowerCase() };
}
