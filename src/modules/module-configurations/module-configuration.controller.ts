import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { moduleConfigurationService } from './module-configuration.service';
import {
  parseCreateModuleConfigurationBody,
  parseModuleConfigurationBuildingIdParam,
  parseModuleConfigurationClientIdParam,
  parseModuleConfigurationIdParam,
  parseUpdateModuleConfigurationBody,
} from './module-configuration.validation';

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function userId(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function createClientModuleConfigurationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await moduleConfigurationService.createClientModuleConfiguration(
        parseModuleConfigurationClientIdParam(param(req.params.clientId)),
        parseCreateModuleConfigurationBody(req.body),
        userId(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function listClientModuleConfigurationsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await moduleConfigurationService.listClientModuleConfigurations(
        parseModuleConfigurationClientIdParam(param(req.params.clientId)),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getEffectiveClientModuleConfigurationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await moduleConfigurationService.getEffectiveClientModuleConfiguration(
        parseModuleConfigurationClientIdParam(param(req.params.clientId)),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function createBuildingModuleConfigurationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await moduleConfigurationService.createBuildingModuleConfiguration(
        parseModuleConfigurationBuildingIdParam(param(req.params.buildingId)),
        parseCreateModuleConfigurationBody(req.body),
        userId(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function listBuildingModuleConfigurationsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await moduleConfigurationService.listBuildingModuleConfigurations(
        parseModuleConfigurationBuildingIdParam(param(req.params.buildingId)),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getEffectiveBuildingModuleConfigurationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await moduleConfigurationService.getEffectiveBuildingModuleConfiguration(
        parseModuleConfigurationBuildingIdParam(param(req.params.buildingId)),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getModuleConfigurationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await moduleConfigurationService.getModuleConfigurationById(
        parseModuleConfigurationIdParam(param(req.params.id)),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function updateModuleConfigurationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await moduleConfigurationService.updateModuleConfiguration(
        parseModuleConfigurationIdParam(param(req.params.id)),
        parseUpdateModuleConfigurationBody(req.body),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}
