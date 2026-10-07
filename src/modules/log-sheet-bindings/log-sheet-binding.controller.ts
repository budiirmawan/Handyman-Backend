import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { logSheetBindingService } from './log-sheet-binding.service';
import {
  parseAssetIdParam,
  parseBindingIdParam,
  parseBuildingIdParam,
  parseCreateLogSheetBindingBody,
  parseExecutionIdParam,
  parseUpdateLogSheetBindingBody,
} from './log-sheet-binding.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

/** POST /assets/:assetId/log-sheet-bindings */
export async function createLogSheetBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const assetId = parseAssetIdParam(paramString(req.params.assetId));
    const body = parseCreateLogSheetBindingBody(
      req.body as Record<string, unknown>,
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const binding = await logSheetBindingService.createLogSheetBinding(
      {
        assetId,
        formTemplateId: body.formTemplateId,
        formTemplateVersionId: body.formTemplateVersionId,
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

/** GET /assets/:assetId/log-sheet-bindings */
export async function listAssetLogSheetBindingsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const assetId = parseAssetIdParam(paramString(req.params.assetId));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const bindings = await logSheetBindingService.listLogSheetBindingsByAsset(
      assetId,
      req.auth.userId,
    );
    sendSuccess(res, bindings);
  } catch (error) {
    next(error);
  }
}

/** GET /buildings/:buildingId/engineering/log-sheet-bindings */
export async function listBuildingLogSheetBindingsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parseBuildingIdParam(paramString(req.params.buildingId));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const bindings = await logSheetBindingService.listLogSheetBindingsByBuilding(
      buildingId,
      req.auth.userId,
    );
    sendSuccess(res, bindings);
  } catch (error) {
    next(error);
  }
}

/** GET /engineering/log-sheet-bindings/:id */
export async function getLogSheetBindingHandler(
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
      await logSheetBindingService.getLogSheetBinding(id, req.auth.userId),
    );
  } catch (error) {
    next(error);
  }
}

/** PATCH /engineering/log-sheet-bindings/:id */
export async function updateLogSheetBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseBindingIdParam(paramString(req.params.id));
    const body = parseUpdateLogSheetBindingBody(
      req.body as Record<string, unknown>,
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    sendSuccess(
      res,
      await logSheetBindingService.updateLogSheetBinding(
        id,
        body,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}

/** POST /engineering/log-sheet-bindings/:id/start */
export async function startLogSheetExecutionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseBindingIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const execution = await logSheetBindingService.startLogSheetExecution(
      id,
      req.auth.userId,
    );
    sendSuccess(res, execution, 201);
  } catch (error) {
    next(error);
  }
}

/** GET /engineering/log-sheet-bindings/:id/executions */
export async function listLogSheetExecutionsHandler(
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
      await logSheetBindingService.listLogSheetExecutions(id, req.auth.userId),
    );
  } catch (error) {
    next(error);
  }
}

/** GET /engineering/log-sheet-executions/:id */
export async function getLogSheetExecutionContextHandler(
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
      await logSheetBindingService.resolveLogSheetExecutionContext(
        id,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}
