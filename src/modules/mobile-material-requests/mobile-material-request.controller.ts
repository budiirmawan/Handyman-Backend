import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { parseMaterialRequestIdParam } from '../material-requests';
import { parseIdempotencyKeyRequired } from '../request-idempotency';
import { parseWorkOrderIdParam } from '../work-order-actions';
import {
  cancelMobileMaterialRequest,
  createMobileWorkOrderMaterialRequest,
  getMobileMaterialRequest,
  listMobileWorkOrderMaterialItems,
  listMobileWorkOrderMaterialRequests,
  recordMobileWorkOrderMaterialUsage,
} from './mobile-material-request.service';
import {
  parseMobileMaterialRequestBody,
  parseMobileMaterialUsageBody,
} from './mobile-material-request.validation';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

export async function listMobileWorkOrderMaterialRequestsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const workOrderId = parseWorkOrderIdParam(param(req.params.workOrderId));
    sendSuccess(res, await listMobileWorkOrderMaterialRequests(workOrderId, req.auth.userId));
  } catch (error) {
    next(error);
  }
}

export async function createMobileWorkOrderMaterialRequestHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const workOrderId = parseWorkOrderIdParam(param(req.params.workOrderId));
    const input = parseMobileMaterialRequestBody(req.body);
    const rawHeader = req.headers['idempotency-key'];
    const idempotencyKey = parseIdempotencyKeyRequired(
      Array.isArray(rawHeader) ? rawHeader[0] : rawHeader,
    );
    const result = await createMobileWorkOrderMaterialRequest(
      workOrderId,
      req.auth.userId,
      input,
      idempotencyKey,
    );
    sendSuccess(res, result.data, 201);
  } catch (error) {
    next(error);
  }
}

export async function getMobileMaterialRequestHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const id = parseMaterialRequestIdParam(param(req.params.materialRequestId));
    sendSuccess(res, await getMobileMaterialRequest(id, req.auth.userId));
  } catch (error) {
    next(error);
  }
}

export async function cancelMobileMaterialRequestHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const id = parseMaterialRequestIdParam(param(req.params.materialRequestId));
    sendSuccess(res, await cancelMobileMaterialRequest(id, req.auth.userId));
  } catch (error) {
    next(error);
  }
}

/** PART 02 — GET /mobile/work-orders/:workOrderId/material-items */
export async function listMobileWorkOrderMaterialItemsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const workOrderId = parseWorkOrderIdParam(param(req.params.workOrderId));
    sendSuccess(res, await listMobileWorkOrderMaterialItems(workOrderId, req.auth.userId));
  } catch (error) {
    next(error);
  }
}

/** PART 03 — POST /mobile/work-orders/:workOrderId/material-usages */
export async function recordMobileWorkOrderMaterialUsageHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const workOrderId = parseWorkOrderIdParam(param(req.params.workOrderId));
    const input = parseMobileMaterialUsageBody(req.body);
    const rawHeader = req.headers['idempotency-key'];
    const idempotencyKey = parseIdempotencyKeyRequired(
      Array.isArray(rawHeader) ? rawHeader[0] : rawHeader,
    );
    const result = await recordMobileWorkOrderMaterialUsage(
      workOrderId,
      req.auth.userId,
      input,
      idempotencyKey,
    );
    sendSuccess(res, result.data, 201);
  } catch (error) {
    next(error);
  }
}
