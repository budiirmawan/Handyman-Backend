import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { frontDeskLogService } from './front-desk-log.service';
import {
  parseFrontDeskLogIdParam,
  parseFrontDeskLogListQuery,
} from './front-desk-log.validation';

function paramString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

/** GET /front-desk-logs?buildingId=&occurredFrom=&occurredTo=&visitorId=&activityType= */
export async function listFrontDeskLogsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const filters = parseFrontDeskLogListQuery(
      req.query as Record<string, unknown>,
    );
    const result = await frontDeskLogService.listFrontDeskLogs(
      filters,
      req.auth.userId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/** GET /front-desk-logs/:id (`ACTIVITY_TYPE:source-uuid`). */
export async function getFrontDeskLogHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const identity = parseFrontDeskLogIdParam(paramString(req.params.id));
    const result = await frontDeskLogService.getFrontDeskLog(
      identity,
      req.auth.userId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}
