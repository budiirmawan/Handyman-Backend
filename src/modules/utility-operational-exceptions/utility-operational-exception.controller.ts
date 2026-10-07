import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { utilityOperationalExceptionService as service } from './utility-operational-exception.service';
import {
  parseCreateUtilityException,
  parseRequiredLifecycleNotes,
  parseReviewNotes,
  parseUtilityExceptionFilters,
  parseUtilityExceptionId,
} from './utility-operational-exception.validation';
const param = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] ?? '' : value ?? '';
export async function createUtilityException(req: Request, res: Response, next: NextFunction) {
  try { sendSuccess(res, await service.createUtilityOperationalException(
    parseCreateUtilityException(req.body), req.auth!.userId), 201); } catch (error) { next(error); }
}
export async function listUtilityExceptions(req: Request, res: Response, next: NextFunction) {
  try { sendSuccess(res, await service.listUtilityOperationalExceptions(
    parseUtilityExceptionFilters(req.query), req.auth!.userId)); } catch (error) { next(error); }
}
export async function getUtilityException(req: Request, res: Response, next: NextFunction) {
  try { sendSuccess(res, await service.getUtilityOperationalException(
    parseUtilityExceptionId(param(req.params.id)), req.auth!.userId)); } catch (error) { next(error); }
}
export async function startUtilityExceptionReview(req: Request, res: Response, next: NextFunction) {
  try { const body = parseReviewNotes(req.body); sendSuccess(res, await service.startUtilityExceptionReview(
    parseUtilityExceptionId(param(req.params.id)), body.reviewNotes, req.auth!.userId)); } catch (error) { next(error); }
}
export async function resolveUtilityException(req: Request, res: Response, next: NextFunction) {
  try { sendSuccess(res, await service.resolveUtilityException(
    parseUtilityExceptionId(param(req.params.id)),
    parseRequiredLifecycleNotes(req.body, 'resolutionNotes'), req.auth!.userId)); } catch (error) { next(error); }
}
export async function cancelUtilityException(req: Request, res: Response, next: NextFunction) {
  try { sendSuccess(res, await service.cancelUtilityException(
    parseUtilityExceptionId(param(req.params.id)),
    parseRequiredLifecycleNotes(req.body, 'reason'), req.auth!.userId)); } catch (error) { next(error); }
}
