import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { rfqService } from './rfq.service';
import {
  parseCreateRfqBody,
  parseCreateRfqLineBody,
  parseRfqFilters,
  parseRfqIdParam,
  parseRfqLineIdParam,
  parseUpdateRfqBody,
} from './rfq.validation';

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

export async function createRfqHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await rfqService.createRfq(
        parseCreateRfqBody(req.body, idempotencyHeader(req)),
        actor(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function getRfqHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(res, await rfqService.getRfq(parseRfqIdParam(param(req.params.id)), actor(req)));
  } catch (error) {
    next(error);
  }
}

export async function listRfqsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(res, await rfqService.listRfqs(parseRfqFilters(req.query), actor(req)));
  } catch (error) {
    next(error);
  }
}

export async function updateRfqHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await rfqService.updateRfq(
        parseRfqIdParam(param(req.params.id)),
        parseUpdateRfqBody(req.body),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function addRfqLineHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await rfqService.addRfqLine(
        parseRfqIdParam(param(req.params.id)),
        parseCreateRfqLineBody(req.body),
        actor(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function listRfqLinesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await rfqService.listRfqLines(parseRfqIdParam(param(req.params.id)), actor(req)),
    );
  } catch (error) {
    next(error);
  }
}

export async function getRfqLineHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await rfqService.getRfqLine(parseRfqLineIdParam(param(req.params.lineId)), actor(req)),
    );
  } catch (error) {
    next(error);
  }
}

export async function openRfqHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(res, await rfqService.openRfq(parseRfqIdParam(param(req.params.id)), actor(req)));
  } catch (error) {
    next(error);
  }
}

export async function closeRfqHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(res, await rfqService.closeRfq(parseRfqIdParam(param(req.params.id)), actor(req)));
  } catch (error) {
    next(error);
  }
}

export async function cancelRfqHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(res, await rfqService.cancelRfq(parseRfqIdParam(param(req.params.id)), actor(req)));
  } catch (error) {
    next(error);
  }
}

export async function getRfqAvailableActionsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await rfqService.getRfqAvailableActions(parseRfqIdParam(param(req.params.id)), actor(req)),
    );
  } catch (error) {
    next(error);
  }
}
