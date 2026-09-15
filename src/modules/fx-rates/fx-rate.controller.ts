import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { clientFxPolicyService } from './client-fx-policy.service';
import { fxRateLifecycleService } from './fx-rate-lifecycle.service';
import { fxRateEventRepository, fxRateRepository } from './fx-rate.repository';
import { fxRateNotFoundError } from './fx-rate.errors';
import {
  parseClientId,
  parseCreateFxRateBody,
  parseFxRateFilters,
  parseFxRateId,
  parseReasonBody,
  parseSetClientFxPolicyBody,
  parseSupersedeFxRateBody,
} from './fx-rate.request-validation';

/**
 * CR-BE-FX-01 PART 02 — HTTP handlers.
 *
 * Deliberately thin: parse the request, call the service, send the result. No
 * business rule lives here. Authorization is applied by `requirePermission` on
 * the route, never in the handler.
 *
 * There is intentionally NO conversion, quote, reporting-conversion, provider
 * ingestion or dashboard endpoint — PART 02 governs which rate may exist.
 */

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? value[0] ?? '' : value ?? '';

export async function createFxRateHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = parseCreateFxRateBody(req.body);
    const result = await fxRateLifecycleService.createRate(body, req.auth!.userId);
    sendSuccess(res, result.rate, 201);
  } catch (error) {
    next(error);
  }
}

export async function listFxRatesHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const filters = parseFxRateFilters(req.query as Record<string, unknown>);
    sendSuccess(res, await fxRateRepository.list(filters));
  } catch (error) {
    next(error);
  }
}

export async function getFxRateHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rateId = parseFxRateId(param(req.params.rateId));
    const rate = await fxRateRepository.findById(rateId);
    if (!rate) throw fxRateNotFoundError(rateId);
    sendSuccess(res, rate);
  } catch (error) {
    next(error);
  }
}

export async function approveFxRateHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rateId = parseFxRateId(param(req.params.rateId));
    const result = await fxRateLifecycleService.approveRate(rateId, req.auth!.userId);
    sendSuccess(res, result.rate);
  } catch (error) {
    next(error);
  }
}

export async function rejectFxRateHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rateId = parseFxRateId(param(req.params.rateId));
    const reason = parseReasonBody(req.body, 'reason');
    const result = await fxRateLifecycleService.rejectRate(rateId, req.auth!.userId, reason);
    sendSuccess(res, result.rate);
  } catch (error) {
    next(error);
  }
}

export async function supersedeFxRateHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rateId = parseFxRateId(param(req.params.rateId));
    const body = parseSupersedeFxRateBody(req.body);
    const result = await fxRateLifecycleService.supersedeRate(rateId, body, req.auth!.userId);
    sendSuccess(res, { superseded: result.rate, successor: result.successor ?? null });
  } catch (error) {
    next(error);
  }
}

export async function deactivateFxRateHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rateId = parseFxRateId(param(req.params.rateId));
    const reason = parseReasonBody(req.body, 'reason');
    const result = await fxRateLifecycleService.deactivateRate(rateId, req.auth!.userId, reason);
    sendSuccess(res, result.rate);
  } catch (error) {
    next(error);
  }
}

export async function listFxRateEventsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rateId = parseFxRateId(param(req.params.rateId));
    sendSuccess(res, await fxRateEventRepository.listForRate(rateId));
  } catch (error) {
    next(error);
  }
}

export async function getClientFxPolicyHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const clientId = parseClientId(param(req.params.clientId));
    sendSuccess(res, await clientFxPolicyService.getClientFxPolicy(clientId, req.auth!.userId));
  } catch (error) {
    next(error);
  }
}

export async function setClientFxPolicyHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const clientId = parseClientId(param(req.params.clientId));
    const body = parseSetClientFxPolicyBody(clientId, req.body);
    sendSuccess(res, await clientFxPolicyService.setClientFxPolicy(body, req.auth!.userId));
  } catch (error) {
    next(error);
  }
}
