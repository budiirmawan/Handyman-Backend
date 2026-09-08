import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { deliveryCourierService } from './delivery-courier.service';
import {
  parseCreateDeliveryCourierBody,
  parseDeliveryCourierIdParam,
  parseDeliveryCourierListQuery,
  parseUpdateDeliveryCourierStatusBody,
} from './delivery-courier.validation';

function paramString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

export async function createDeliveryCourierHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const body = parseCreateDeliveryCourierBody(req.body);
    const result = await deliveryCourierService.createDeliveryCourier(
      { ...body, createdByUserId: req.auth.userId },
      req.auth.userId,
    );
    sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

export async function listDeliveryCouriersHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const filters = parseDeliveryCourierListQuery(
      req.query as Record<string, unknown>,
    );
    const result = await deliveryCourierService.listDeliveryCouriers(
      filters,
      req.auth.userId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

export async function getDeliveryCourierHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const id = parseDeliveryCourierIdParam(paramString(req.params.id));
    const result = await deliveryCourierService.getDeliveryCourier(
      id,
      req.auth.userId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

export async function updateDeliveryCourierStatusHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const id = parseDeliveryCourierIdParam(paramString(req.params.id));
    const body = parseUpdateDeliveryCourierStatusBody(req.body);
    const result = await deliveryCourierService.updateDeliveryCourierStatus(
      id,
      { ...body, statusUpdatedByUserId: req.auth.userId },
      req.auth.userId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}
