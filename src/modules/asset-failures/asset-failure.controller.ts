import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { assetFailureService } from './asset-failure.service';
import {
  parseAssetFailureFilters,
  parseAssetFailureIdParam,
  parseCreateAssetFailureBody,
  parseUpdateAssetFailureBody,
} from './asset-failure.validation';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function createAssetFailureHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await assetFailureService.createAssetFailure(
        parseCreateAssetFailureBody(req.body),
        actor(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function getAssetFailureHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await assetFailureService.getAssetFailure(
        parseAssetFailureIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function listAssetFailuresHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await assetFailureService.listAssetFailures(
        parseAssetFailureFilters(req.query),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function updateAssetFailureHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await assetFailureService.updateAssetFailure(
        parseAssetFailureIdParam(param(req.params.id)),
        parseUpdateAssetFailureBody(req.body),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}
