import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { procurementApprovalService } from './procurement-approval.service';
import {
  parseCreateProcurementApprovalBody,
  parseProcurementApprovalDecisionBody,
  parseProcurementApprovalIdParam,
  parseProcurementApprovalPendingFilters,
} from './procurement-approval.validation';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function createProcurementApprovalHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await procurementApprovalService.createProcurementApproval(
        parseCreateProcurementApprovalBody(req.body),
        actor(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function getProcurementApprovalHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await procurementApprovalService.getProcurementApproval(
        parseProcurementApprovalIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function listPendingProcurementApprovalsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await procurementApprovalService.listPendingProcurementApprovals(
        parseProcurementApprovalPendingFilters(req.query),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function approveProcurementApprovalHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await procurementApprovalService.approveProcurementApproval(
        parseProcurementApprovalIdParam(param(req.params.id)),
        parseProcurementApprovalDecisionBody(req.body, false),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function rejectProcurementApprovalHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await procurementApprovalService.rejectProcurementApproval(
        parseProcurementApprovalIdParam(param(req.params.id)),
        parseProcurementApprovalDecisionBody(req.body, true),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getProcurementApprovalActionsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await procurementApprovalService.resolveProcurementApprovalAvailableActions(
        parseProcurementApprovalIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}
