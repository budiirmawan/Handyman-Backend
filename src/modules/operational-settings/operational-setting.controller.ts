import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { operationalSettingService } from './operational-setting.service';
import {
  parseCreateOperationalSettingBody,
  parseOperationalSettingBuildingId,
  parseOperationalSettingClientId,
  parseOperationalSettingFilters,
  parseOperationalSettingId,
  parseUpdateOperationalSettingBody,
} from './operational-setting.validation';

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function userId(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function createClientOperationalSettingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await operationalSettingService.createClientOperationalSetting(
        parseOperationalSettingClientId(param(req.params.clientId)),
        parseCreateOperationalSettingBody(req.body),
        userId(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function listClientOperationalSettingsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await operationalSettingService.listClientOperationalSettings(
        parseOperationalSettingClientId(param(req.params.clientId)),
        parseOperationalSettingFilters(req.query.status),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getEffectiveClientOperationalSettingsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await operationalSettingService.getEffectiveClientOperationalSettings(
        parseOperationalSettingClientId(param(req.params.clientId)),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getClientOperationalSettingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await operationalSettingService.getClientOperationalSetting(
        parseOperationalSettingId(param(req.params.id)),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function updateClientOperationalSettingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await operationalSettingService.updateClientOperationalSetting(
        parseOperationalSettingId(param(req.params.id)),
        parseUpdateOperationalSettingBody(req.body),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function createBuildingOperationalSettingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await operationalSettingService.createBuildingOperationalSetting(
        parseOperationalSettingBuildingId(param(req.params.buildingId)),
        parseCreateOperationalSettingBody(req.body),
        userId(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function listBuildingOperationalSettingsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await operationalSettingService.listBuildingOperationalSettings(
        parseOperationalSettingBuildingId(param(req.params.buildingId)),
        parseOperationalSettingFilters(req.query.status),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getEffectiveBuildingOperationalSettingsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await operationalSettingService.getEffectiveBuildingOperationalSettings(
        parseOperationalSettingBuildingId(param(req.params.buildingId)),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getBuildingOperationalSettingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await operationalSettingService.getBuildingOperationalSetting(
        parseOperationalSettingId(param(req.params.id)),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function updateBuildingOperationalSettingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await operationalSettingService.updateBuildingOperationalSetting(
        parseOperationalSettingId(param(req.params.id)),
        parseUpdateOperationalSettingBody(req.body),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}
