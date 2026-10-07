import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { shiftHandoverService } from './shift-handover.service';
import {
  parseBuildingIdParam,
  parseCreateShiftHandoverBody,
  parseHandoverIdParam,
  parseHandoverListQuery,
  parseUpdateShiftHandoverBody,
} from './shift-handover.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

/** POST /buildings/:buildingId/engineering/shift-handovers */
export async function createShiftHandoverHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parseBuildingIdParam(paramString(req.params.buildingId));
    const body = parseCreateShiftHandoverBody(
      req.body as Record<string, unknown>,
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }

    const handover = await shiftHandoverService.createShiftHandover(
      {
        buildingId,
        outgoingShiftId: body.outgoingShiftId,
        incomingShiftId: body.incomingShiftId,
        handoverDate: body.handoverDate,
        summary: body.summary,
        preparedByUserId: req.auth.userId,
      },
      req.auth.userId,
    );

    sendSuccess(res, handover, 201);
  } catch (error) {
    next(error);
  }
}

/** GET /buildings/:buildingId/engineering/shift-handovers?date= */
export async function listShiftHandoversHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildingId = parseBuildingIdParam(paramString(req.params.buildingId));
    const { date } = parseHandoverListQuery(
      req.query as Record<string, unknown>,
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    sendSuccess(
      res,
      await shiftHandoverService.listShiftHandovers(
        buildingId,
        date,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}

/** GET /engineering/shift-handovers/:id */
export async function getShiftHandoverHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseHandoverIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    sendSuccess(
      res,
      await shiftHandoverService.getShiftHandover(id, req.auth.userId),
    );
  } catch (error) {
    next(error);
  }
}

/** PATCH /engineering/shift-handovers/:id */
export async function updateShiftHandoverHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseHandoverIdParam(paramString(req.params.id));
    const body = parseUpdateShiftHandoverBody(
      req.body as Record<string, unknown>,
    );
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    sendSuccess(
      res,
      await shiftHandoverService.updateShiftHandoverSummary(
        id,
        body,
        req.auth.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}

/** POST /engineering/shift-handovers/:id/ready */
export async function markShiftHandoverReadyHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseHandoverIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    sendSuccess(
      res,
      await shiftHandoverService.markShiftHandoverReady(id, req.auth.userId),
    );
  } catch (error) {
    next(error);
  }
}

/** POST /engineering/shift-handovers/:id/acknowledge */
export async function acknowledgeShiftHandoverHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseHandoverIdParam(paramString(req.params.id));
    if (!req.auth) {
      throw authenticationRequiredError();
    }
    sendSuccess(
      res,
      await shiftHandoverService.acknowledgeShiftHandover(id, req.auth.userId),
    );
  } catch (error) {
    next(error);
  }
}
