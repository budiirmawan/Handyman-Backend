import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { permitApprovalService } from './permit-approval.service';
import {
  parseCreatePermitApprovalBody,
  parsePermitApprovalApplicationIdParam,
  parsePermitApprovalDecisionBody,
  parsePermitApprovalIdParam,
  parsePermitApprovalPendingFilters,
} from './permit-approval.validation';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function createPermitApprovalHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await permitApprovalService.createPermitApproval(
        parsePermitApprovalApplicationIdParam(param(req.params.applicationId)),
        parseCreatePermitApprovalBody(req.body),
        actor(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function getPermitApprovalHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await permitApprovalService.getPermitApproval(
        parsePermitApprovalIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getPermitApprovalContextHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await permitApprovalService.resolvePermitApprovalContext(
        parsePermitApprovalApplicationIdParam(param(req.params.applicationId)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function listPendingPermitApprovalsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await permitApprovalService.listPendingPermitApprovals(
        parsePermitApprovalPendingFilters(req.query),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getPermitApprovalActionsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await permitApprovalService.resolvePermitApprovalAvailableActions(
        parsePermitApprovalIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function approvePermitApprovalHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await permitApprovalService.approvePermitApproval(
        parsePermitApprovalIdParam(param(req.params.id)),
        parsePermitApprovalDecisionBody(req.body, false),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function rejectPermitApprovalHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await permitApprovalService.rejectPermitApproval(
        parsePermitApprovalIdParam(param(req.params.id)),
        parsePermitApprovalDecisionBody(req.body, true),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function requestPermitApprovalReworkHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await permitApprovalService.requestPermitApprovalRework(
        parsePermitApprovalIdParam(param(req.params.id)),
        parsePermitApprovalDecisionBody(req.body, true),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}
