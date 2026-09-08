import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  isUtilityVerificationDecision,
  UTILITY_VERIFICATION_DECISIONS,
  type UtilityVerificationDecision,
} from './utility-verification.types';

/** BE-18K — request validation for Utility Verification. */

export type ValidationDetail = {
  field: string;
  message: string;
};

const MAX_NOTES_LENGTH = 4000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseAbnormalConsumptionIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'abnormalConsumptionId',
        message: 'Abnormal consumption id must be a valid UUID.',
      },
    ]);
  }
  return value.toLowerCase();
}

function parseNotes(
  body: Record<string, unknown>,
  details: ValidationDetail[],
): string | undefined {
  if (body.notes === undefined || body.notes === null) {
    return undefined;
  }
  if (typeof body.notes !== 'string') {
    details.push({ field: 'notes', message: 'notes must be a string.' });
    return undefined;
  }
  const trimmed = body.notes.trim();
  if (trimmed.length > MAX_NOTES_LENGTH) {
    details.push({
      field: 'notes',
      message: `notes must be at most ${MAX_NOTES_LENGTH} characters.`,
    });
    return undefined;
  }
  return trimmed.length > 0 ? trimmed : undefined;
}

export type OpenUtilityVerificationBody = {
  reviewerUserId?: string;
  notes?: string;
};

/**
 * Parses an open-review body (`{ reviewerUserId?, notes? }`). The reviewer
 * defaults to the caller; naming someone else assigns the review to them.
 */
export function parseOpenUtilityVerificationBody(
  body: unknown,
): OpenUtilityVerificationBody {
  if (body === undefined || body === null) {
    return {};
  }
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  let reviewerUserId: string | undefined;
  if (body.reviewerUserId !== undefined && body.reviewerUserId !== null) {
    if (
      typeof body.reviewerUserId !== 'string' ||
      !isValidUuid(body.reviewerUserId.trim())
    ) {
      details.push({
        field: 'reviewerUserId',
        message: 'reviewerUserId must be a valid UUID.',
      });
    } else {
      reviewerUserId = body.reviewerUserId.trim().toLowerCase();
    }
  }

  const notes = parseNotes(body, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(reviewerUserId ? { reviewerUserId } : {}),
    ...(notes ? { notes } : {}),
  };
}

export type SubmitUtilityVerificationBody = {
  decision: UtilityVerificationDecision;
  notes?: string;
};

/** Parses a verification submission body (`{ decision, notes? }`). */
export function parseSubmitUtilityVerificationBody(
  body: unknown,
): SubmitUtilityVerificationBody {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  let decision: UtilityVerificationDecision | undefined;
  if (!isUtilityVerificationDecision(body.decision)) {
    details.push({
      field: 'decision',
      message: `decision must be one of: ${UTILITY_VERIFICATION_DECISIONS.join(', ')}.`,
    });
  } else {
    decision = body.decision;
  }

  const notes = parseNotes(body, details);

  if (details.length > 0 || !decision) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    decision,
    ...(notes ? { notes } : {}),
  };
}
