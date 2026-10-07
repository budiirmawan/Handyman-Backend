import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { workOrderProcurementBindingService } from './work-order-procurement-binding.service';
import {
  parseBindWorkContractBody,
  parseBindingIdParam,
  parseCreateBindingBody,
  parseLinkReceivingBody,
  parseWorkOrderIdParam,
} from './work-order-procurement-binding.validation';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function createBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await workOrderProcurementBindingService.createBinding(
        parseCreateBindingBody(req.body),
        actor(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function getBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await workOrderProcurementBindingService.getBinding(
        parseBindingIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function listByWorkOrderHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await workOrderProcurementBindingService.listByWorkOrder(
        parseWorkOrderIdParam(param(req.params.workOrderId)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function resolveReadinessHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await workOrderProcurementBindingService.resolveReadiness(
        parseBindingIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function linkReceivingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await workOrderProcurementBindingService.linkReceiving(
        parseBindingIdParam(param(req.params.id)),
        parseLinkReceivingBody(req.body),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

/**
 * CR-BE-R2P-01 PART 05 — binds an ACTIVE SPK to the existing authoritative
 * procurement binding.
 */
export async function bindWorkContractHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await workOrderProcurementBindingService.bindWorkContract(
        parseBindingIdParam(param(req.params.id)),
        parseBindWorkContractBody(req.body),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}
