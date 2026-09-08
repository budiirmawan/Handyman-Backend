import { AppError } from '../../shared/errors';
import { REVIEW_DECISIONS, isReviewDecision } from '../reviews';
import type { ReviewDecision } from '../reviews';

const MAX_NOTES = 1000;
type Body = Record<string, unknown>;
function parseBody(body: unknown): Body {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }
  return body as Body;
}
function notes(value: unknown): string | undefined {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string') {
    throw AppError.validation('Request validation failed.', [
      { field: 'notes', message: 'notes must be a string.' },
    ]);
  }
  const result = value.trim();
  if (!result) return;
  if (result.length > MAX_NOTES) {
    throw AppError.validation('Request validation failed.', [
      { field: 'notes', message: `notes must be at most ${MAX_NOTES} characters.` },
    ]);
  }
  return result;
}
export function parseOpenFindingReviewBody(body: unknown): { notes?: string } {
  const value = parseBody(body);
  const parsedNotes = notes(value.notes);
  return parsedNotes ? { notes: parsedNotes } : {};
}
export function parseFindingVerificationBody(body: unknown): {
  decision: ReviewDecision;
  notes?: string;
} {
  const value = parseBody(body);
  if (!isReviewDecision(value.decision)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'decision', message: `Decision must be one of: ${REVIEW_DECISIONS.join(', ')}.` },
    ]);
  }
  const parsedNotes = notes(value.notes);
  return { decision: value.decision, ...(parsedNotes ? { notes: parsedNotes } : {}) };
}
