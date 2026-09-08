import { AppError } from '../../shared/errors';

const MAX_TEXT = 2000;
function body(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }
  return value as Record<string, unknown>;
}
function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} is required.` },
    ]);
  }
  const result = value.trim();
  if (result.length > MAX_TEXT) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} must be at most ${MAX_TEXT} characters.` },
    ]);
  }
  return result;
}
export function parseFindingReasonBody(value: unknown): { reason: string } {
  const input = body(value);
  return { reason: requiredText(input.reason, 'reason') };
}
export function parseFindingReworkNotesBody(value: unknown): { notes: string } {
  const input = body(value);
  return { notes: requiredText(input.notes, 'notes') };
}
