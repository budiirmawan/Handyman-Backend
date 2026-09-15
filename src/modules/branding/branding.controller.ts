import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { brandingService } from './branding.service';
import {
  parseBrandingBuildingId,
  parseBrandingClientId,
  parseBrandingId,
  parseCreateBrandingBody,
  parseUpdateBrandingBody,
} from './branding.validation';

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}
function userId(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function createClientBrandingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await brandingService.createClientBranding(
        parseBrandingClientId(param(req.params.clientId)),
        parseCreateBrandingBody(req.body),
        userId(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function getClientBrandingForScopeHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await brandingService.getClientBrandingForScope(
        parseBrandingClientId(param(req.params.clientId)),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getEffectiveClientBrandingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await brandingService.getEffectiveClientBranding(
        parseBrandingClientId(param(req.params.clientId)),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getClientBrandingByIdHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await brandingService.getClientBrandingById(
        parseBrandingId(param(req.params.id)),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function updateClientBrandingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await brandingService.updateClientBranding(
        parseBrandingId(param(req.params.id)),
        parseUpdateBrandingBody(req.body),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function createBuildingBrandingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await brandingService.createBuildingBranding(
        parseBrandingBuildingId(param(req.params.buildingId)),
        parseCreateBrandingBody(req.body),
        userId(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function getBuildingBrandingForScopeHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await brandingService.getBuildingBrandingForScope(
        parseBrandingBuildingId(param(req.params.buildingId)),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getEffectiveBuildingBrandingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await brandingService.getEffectiveBuildingBranding(
        parseBrandingBuildingId(param(req.params.buildingId)),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getBuildingBrandingByIdHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await brandingService.getBuildingBrandingById(
        parseBrandingId(param(req.params.id)),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function updateBuildingBrandingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await brandingService.updateBuildingBranding(
        parseBrandingId(param(req.params.id)),
        parseUpdateBrandingBody(req.body),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}
