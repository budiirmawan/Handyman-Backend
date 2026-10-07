import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { correctiveActionVerificationService } from './corrective-action-verification.service';
import {
  parseCorrectiveActionIdParam,
  parseOpenVerificationBody,
  parseSubmitVerificationBody,
  parseVerificationFilters,
} from './corrective-action-verification.validation';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

/** BE-21J — the backend's authoritative verification context. */
export async function getVerificationContextHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await correctiveActionVerificationService.getVerificationContext(
        parseCorrectiveActionIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function openVerificationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { notes } = parseOpenVerificationBody(req.body);
    sendSuccess(
      res,
      await correctiveActionVerificationService.openVerification({
        correctiveActionId: parseCorrectiveActionIdParam(param(req.params.id)),
        // The reviewer is the authenticated actor, never a claimed id.
        reviewerUserId: actor(req),
        ...(notes !== undefined ? { notes } : {}),
      }),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function submitVerificationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = parseSubmitVerificationBody(req.body);
    sendSuccess(
      res,
      await correctiveActionVerificationService.submitVerification(
        {
          correctiveActionId: parseCorrectiveActionIdParam(param(req.params.id)),
          ...parsed,
        },
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

/** The authoritative result — the latest COMPLETED decision. */
export async function getLatestVerificationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await correctiveActionVerificationService.getLatestVerification(
        parseCorrectiveActionIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function listVerificationHistoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await correctiveActionVerificationService.listVerificationHistory(
        parseCorrectiveActionIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function listVerificationsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await correctiveActionVerificationService.listVerifications(
        parseVerificationFilters(req.query),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}
