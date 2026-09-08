import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { rfqComparisonService } from './rfq-comparison.service';
import {
  parseCreateRfqComparisonBody,
  parseCreateRfqEvaluationBody,
  parseRfqComparisonIdParam,
  parseRfqEvaluationIdParam,
  parseRfqIdParam,
  parseUpdateRfqEvaluationBody,
} from './rfq-comparison.validation';

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

function idempotencyHeader(req: Request): string | undefined {
  const value = req.header('Idempotency-Key');
  return value?.trim() || undefined;
}

export async function createRfqComparisonHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rfqId = parseRfqIdParam(param(req.params.rfqId));
    sendSuccess(res, await rfqComparisonService.createRfqComparison(
      parseCreateRfqComparisonBody(req.body, idempotencyHeader(req), rfqId),
      actor(req),
    ), 201);
  } catch (error) { next(error); }
}

export async function listRfqComparisonsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await rfqComparisonService.listRfqComparisons(
      parseRfqIdParam(param(req.params.rfqId)), actor(req),
    ));
  } catch (error) { next(error); }
}

export async function getRfqComparisonHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await rfqComparisonService.getRfqComparison(
      parseRfqComparisonIdParam(param(req.params.comparisonId)), actor(req),
    ));
  } catch (error) { next(error); }
}

export async function listRfqComparisonEvaluationsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await rfqComparisonService.listRfqComparisonEvaluations(
      parseRfqComparisonIdParam(param(req.params.comparisonId)), actor(req),
    ));
  } catch (error) { next(error); }
}

export async function createRfqComparisonEvaluationHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await rfqComparisonService.createRfqComparisonEvaluation({
      ...parseCreateRfqEvaluationBody(req.body),
      comparisonRunId: parseRfqComparisonIdParam(param(req.params.comparisonId)),
    }, actor(req)), 201);
  } catch (error) { next(error); }
}

export async function getRfqComparisonEvaluationHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const evaluationId = parseRfqEvaluationIdParam(param(req.params.evaluationId));
    const evaluation = await rfqComparisonService.getRfqComparisonEvaluation(evaluationId, actor(req));
    sendSuccess(res, evaluation);
  } catch (error) { next(error); }
}

export async function updateRfqComparisonEvaluationHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await rfqComparisonService.updateRfqComparisonEvaluation(
      parseRfqEvaluationIdParam(param(req.params.evaluationId)),
      parseUpdateRfqEvaluationBody(req.body),
      actor(req),
    ));
  } catch (error) { next(error); }
}
