import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  isVendorVerificationDecision,
  VENDOR_VERIFICATION_DECISIONS,
  type VendorVerificationDecision,
} from './vendor-verification.types';

export type ValidationDetail = {
  field: string;
  message: string;
};

const MAX_NOTES_LENGTH = 4000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseVendorWorkIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'vendorWorkId',
        message: 'Vendor work id must be a valid UUID.',
      },
    ]);
  }
  return value.toLowerCase();
}

/** Parses a verification submission body (`{ decision, notes? }`). */
export function parseVendorVerificationBody(
  body: unknown,
): { decision: VendorVerificationDecision; notes?: string } {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  let decision: VendorVerificationDecision | undefined;
  if (!isVendorVerificationDecision(body.decision)) {
    details.push({
      field: 'decision',
      message: `decision must be one of: ${VENDOR_VERIFICATION_DECISIONS.join(', ')}.`,
    });
  } else {
    decision = body.decision;
  }

  let notes: string | undefined;
  if (body.notes !== undefined && body.notes !== null) {
    if (typeof body.notes !== 'string') {
      details.push({ field: 'notes', message: 'notes must be a string.' });
    } else {
      const trimmed = body.notes.trim();
      if (trimmed === '') {
        notes = undefined;
      } else if (trimmed.length > MAX_NOTES_LENGTH) {
        details.push({
          field: 'notes',
          message: `notes must be at most ${MAX_NOTES_LENGTH} characters.`,
        });
      } else {
        notes = trimmed;
      }
    }
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    decision: decision as VendorVerificationDecision,
    ...(notes === undefined ? {} : { notes }),
  };
}
