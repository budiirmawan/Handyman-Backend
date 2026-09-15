import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { propertyService } from './property.service';
import {
  parseCreatePropertyBody,
  parsePropertyClientIdParam,
  parsePropertyIdParam,
  parseUpdatePropertyStatusBody,
} from './property.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

export async function createPropertyHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = parseCreatePropertyBody(req.body);
    const property = await propertyService.createProperty(input);
    sendSuccess(res, property, 201);
  } catch (error) {
    next(error);
  }
}

export async function listPropertiesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const rawClientId = Array.isArray(req.query.clientId) ? '' : req.query.clientId;
    const clientId =
      typeof rawClientId === 'string' && rawClientId.trim() !== ''
        ? parsePropertyClientIdParam(rawClientId)
        : undefined;
    const properties = await propertyService.listProperties(clientId);
    sendSuccess(res, properties);
  } catch (error) {
    next(error);
  }
}

export async function getPropertyHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parsePropertyIdParam(paramString(req.params.id));
    const property = await propertyService.getPropertyById(id);
    sendSuccess(res, property);
  } catch (error) {
    next(error);
  }
}

export async function updatePropertyStatusHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parsePropertyIdParam(paramString(req.params.id));
    const input = parseUpdatePropertyStatusBody(req.body);
    const property = await propertyService.updatePropertyStatus(id, input);
    sendSuccess(res, property);
  } catch (error) {
    next(error);
  }
}

export async function listClientPropertiesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const clientId = parsePropertyClientIdParam(paramString(req.params.clientId));
    const properties = await propertyService.listPropertiesByClient(clientId);
    sendSuccess(res, properties);
  } catch (error) {
    next(error);
  }
}
