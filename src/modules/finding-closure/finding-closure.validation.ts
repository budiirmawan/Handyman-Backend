import { AppError } from '../../shared/errors';

const MAX_NOTES = 2000;
export function parseCloseFindingBody(body: unknown): { closureNotes?: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }
  const value = (body as Record<string, unknown>).closureNotes;
  if (value === undefined || value === null) return {};
  if (typeof value !== 'string') {
    throw AppError.validation('Request validation failed.', [
      { field: 'closureNotes', message: 'closureNotes must be a string.' },
    ]);
  }
  const notes = value.trim();
  if (!notes) return {};
  if (notes.length > MAX_NOTES) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'closureNotes',
        message: `closureNotes must be at most ${MAX_NOTES} characters.`,
      },
    ]);
  }
  return { closureNotes: notes };
}
