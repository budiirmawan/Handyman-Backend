import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { buildingConfigurationService } from './building-configuration.service';
import {
  parseBuildingConfigurationBuildingIdParam,
  parseBuildingConfigurationFilters,
  parseBuildingConfigurationIdParam,
  parseCreateBuildingConfigurationBody,
  parseUpdateBuildingConfigurationBody,
} from './building-configuration.validation';

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function userId(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function createBuildingConfigurationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parseBuildingConfigurationBuildingIdParam(
      param(req.params.buildingId),
    );
    sendSuccess(
      res,
      await buildingConfigurationService.createBuildingConfiguration(
        { ...parseCreateBuildingConfigurationBody(req.body), buildingId },
        userId(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function listBuildingConfigurationsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parseBuildingConfigurationBuildingIdParam(
      param(req.params.buildingId),
    );
    sendSuccess(
      res,
      await buildingConfigurationService.listBuildingConfigurations(
        buildingId,
        parseBuildingConfigurationFilters(req.query.status),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getEffectiveBuildingConfigurationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parseBuildingConfigurationBuildingIdParam(
      param(req.params.buildingId),
    );
    sendSuccess(
      res,
      await buildingConfigurationService.getEffectiveBuildingConfiguration(
        buildingId,
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getBuildingConfigurationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await buildingConfigurationService.getBuildingConfigurationById(
        parseBuildingConfigurationIdParam(param(req.params.id)),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function updateBuildingConfigurationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await buildingConfigurationService.updateBuildingConfiguration(
        parseBuildingConfigurationIdParam(param(req.params.id)),
        parseUpdateBuildingConfigurationBody(req.body),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}
