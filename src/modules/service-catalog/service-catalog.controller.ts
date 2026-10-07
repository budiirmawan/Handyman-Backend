import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { serviceCatalogService } from './service-catalog.service';
import {
  parseCreateServiceCatalogEntryBody,
  parseServiceCatalogFilters,
  parseServiceCatalogIdParam,
  parseUpdateServiceCatalogEntryBody,
} from './service-catalog.validation';

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function createServiceCatalogEntryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await serviceCatalogService.createServiceCatalogEntry(
        parseCreateServiceCatalogEntryBody(req.body),
        actor(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function getServiceCatalogEntryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await serviceCatalogService.getServiceCatalogEntry(
        parseServiceCatalogIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function listServiceCatalogEntriesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await serviceCatalogService.listServiceCatalogEntries(
        parseServiceCatalogFilters(req.query),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function updateServiceCatalogEntryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await serviceCatalogService.updateServiceCatalogEntry(
        parseServiceCatalogIdParam(param(req.params.id)),
        parseUpdateServiceCatalogEntryBody(req.body),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function deactivateServiceCatalogEntryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await serviceCatalogService.deactivateServiceCatalogEntry(
        parseServiceCatalogIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}
