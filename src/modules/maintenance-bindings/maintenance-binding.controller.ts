import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { maintenanceBindingService } from './maintenance-binding.service';
import {
  parseAssetIdParam,
  parseBindingIdParam,
  parseBuildingIdParam,
  parseCreateMaintenanceBindingBody,
  parseLinkMaintenanceScheduleBody,
  parseLinkMaintenanceTaskBody,
  parseLinkMaintenanceWorkOrderBody,
  parseUpdateMaintenanceBindingBody,
} from './maintenance-binding.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

/** POST /assets/:assetId/maintenance-bindings */
export async function createMaintenanceBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const assetId = parseAssetIdParam(paramString(req.params.assetId));
    const body = parseCreateMaintenanceBindingBody(
      req.body as Record<string, unknown>,
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const binding = await maintenanceBindingService.createMaintenanceBinding(
      {
        assetId,
        name: body.name,
        maintenanceType: body.maintenanceType,
        description: body.description,
        functionalLocationId: body.functionalLocationId,
        status: body.status,
        createdByUserId: req.auth.userId,
      },
      req.auth.userId,
    );

    sendSuccess(res, binding, 201);
  } catch (error) {
    next(error);
  }
}

/** GET /assets/:assetId/maintenance-bindings */
export async function listAssetMaintenanceBindingsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const assetId = parseAssetIdParam(paramString(req.params.assetId));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    sendSuccess(
      res,
      await maintenanceBindingService.listMaintenanceBindingsByAsset(
        assetId,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}

/** GET /buildings/:buildingId/engineering/maintenance-bindings */
export async function listBuildingMaintenanceBindingsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parseBuildingIdParam(paramString(req.params.buildingId));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    sendSuccess(
      res,
      await maintenanceBindingService.listMaintenanceBindingsByBuilding(
        buildingId,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}

/** GET /engineering/maintenance-bindings/:id */
export async function getMaintenanceBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseBindingIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    sendSuccess(
      res,
      await maintenanceBindingService.getMaintenanceBinding(id, req.auth.userId),
    );
  } catch (error) {
    next(error);
  }
}

/** PATCH /engineering/maintenance-bindings/:id */
export async function updateMaintenanceBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseBindingIdParam(paramString(req.params.id));
    const body = parseUpdateMaintenanceBindingBody(
      req.body as Record<string, unknown>,
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    sendSuccess(
      res,
      await maintenanceBindingService.updateMaintenanceBinding(
        id,
        body,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}

/** POST /engineering/maintenance-bindings/:id/schedule */
export async function linkMaintenanceScheduleHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseBindingIdParam(paramString(req.params.id));
    const body = parseLinkMaintenanceScheduleBody(
      req.body as Record<string, unknown>,
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    sendSuccess(
      res,
      await maintenanceBindingService.linkMaintenanceSchedule(
        id,
        body,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}

/** POST /engineering/maintenance-bindings/:id/task */
export async function linkMaintenanceTaskHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseBindingIdParam(paramString(req.params.id));
    const body = parseLinkMaintenanceTaskBody(req.body as Record<string, unknown>);
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    sendSuccess(
      res,
      await maintenanceBindingService.linkMaintenanceTask(id, body, req.auth.userId),
    );
  } catch (error) {
    next(error);
  }
}

/** POST /engineering/maintenance-bindings/:id/work-order */
export async function linkMaintenanceWorkOrderHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseBindingIdParam(paramString(req.params.id));
    const body = parseLinkMaintenanceWorkOrderBody(
      req.body as Record<string, unknown>,
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    sendSuccess(
      res,
      await maintenanceBindingService.linkMaintenanceWorkOrder(
        id,
        body,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}
