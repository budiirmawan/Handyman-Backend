import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { permitValidityService } from './permit-validity.service';
import {
  parsePermitValidityFilters,
  parsePermitValidityIdParam,
  parsePermitValidityPermitIdParam,
  parseRevokePermitValidityBody,
  parseSetPermitValidityBody,
} from './permit-validity.validation';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function setPermitValidityHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await permitValidityService.setPermitValidity(
        parsePermitValidityPermitIdParam(param(req.params.permitId)),
        parseSetPermitValidityBody(req.body),
        actor(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function getPermitValidityHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await permitValidityService.getPermitValidity(
        parsePermitValidityIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function resolveCurrentPermitValidityHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await permitValidityService.resolveCurrentPermitValidity(
        parsePermitValidityPermitIdParam(param(req.params.permitId)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function revokePermitValidityHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await permitValidityService.revokePermitValidity(
        parsePermitValidityIdParam(param(req.params.id)),
        parseRevokePermitValidityBody(req.body),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function listPermitValiditiesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await permitValidityService.listPermitValidities(
        parsePermitValidityFilters(req.query),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}
