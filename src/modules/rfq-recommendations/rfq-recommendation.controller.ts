import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { rfqRecommendationService } from './rfq-recommendation.service';
import {
  parseCreateRfqAwardBody,
  parseCreateRfqRecommendationBody,
  parseRfqAwardIdParam,
  parseRfqRecommendationIdParam,
  parseRfqRecommendationRfqIdParam,
} from './rfq-recommendation.validation';

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}
function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function createRfqRecommendationHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await rfqRecommendationService.createRfqRecommendation({
      ...parseCreateRfqRecommendationBody(req.body),
      rfqId: parseRfqRecommendationRfqIdParam(param(req.params.rfqId)),
    }, actor(req)), 201);
  } catch (error) { next(error); }
}

export async function getRfqRecommendationForRfqHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await rfqRecommendationService.getRfqRecommendationForRfq(
      parseRfqRecommendationRfqIdParam(param(req.params.rfqId)), actor(req),
    ));
  } catch (error) { next(error); }
}

export async function getRfqRecommendationHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await rfqRecommendationService.getRfqRecommendation(
      parseRfqRecommendationIdParam(param(req.params.recommendationId)), actor(req),
    ));
  } catch (error) { next(error); }
}

export async function createRfqAwardHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await rfqRecommendationService.awardRfqRecommendation({
      ...parseCreateRfqAwardBody(req.body),
      recommendationId: parseRfqRecommendationIdParam(param(req.params.recommendationId)),
    }, actor(req)), 201);
  } catch (error) { next(error); }
}

export async function getRfqAwardHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await rfqRecommendationService.getRfqAward(
      parseRfqAwardIdParam(param(req.params.awardId)), actor(req),
    ));
  } catch (error) { next(error); }
}
