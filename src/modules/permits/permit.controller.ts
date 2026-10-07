import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { permitService } from './permit.service';
import {
  parseCreatePermitBody,
  parsePermitFilters,
  parsePermitIdParam,
  parseUpdatePermitBody,
} from './permit.validation';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function createPermitHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await permitService.createPermit(parseCreatePermitBody(req.body), actor(req)),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function getPermitHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await permitService.getPermit(
        parsePermitIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function listPermitsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await permitService.listPermits(parsePermitFilters(req.query), actor(req)),
    );
  } catch (error) {
    next(error);
  }
}

export async function updatePermitHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await permitService.updatePermit(
        parsePermitIdParam(param(req.params.id)),
        parseUpdatePermitBody(req.body),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function cancelPermitHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await permitService.cancelPermit(
        parsePermitIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}
