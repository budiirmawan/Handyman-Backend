import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { mobilePermitWorkService } from './mobile-permit-work.service';
import {
  parseMobilePermitWorkNotesBody,
  parseMobilePermitWorkPermitId,
} from './mobile-permit-work.validation';

/** CR-BE-RN20-PERMIT-FIELD-01 — Work Permit Field Execution handlers. */

function paramString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

/** GET /mobile/permit-work */
export async function listMobilePermitWorkHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(res, await mobilePermitWorkService.listMobilePermitWork(actor(req)));
  } catch (error) {
    next(error);
  }
}

/** GET /mobile/permit-work/:permitId */
export async function getMobilePermitWorkFieldContextHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const permitId = parseMobilePermitWorkPermitId(paramString(req.params.permitId));
    sendSuccess(
      res,
      await mobilePermitWorkService.getMobilePermitWorkFieldContext(permitId, actor(req)),
    );
  } catch (error) {
    next(error);
  }
}

/** POST /mobile/permit-work/:permitId/start — 201, mirroring the BE-20K start route. */
export async function startMobilePermitWorkHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const permitId = parseMobilePermitWorkPermitId(paramString(req.params.permitId));
    const input = parseMobilePermitWorkNotesBody(req.body);
    sendSuccess(
      res,
      await mobilePermitWorkService.startMobilePermitWork(permitId, input, actor(req)),
      201,
    );
  } catch (error) {
    next(error);
  }
}

/** POST /mobile/permit-work/:permitId/close — 200, mirroring the BE-20K close route. */
export async function closeMobilePermitWorkHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const permitId = parseMobilePermitWorkPermitId(paramString(req.params.permitId));
    const input = parseMobilePermitWorkNotesBody(req.body);
    sendSuccess(
      res,
      await mobilePermitWorkService.closeMobilePermitWork(permitId, input, actor(req)),
    );
  } catch (error) {
    next(error);
  }
}
