import { AppError } from '../../shared/errors';

const MAX_ARCHIVE_REASON_LENGTH = 1000;

export function parseArchiveDocumentBody(body: unknown): { reason: string | null } {
  if (body === undefined || body === null) return { reason: null };
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'body must be an object.' },
    ]);
  }
  const input = body as Record<string, unknown>;
  const unknown = Object.keys(input).filter((key) => key !== 'reason');
  const details: { field: string; message: string }[] = unknown.map((field) => ({
    field,
    message: `${field} is not allowed.`,
  }));
  let reason: string | null = null;
  if (input.reason !== undefined && input.reason !== null) {
    if (typeof input.reason !== 'string' || input.reason.trim().length === 0) {
      details.push({ field: 'reason', message: 'reason must be a non-empty string.' });
    } else if (input.reason.trim().length > MAX_ARCHIVE_REASON_LENGTH) {
      details.push({
        field: 'reason',
        message: `reason must be at most ${MAX_ARCHIVE_REASON_LENGTH} characters.`,
      });
    } else {
      reason = input.reason.trim();
    }
  }
  if (details.length > 0) throw AppError.validation('Request validation failed.', details);
  return { reason };
}
