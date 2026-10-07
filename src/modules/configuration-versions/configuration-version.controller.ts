import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { configurationVersionService } from './configuration-version.service';
import {
  parseConfigurationVersionId,
  parseConfigurationVersionSourceType,
  parseSourceConfigurationId,
} from './configuration-version.validation';

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}
function userId(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function listConfigurationVersionsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await configurationVersionService.listConfigurationVersions(
        parseConfigurationVersionSourceType(param(req.params.sourceType)),
        parseSourceConfigurationId(param(req.params.sourceConfigurationId)),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getConfigurationVersionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await configurationVersionService.getConfigurationVersion(
        parseConfigurationVersionId(param(req.params.id)),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function listConfigurationValidationsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await configurationVersionService.listConfigurationValidations(
        parseConfigurationVersionId(param(req.params.id)),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function createConfigurationDraftHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await configurationVersionService.createDraftFromConfigurationVersion(
        parseConfigurationVersionId(param(req.params.id)),
        userId(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function validateConfigurationVersionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await configurationVersionService.validateConfigurationVersion(
        parseConfigurationVersionId(param(req.params.id)),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function publishConfigurationVersionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await configurationVersionService.publishConfigurationVersion(
        parseConfigurationVersionId(param(req.params.id)),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function activateConfigurationVersionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await configurationVersionService.activateConfigurationVersion(
        parseConfigurationVersionId(param(req.params.id)),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}
