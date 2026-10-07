import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { configurationPreviewService } from './configuration-preview.service';
import {
  parseConfigurationPreviewId,
  parseCreateConfigurationPreviewBody,
  parsePreviewConfigurationVersionId,
} from './configuration-preview.validation';

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}
function userId(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function createConfigurationPreviewHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await configurationPreviewService.createConfigurationPreview(
        parsePreviewConfigurationVersionId(param(req.params.versionId)),
        parseCreateConfigurationPreviewBody(req.body),
        userId(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function getConfigurationPreviewHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await configurationPreviewService.getConfigurationPreview(
        parseConfigurationPreviewId(param(req.params.id)),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getEffectiveConfigurationPreviewHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await configurationPreviewService.getEffectiveConfigurationPreview(
        parseConfigurationPreviewId(param(req.params.id)),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function revokeConfigurationPreviewHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await configurationPreviewService.revokeConfigurationPreview(
        parseConfigurationPreviewId(param(req.params.id)),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}
