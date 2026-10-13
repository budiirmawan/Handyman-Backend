import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { listHandymanOperationsQueue } from './handyman-operations-queue.service';
import { parseHandymanOperationsQueueQuery } from './handyman-operations-queue.validation';

export async function listHandymanOperationsQueueHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const query = parseHandymanOperationsQueueQuery(req.query);
    sendSuccess(res, await listHandymanOperationsQueue(req.auth.userId, query));
  } catch (error) {
    next(error);
  }
}
