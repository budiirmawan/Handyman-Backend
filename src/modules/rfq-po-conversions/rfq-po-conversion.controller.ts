import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { rfqPoConversionService } from './rfq-po-conversion.service';
import {
  parseCreateRfqPoConversionBody,
  parsePurchaseOrderIdParam,
  parseRfqPoAwardIdParam,
  parseRfqPoConversionIdParam,
} from './rfq-po-conversion.validation';

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}
function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}
function idempotencyHeader(req: Request): string | undefined {
  const value = req.header('Idempotency-Key');
  return value?.trim() || undefined;
}

export async function createRfqPoConversionHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await rfqPoConversionService.createRfqPoConversion(
      parseCreateRfqPoConversionBody(
        req.body,
        idempotencyHeader(req),
        parseRfqPoAwardIdParam(param(req.params.awardId)),
      ),
      actor(req),
    ), 201);
  } catch (error) { next(error); }
}

export async function getRfqPoConversionHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await rfqPoConversionService.getRfqPoConversion(
      parseRfqPoConversionIdParam(param(req.params.conversionId)), actor(req),
    ));
  } catch (error) { next(error); }
}

export async function getRfqPoProvenanceHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await rfqPoConversionService.getRfqPoProvenanceForPurchaseOrder(
      parsePurchaseOrderIdParam(param(req.params.purchaseOrderId)), actor(req),
    ));
  } catch (error) { next(error); }
}
