import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../shared/errors';
import {
  buildPaginationMeta,
  hasPaginationParams,
  parsePagination,
} from '../../shared/pagination';
import { sendSuccess } from '../../shared/api-response';
import { parseIdempotencyKeyRequired } from '../request-idempotency';
import {
  activateSaasSubscription,
  cancelSaasSubscription,
  convertSaasSubscription,
  createSaasSubscription,
  getSaasSubscriptionDetail,
  listSaasSubscriptions,
  renewSaasSubscription,
  terminateSaasSubscription,
  updateSaasSubscription,
} from './platform-subscription.service';
import {
  parseActivateSaasSubscriptionBody,
  parseCancelSaasSubscriptionBody,
  parseConvertSaasSubscriptionBody,
  parseCreateSaasSubscriptionBody,
  parseListSaasSubscriptionFilters,
  parseRenewSaasSubscriptionBody,
  parseTerminateSaasSubscriptionBody,
  parseUpdateSaasSubscriptionBody,
} from './platform-subscription.validation';

/** Express 5 types path params as `string | string[]`; normalize. */
function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

function parseSubscriptionIdParam(raw: string): string {
  const value = raw?.trim();
  if (
    !value ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw AppError.validation('Request validation failed.', [
      { field: 'subscriptionId', message: 'subscriptionId must be a UUID.' },
    ]);
  }
  return value;
}

export async function listSaasSubscriptionsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const query = req.query as Record<string, unknown>;
    const filters = parseListSaasSubscriptionFilters(query);
    const pagination = parsePagination(query);
    const usePagination = hasPaginationParams(query);

    const result = await listSaasSubscriptions({
      filters,
      withTotal: usePagination,
      page: pagination.page,
      pageSize: pagination.pageSize,
    });

    sendSuccess(
      res,
      result.records,
      200,
      usePagination
        ? buildPaginationMeta(pagination.page, pagination.pageSize, result.total ?? 0)
        : {},
    );
  } catch (error) {
    next(error);
  }
}

export async function createSaasSubscriptionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const idempotencyKey = parseIdempotencyKeyRequired(
      req.header('idempotency-key'),
    );
    const input = parseCreateSaasSubscriptionBody(req.body);

    const result = await createSaasSubscription(
      req.auth.userId,
      'platform.subscription.manage',
      input,
      idempotencyKey,
    );

    sendSuccess(res, result.data, result.replayed ? 200 : 201, {
      replayed: result.replayed,
    });
  } catch (error) {
    next(error);
  }
}

export async function getSaasSubscriptionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const subscriptionId = parseSubscriptionIdParam(paramString(req.params.id));
    const detail = await getSaasSubscriptionDetail(subscriptionId);
    sendSuccess(res, detail);
  } catch (error) {
    next(error);
  }
}

export async function updateSaasSubscriptionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const subscriptionId = parseSubscriptionIdParam(paramString(req.params.id));
    const input = parseUpdateSaasSubscriptionBody(req.body);

    const updated = await updateSaasSubscription(
      req.auth.userId,
      'platform.subscription.manage',
      subscriptionId,
      input,
    );

    sendSuccess(res, updated);
  } catch (error) {
    next(error);
  }
}

export async function activateSaasSubscriptionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const idempotencyKey = parseIdempotencyKeyRequired(
      req.header('idempotency-key'),
    );
    const subscriptionId = parseSubscriptionIdParam(paramString(req.params.id));
    const input = parseActivateSaasSubscriptionBody(req.body);

    const result = await activateSaasSubscription(
      req.auth.userId,
      'platform.subscription.manage',
      subscriptionId,
      input,
      idempotencyKey,
    );

    sendSuccess(res, result.data, 200, { replayed: result.replayed });
  } catch (error) {
    next(error);
  }
}

export async function convertSaasSubscriptionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const idempotencyKey = parseIdempotencyKeyRequired(
      req.header('idempotency-key'),
    );
    const subscriptionId = parseSubscriptionIdParam(paramString(req.params.id));
    const input = parseConvertSaasSubscriptionBody(req.body);

    const result = await convertSaasSubscription(
      req.auth.userId,
      'platform.subscription.manage',
      subscriptionId,
      input,
      idempotencyKey,
    );

    sendSuccess(res, result.data, 200, { replayed: result.replayed });
  } catch (error) {
    next(error);
  }
}

export async function renewSaasSubscriptionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const subscriptionId = parseSubscriptionIdParam(paramString(req.params.id));
    const input = parseRenewSaasSubscriptionBody(req.body);

    const renewed = await renewSaasSubscription(
      req.auth.userId,
      'platform.subscription.manage',
      subscriptionId,
      input,
    );

    sendSuccess(res, renewed);
  } catch (error) {
    next(error);
  }
}

export async function cancelSaasSubscriptionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const subscriptionId = parseSubscriptionIdParam(paramString(req.params.id));
    const input = parseCancelSaasSubscriptionBody(req.body);

    const cancelled = await cancelSaasSubscription(
      req.auth.userId,
      'platform.subscription.manage',
      subscriptionId,
      input,
    );

    sendSuccess(res, cancelled);
  } catch (error) {
    next(error);
  }
}

export async function terminateSaasSubscriptionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const subscriptionId = parseSubscriptionIdParam(paramString(req.params.id));
    const input = parseTerminateSaasSubscriptionBody(req.body);

    const terminated = await terminateSaasSubscription(
      req.auth.userId,
      'platform.subscription.manage',
      subscriptionId,
      input,
    );

    sendSuccess(res, terminated);
  } catch (error) {
    next(error);
  }
}
