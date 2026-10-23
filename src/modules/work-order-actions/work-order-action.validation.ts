import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';

const MAX_NOTES_LENGTH = 1000;

export type ValidationDetail = {
  field: string;
  message: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseWorkOrderIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'workOrderId',
        message: 'Work order id must be a valid UUID.',
      },
    ]);
  }
  return value.toLowerCase();
}

/** Optional execution-note body: `{ "notes": "...", "assignmentId"?: "..." }`. */
export function parseNotesBody(body: unknown): {
  notes?: string;
  assignmentId?: string;
} {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  let assignmentId: string | undefined;
  if (body.assignmentId !== undefined && body.assignmentId !== null) {
    if (
      typeof body.assignmentId !== 'string' ||
      !isValidUuid(body.assignmentId.trim())
    ) {
      throw AppError.validation('Request validation failed.', [
        { field: 'assignmentId', message: 'assignmentId must be a valid UUID.' },
      ]);
    }
    assignmentId = body.assignmentId.trim().toLowerCase();
  }

  if (body.notes === undefined) {
    return { assignmentId };
  }

  if (typeof body.notes !== 'string') {
    throw AppError.validation('Request validation failed.', [
      { field: 'notes', message: 'notes must be a string.' },
    ]);
  }

  const trimmed = body.notes.trim();
  if (trimmed.length > MAX_NOTES_LENGTH) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'notes',
        message: `notes must be at most ${MAX_NOTES_LENGTH} characters.`,
      },
    ]);
  }

  return { notes: trimmed, assignmentId };
}
