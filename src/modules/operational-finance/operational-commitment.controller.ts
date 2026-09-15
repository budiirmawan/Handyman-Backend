import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { operationalCommitmentMaterialService } from './operational-commitment-material.service';
import { operationalCommitmentService } from './operational-commitment.service';
import {
  parseAdjustOperationalCommitmentBody,
  parseCreatePoLineCommitmentBody,
  parseCloseOperationalCommitmentBody,
  parseCreateOperationalCommitmentBody,
  parseOperationalBudgetOverspendPolicyBody,
  parseOperationalCommitmentFilters,
  parseOperationalCommitmentIdParam,
} from './operational-commitment.validation';
import { parseOperationalBudgetIdParam } from './operational-finance.validation';

/**
 * CR-BE-COMM-VAR-01 PART 02 — Operational Commitment HTTP boundary.
 *
 * There is deliberately no endpoint that writes an actual amount, edits a
 * commitment amount in place, or moves a commitment between budgets.
 */

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function createOperationalCommitmentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await operationalCommitmentService.createOperationalCommitment(
        parseOperationalBudgetIdParam(param(req.params.budgetId)),
        parseCreateOperationalCommitmentBody(req.body),
        actor(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function createPurchaseOrderLineCommitmentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await operationalCommitmentMaterialService.createPurchaseOrderLineCommitment(
        parseOperationalBudgetIdParam(param(req.params.budgetId)),
        parseCreatePoLineCommitmentBody(req.body),
        actor(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function listOperationalCommitmentsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await operationalCommitmentService.listOperationalCommitments(
        parseOperationalBudgetIdParam(param(req.params.budgetId)),
        parseOperationalCommitmentFilters(req.query),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getOperationalCommitmentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await operationalCommitmentService.getOperationalCommitment(
        parseOperationalCommitmentIdParam(param(req.params.id)),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function adjustOperationalCommitmentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await operationalCommitmentService.adjustOperationalCommitment(
        parseOperationalCommitmentIdParam(param(req.params.id)),
        parseAdjustOperationalCommitmentBody(req.body),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function releaseOperationalCommitmentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await operationalCommitmentService.releaseOperationalCommitment(
        parseOperationalCommitmentIdParam(param(req.params.id)),
        parseCloseOperationalCommitmentBody(req.body),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function cancelOperationalCommitmentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await operationalCommitmentService.cancelOperationalCommitment(
        parseOperationalCommitmentIdParam(param(req.params.id)),
        parseCloseOperationalCommitmentBody(req.body),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function changeOperationalBudgetOverspendPolicyHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await operationalCommitmentService.changeOperationalBudgetOverspendPolicy(
        parseOperationalBudgetIdParam(param(req.params.id)),
        parseOperationalBudgetOverspendPolicyBody(req.body),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}
