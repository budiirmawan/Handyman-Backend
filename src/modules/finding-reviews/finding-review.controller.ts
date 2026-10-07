import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import { findingService, parseFindingIdParam } from '../findings';
import { assertFindingActionAllowed } from '../findings/finding-action.authority';
import { findingReviewService } from './finding-review.service';
import {
  parseFindingVerificationBody,
  parseOpenFindingReviewBody,
} from './finding-review.validation';

const param = (value: string | string[]) => Array.isArray(value) ? '' : value;
async function authorized(req: Request) {
  if (!req.auth) throw authenticationRequiredError();
  const findingId = parseFindingIdParam(param(req.params.id));
  const finding = await findingService.getFindingById(findingId);
  await contextAccessService.assertBuildingAccess(req.auth.userId, finding.buildingId);
  return { findingId, userId: req.auth.userId };
}
export async function openFindingReviewHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const context = await authorized(req);
    await assertFindingActionAllowed(
      context.findingId,
      context.userId,
      'OPEN_REVIEW',
    );
    sendSuccess(res, await findingReviewService.openFindingReview({
      ...parseOpenFindingReviewBody(req.body),
      findingId: context.findingId,
      reviewerUserId: context.userId,
    }), 201);
  } catch (error) { next(error); }
}
export async function listFindingReviewsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const context = await authorized(req);
    sendSuccess(res, await findingReviewService.listFindingReviews(context.findingId));
  } catch (error) { next(error); }
}
export async function getCurrentFindingReviewHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const context = await authorized(req);
    sendSuccess(res, await findingReviewService.getCurrentFindingReview(context.findingId));
  } catch (error) { next(error); }
}
export async function getFindingVerificationHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const context = await authorized(req);
    sendSuccess(res, await findingReviewService.getFindingVerificationState(context.findingId));
  } catch (error) { next(error); }
}
export async function submitFindingVerificationHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const context = await authorized(req);
    const input = parseFindingVerificationBody(req.body);
    const action = input.decision === 'APPROVED'
      ? 'APPROVE'
      : input.decision === 'REJECTED'
        ? 'REJECT'
        : 'REQUEST_REWORK';
    await assertFindingActionAllowed(context.findingId, context.userId, action);
    sendSuccess(res, await findingReviewService.submitFindingVerification({
      ...input,
      findingId: context.findingId,
      reviewerUserId: context.userId,
    }), 201);
  } catch (error) { next(error); }
}
