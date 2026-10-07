import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import {
  parseVendorWorkIdParam,
  vendorWorkService,
} from '../vendor-work';
import { vendorReworkService } from './vendor-rework.service';
import {
  parseReworkNotesBody,
  parseReworkReasonBody,
} from './vendor-rework.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

async function authorized(req: Request): Promise<{
  vendorWorkId: string;
  userId: string;
}> {
  if (!req.auth) {
    throw authenticationRequiredError();
  }
  const vendorWorkId = parseVendorWorkIdParam(paramString(req.params.id));
  const work = await vendorWorkService.getVendorWork(vendorWorkId);
  await contextAccessService.assertBuildingAccess(
    req.auth.userId,
    work.buildingId,
  );
  return { vendorWorkId, userId: req.auth.userId };
}

/** POST /vendor-works/:id/rework — request rework (reason required). */
export async function requestVendorReworkHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const context = await authorized(req);
    sendSuccess(
      res,
      await vendorReworkService.requestVendorRework({
        ...context,
        ...parseReworkReasonBody(req.body),
      }),
      201,
    );
  } catch (error) {
    next(error);
  }
}

/** GET /vendor-works/:id/rework — current rework context + history. */
export async function getVendorReworkHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const context = await authorized(req);
    sendSuccess(
      res,
      await vendorReworkService.getVendorReworkContext(
        context.vendorWorkId,
        context.userId,
      ),
    );
  } catch (error) {
    next(error);
  }
}

/** PATCH /vendor-works/:id/rework — update rework notes while REQUESTED. */
export async function updateVendorReworkNotesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const context = await authorized(req);
    sendSuccess(
      res,
      await vendorReworkService.updateVendorReworkNotes({
        ...context,
        ...parseReworkNotesBody(req.body),
      }),
    );
  } catch (error) {
    next(error);
  }
}

/** POST /vendor-works/:id/resubmit — resubmit the rework (notes required). */
export async function resubmitVendorWorkHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const context = await authorized(req);
    sendSuccess(
      res,
      await vendorReworkService.resubmitVendorWork({
        ...context,
        ...parseReworkNotesBody(req.body),
      }),
    );
  } catch (error) {
    next(error);
  }
}
