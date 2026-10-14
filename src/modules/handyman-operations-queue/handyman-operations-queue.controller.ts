import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import {
  listHandymanOperationsCommercialInbox,
} from './handyman-operations-commercial-inbox.service';
import { listHandymanOperationsQueue } from './handyman-operations-queue.service';
import {
  parseHandymanOperationsCommercialInboxQuery,
  parseHandymanOperationsQueueQuery,
} from './handyman-operations-queue.validation';

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

/**
 * CR-HM-OPS-INBOX-BE-01 P0-B — authoritative commercial action inbox.
 */
export async function listHandymanOperationsCommercialInboxHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const query = parseHandymanOperationsCommercialInboxQuery(req.query);
    sendSuccess(
      res,
      await listHandymanOperationsCommercialInbox(req.auth.userId, query),
    );
  } catch (error) {
    next(error);
  }
}
