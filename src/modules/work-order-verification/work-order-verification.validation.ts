import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  isWorkOrderVerificationDecision,
  WORK_ORDER_VERIFICATION_DECISIONS,
  type SubmitWorkOrderVerificationInput,
  type WorkOrderVerificationDecision,
} from './work-order-verification.types';

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

export function parseVerificationBody(
  body: unknown,
): Omit<SubmitWorkOrderVerificationInput, 'workOrderId' | 'reviewerUserId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const decision = readDecision(body.decision, []);
  if (!decision) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'decision',
        message: `Decision must be one of: ${WORK_ORDER_VERIFICATION_DECISIONS.join(', ')}.`,
      },
    ]);
  }

  const notes = readNotes(body.notes);

  return {
    decision,
    ...(notes === undefined ? {} : { notes }),
  };
}

function readDecision(
  value: unknown,
  _details: ValidationDetail[],
): WorkOrderVerificationDecision | undefined {
  if (!isWorkOrderVerificationDecision(value)) {
    return undefined;
  }
  return value;
}

function readNotes(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw AppError.validation('Request validation failed.', [
      { field: 'notes', message: 'notes must be a string.' },
    ]);
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }
  if (trimmed.length > MAX_NOTES_LENGTH) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'notes',
        message: `notes must be at most ${MAX_NOTES_LENGTH} characters.`,
      },
    ]);
  }
  return trimmed;
}
