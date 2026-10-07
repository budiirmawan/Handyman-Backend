import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { cmsContentService } from './cms-content.service';
import {
  parseCmsContentBuildingId,
  parseCmsContentClientId,
  parseCmsContentFilters,
  parseCmsContentId,
  parseCreateCmsContentBody,
  parseEffectiveCmsContentType,
  parseUpdateCmsContentBody,
} from './cms-content.validation';

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}
function userId(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function createClientCmsContentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await cmsContentService.createClientCmsContent(
        parseCmsContentClientId(param(req.params.clientId)),
        parseCreateCmsContentBody(req.body),
        userId(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function listClientCmsContentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await cmsContentService.listClientCmsContent(
        parseCmsContentClientId(param(req.params.clientId)),
        parseCmsContentFilters(req.query.contentType, req.query.status),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getEffectiveClientCmsContentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await cmsContentService.getEffectiveClientCmsContent(
        parseCmsContentClientId(param(req.params.clientId)),
        parseEffectiveCmsContentType(req.query.contentType),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getClientCmsContentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await cmsContentService.getClientCmsContentById(
        parseCmsContentId(param(req.params.id)),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function updateClientCmsContentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await cmsContentService.updateClientCmsContent(
        parseCmsContentId(param(req.params.id)),
        parseUpdateCmsContentBody(req.body),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function createBuildingCmsContentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await cmsContentService.createBuildingCmsContent(
        parseCmsContentBuildingId(param(req.params.buildingId)),
        parseCreateCmsContentBody(req.body),
        userId(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function listBuildingCmsContentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await cmsContentService.listBuildingCmsContent(
        parseCmsContentBuildingId(param(req.params.buildingId)),
        parseCmsContentFilters(req.query.contentType, req.query.status),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getEffectiveBuildingCmsContentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await cmsContentService.getEffectiveBuildingCmsContent(
        parseCmsContentBuildingId(param(req.params.buildingId)),
        parseEffectiveCmsContentType(req.query.contentType),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getBuildingCmsContentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await cmsContentService.getBuildingCmsContentById(
        parseCmsContentId(param(req.params.id)),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function updateBuildingCmsContentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await cmsContentService.updateBuildingCmsContent(
        parseCmsContentId(param(req.params.id)),
        parseUpdateCmsContentBody(req.body),
        userId(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}
