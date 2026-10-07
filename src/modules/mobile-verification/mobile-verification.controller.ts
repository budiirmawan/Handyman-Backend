import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../shared/errors';
import { sendSuccess } from '../../shared/api-response';
import { isValidUuid } from '../clients';
import {
  mobileVerificationService,
} from './mobile-verification.service';
import type { SubmitVerificationInput } from './mobile-verification.service';
import { REVIEW_DECISIONS } from '../reviews';
import { MOBILE_VERIFICATION_TARGET_TYPES } from './mobile-verification.types';

/**
 * BE-25J — Mobile supervisor verification handlers.
 *
 *   GET  /mobile/verification/:targetType/:targetId
 *   POST /mobile/verification/:targetType/:targetId   { decision, notes? }
 *
 * targetType ∈ CHECKLIST_EXECUTION | FORM_INSTANCE | FINDING.
 * Per-target-type RBAC (review.* / finding.*) is enforced in the service —
 * the same permissions the existing Web endpoints require.
 */

const param = (value: string | string[]): string =>
  Array.isArray(value) ? '' : value;

function parseTargetType(raw: string): string {
  if (!MOBILE_VERIFICATION_TARGET_TYPES.includes(raw as never)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'targetType',
        message:
          'targetType must be CHECKLIST_EXECUTION, FORM_INSTANCE or FINDING.',
      },
    ]);
  }
  return raw;
}

function parseTargetId(raw: string): string {
  if (!isValidUuid(raw)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'targetId', message: 'targetId must be a valid UUID.' },
    ]);
  }
  return raw;
}

export async function getMobileVerificationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const targetType = parseTargetType(param(req.params.targetType));
    const targetId = parseTargetId(param(req.params.targetId));
    sendSuccess(
      res,
      await mobileVerificationService.getMobileVerification(
        targetType,
        targetId,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function submitMobileVerificationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const targetType = parseTargetType(param(req.params.targetType));
    const targetId = parseTargetId(param(req.params.targetId));

    const body = req.body ?? {};
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw AppError.validation('Request validation failed.', [
        { field: 'body', message: 'Request body must be a JSON object.' },
      ]);
    }
    if (!REVIEW_DECISIONS.includes(body.decision)) {
      throw AppError.validation('Request validation failed.', [
        {
          field: 'decision',
          message: `decision must be one of: ${REVIEW_DECISIONS.join(', ')}.`,
        },
      ]);
    }
    if (body.notes !== undefined && body.notes !== null && typeof body.notes !== 'string') {
      throw AppError.validation('Request validation failed.', [
        { field: 'notes', message: 'notes must be a string.' },
      ]);
    }

    const input: SubmitVerificationInput = {
      decision: body.decision,
      ...(typeof body.notes === 'string' && body.notes.trim()
        ? { notes: body.notes.trim() }
        : {}),
    };

    sendSuccess(
      res,
      await mobileVerificationService.submitMobileVerification(
        targetType,
        targetId,
        req.auth.userId,
        input,
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}
