import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { inspectionBindingService } from './inspection-binding.service';
import {
  parseAssetIdParam,
  parseBindingIdParam,
  parseBuildingIdParam,
  parseCreateInspectionBindingBody,
  parseExecutionIdParam,
  parseUpdateInspectionBindingBody,
} from './inspection-binding.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

/** POST /assets/:assetId/inspection-bindings */
export async function createInspectionBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const assetId = parseAssetIdParam(paramString(req.params.assetId));
    const body = parseCreateInspectionBindingBody(
      req.body as Record<string, unknown>,
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const binding = await inspectionBindingService.createInspectionBinding(
      {
        assetId,
        checklistTemplateId: body.checklistTemplateId,
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

/** GET /assets/:assetId/inspection-bindings */
export async function listAssetInspectionBindingsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const assetId = parseAssetIdParam(paramString(req.params.assetId));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const bindings = await inspectionBindingService.listInspectionBindingsByAsset(
      assetId,
      req.auth.userId,
    );
    sendSuccess(res, bindings);
  } catch (error) {
    next(error);
  }
}

/** GET /buildings/:buildingId/engineering/inspection-bindings */
export async function listBuildingInspectionBindingsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parseBuildingIdParam(paramString(req.params.buildingId));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const bindings =
      await inspectionBindingService.listInspectionBindingsByBuilding(
        buildingId,
        req.auth.userId,
      );
    sendSuccess(res, bindings);
  } catch (error) {
    next(error);
  }
}

/** GET /engineering/inspection-bindings/:id */
export async function getInspectionBindingHandler(
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
      await inspectionBindingService.getInspectionBinding(id, req.auth.userId),
    );
  } catch (error) {
    next(error);
  }
}

/** PATCH /engineering/inspection-bindings/:id */
export async function updateInspectionBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseBindingIdParam(paramString(req.params.id));
    const body = parseUpdateInspectionBindingBody(
      req.body as Record<string, unknown>,
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    sendSuccess(
      res,
      await inspectionBindingService.updateInspectionBinding(
        id,
        body,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}

/** POST /engineering/inspection-bindings/:id/start */
export async function startInspectionExecutionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseBindingIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const execution = await inspectionBindingService.startInspectionExecution(
      id,
      req.auth.userId,
    );
    sendSuccess(res, execution, 201);
  } catch (error) {
    next(error);
  }
}

/** GET /engineering/inspection-executions/:id */
export async function getInspectionExecutionContextHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseExecutionIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    sendSuccess(
      res,
      await inspectionBindingService.resolveInspectionExecutionContext(
        id,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}
