import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { meterReadingBindingService } from './meter-reading-binding.service';
import {
  parseAssetIdParam,
  parseBindingIdParam,
  parseBuildingIdParam,
  parseCreateMeterReadingBindingBody,
  parseExecutionIdParam,
  parseSubmitReadingBody,
  parseUpdateMeterReadingBindingBody,
} from './meter-reading-binding.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

/** POST /assets/:assetId/meter-reading-bindings */
export async function createMeterReadingBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const assetId = parseAssetIdParam(paramString(req.params.assetId));
    const body = parseCreateMeterReadingBindingBody(
      req.body as Record<string, unknown>,
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const binding = await meterReadingBindingService.createMeterReadingBinding(
      {
        assetId,
        formFieldId: body.formFieldId,
        uomId: body.uomId,
        functionalLocationId: body.functionalLocationId,
        minimumValue: body.minimumValue,
        maximumValue: body.maximumValue,
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

/** GET /assets/:assetId/meter-reading-bindings */
export async function listAssetMeterReadingBindingsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const assetId = parseAssetIdParam(paramString(req.params.assetId));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const bindings =
      await meterReadingBindingService.listMeterReadingBindingsByAsset(
        assetId,
        req.auth.userId,
      );
    sendSuccess(res, bindings);
  } catch (error) {
    next(error);
  }
}

/** GET /buildings/:buildingId/engineering/meter-reading-bindings */
export async function listBuildingMeterReadingBindingsHandler(
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
      await meterReadingBindingService.listMeterReadingBindingsByBuilding(
        buildingId,
        req.auth.userId,
      );
    sendSuccess(res, bindings);
  } catch (error) {
    next(error);
  }
}

/** GET /engineering/meter-reading-bindings/:id */
export async function getMeterReadingBindingHandler(
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
      await meterReadingBindingService.getMeterReadingBinding(
        id,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}

/** PATCH /engineering/meter-reading-bindings/:id */
export async function updateMeterReadingBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseBindingIdParam(paramString(req.params.id));
    const body = parseUpdateMeterReadingBindingBody(
      req.body as Record<string, unknown>,
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    sendSuccess(
      res,
      await meterReadingBindingService.updateMeterReadingBinding(
        id,
        body,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}

/** POST /engineering/meter-reading-bindings/:id/start */
export async function startMeterReadingExecutionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseBindingIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const execution = await meterReadingBindingService.startMeterReadingExecution(
      id,
      req.auth.userId,
    );
    sendSuccess(res, execution, 201);
  } catch (error) {
    next(error);
  }
}

/** PUT /engineering/meter-reading-executions/:id/reading */
export async function submitMeterReadingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseExecutionIdParam(paramString(req.params.id));
    const body = parseSubmitReadingBody(req.body as Record<string, unknown>);
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    const reading = await meterReadingBindingService.submitMeterReading(
      id,
      req.auth.userId,
      body,
    );
    sendSuccess(res, reading);
  } catch (error) {
    next(error);
  }
}

/** GET /engineering/meter-reading-executions/:id */
export async function getMeterReadingContextHandler(
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
      await meterReadingBindingService.resolveMeterReadingContext(
        id,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}
