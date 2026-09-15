import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { esgWasteRecordService } from './esg-waste-record.service';
import {
  parseCreateEsgWasteRecordBody,
  parseEsgWasteRecordFilters,
  parseEsgWasteRecordIdParam,
  parseUpdateEsgWasteRecordBody,
} from './esg-waste-record.validation';

function param(v: string | string[] | undefined): string {
  return Array.isArray(v) ? v[0] ?? '' : v ?? '';
}

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function createEsgWasteRecordHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await esgWasteRecordService.createEsgWasteRecord(
        parseCreateEsgWasteRecordBody(req.body),
        actor(req),
      ),
      201,
    );
  } catch (e) {
    next(e);
  }
}

export async function getEsgWasteRecordHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await esgWasteRecordService.getEsgWasteRecord(
        parseEsgWasteRecordIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (e) {
    next(e);
  }
}

export async function listEsgWasteRecordsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await esgWasteRecordService.listEsgWasteRecords(
        parseEsgWasteRecordFilters(req.query),
        actor(req),
      ),
    );
  } catch (e) {
    next(e);
  }
}

export async function updateEsgWasteRecordHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await esgWasteRecordService.updateEsgWasteRecord(
        parseEsgWasteRecordIdParam(param(req.params.id)),
        parseUpdateEsgWasteRecordBody(req.body),
        actor(req),
      ),
    );
  } catch (e) {
    next(e);
  }
}

export async function deactivateEsgWasteRecordHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await esgWasteRecordService.deactivateEsgWasteRecord(
        parseEsgWasteRecordIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (e) {
    next(e);
  }
}
