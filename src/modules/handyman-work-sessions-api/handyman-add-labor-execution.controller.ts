import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { AppError } from '../../shared/errors';
import { authenticationRequiredError } from '../auth';
import { listAddLaborExecutions, recordAddLaborExecution } from '../handyman-work-sessions/handyman-add-labor-execution.service';
import { parseWorkSessionIdParam, parseWorkSessionScopeParam } from './handyman-work-sessions-api.validation';

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function postAddLaborExecution(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    // No field actor may author commercial terms or turn helpers into a claim.
    if (['price', 'unitPrice', 'quotedUnitAmount', 'charge', 'rate', 'helperCount', 'helpers', 'manpower']
      .some((field) => body[field] !== undefined)) {
      throw AppError.validation('Labor execution cannot contain prices, charges or helper manpower.');
    }
    const result = await recordAddLaborExecution({
      executionScopeId: parseWorkSessionScopeParam(req.params.executionScopeId),
      sessionId: parseWorkSessionIdParam(req.params.sessionId),
      variationId: body.variationId,
      approvedVariationVersion: body.approvedVariationVersion,
      quotationLineId: body.quotationLineId,
      workOrderId: body.workOrderId,
      quantity: body.quantity,
      evidenceReference: body.evidenceReference,
      idempotencyKey: body.idempotencyKey,
    }, actor(req));
    sendSuccess(res, result, 200);
  } catch (error) { next(error); }
}

export async function getAddLaborExecutions(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const executions = await listAddLaborExecutions(
      parseWorkSessionScopeParam(req.params.executionScopeId), parseWorkSessionIdParam(req.params.sessionId), actor(req),
    );
    sendSuccess(res, { executions }, 200);
  } catch (error) { next(error); }
}
