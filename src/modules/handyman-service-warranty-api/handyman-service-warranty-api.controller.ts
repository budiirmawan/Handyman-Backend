import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import {
  acceptCustomerChargeableAdditionalWork,
  approveCustomerServiceWarrantyClaim,
  authorizeCustomerServiceWarrantyRework,
  openCustomerServiceWarrantyClaim,
  readChargeableAdditionalWorkByIdView,
  readExecutionScopeServiceWarrantyView,
  readServiceWarrantyByIdView,
  readServiceWarrantyClaimByIdView,
  readServiceWarrantyReworkByIdView,
  rejectCustomerChargeableAdditionalWork,
  rejectCustomerServiceWarrantyClaim,
  submitCustomerServiceWarrantyClaim,
  withdrawCustomerServiceWarrantyClaim,
} from './handyman-service-warranty-api.service';

/**
 * CR-HM-17 GAP PART 06 — Thin HTTP handlers over CR-HM-15 Service Warranty,
 * Claim, Free Rework & Chargeable Additional Work contracts and governed
 * Customer Care claim/decision commands.
 *
 * Field-worker rework execution commands (`propose`, `start`, `complete`,
 * `verify`) and warranty lifecycle calculation commands (`start`, `expire`)
 * are NEVER imported or exposed here.
 */

const p = (v: string | string[] | undefined) =>
  (Array.isArray(v) ? v[0] : v) ?? '';

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function getExecutionScopeServiceWarrantyHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const data = await readExecutionScopeServiceWarrantyView(
      actor(req),
      p(req.params.executionScopeId),
    );
    sendSuccess(res, data);
  } catch (error) {
    next(error);
  }
}

export async function getServiceWarrantyByIdHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const data = await readServiceWarrantyByIdView(
      actor(req),
      p(req.params.warrantyId),
    );
    sendSuccess(res, data);
  } catch (error) {
    next(error);
  }
}

export async function getServiceWarrantyClaimByIdHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const data = await readServiceWarrantyClaimByIdView(
      actor(req),
      p(req.params.claimId),
    );
    sendSuccess(res, data);
  } catch (error) {
    next(error);
  }
}

export async function getServiceWarrantyReworkByIdHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const data = await readServiceWarrantyReworkByIdView(
      actor(req),
      p(req.params.reworkId),
    );
    sendSuccess(res, data);
  } catch (error) {
    next(error);
  }
}

export async function getChargeableAdditionalWorkByIdHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const data = await readChargeableAdditionalWorkByIdView(
      actor(req),
      p(req.params.workId),
    );
    sendSuccess(res, data);
  } catch (error) {
    next(error);
  }
}

export async function postOpenServiceWarrantyClaimHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const data = await openCustomerServiceWarrantyClaim(
      actor(req),
      p(req.params.warrantyId),
      req.body,
    );
    sendSuccess(res, data);
  } catch (error) {
    next(error);
  }
}

export async function postSubmitServiceWarrantyClaimHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const data = await submitCustomerServiceWarrantyClaim(
      actor(req),
      p(req.params.claimId),
      req.body,
    );
    sendSuccess(res, data);
  } catch (error) {
    next(error);
  }
}

export async function postApproveServiceWarrantyClaimHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const data = await approveCustomerServiceWarrantyClaim(
      actor(req),
      p(req.params.claimId),
      req.body,
    );
    sendSuccess(res, data);
  } catch (error) {
    next(error);
  }
}

export async function postRejectServiceWarrantyClaimHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const data = await rejectCustomerServiceWarrantyClaim(
      actor(req),
      p(req.params.claimId),
      req.body,
    );
    sendSuccess(res, data);
  } catch (error) {
    next(error);
  }
}

export async function postWithdrawServiceWarrantyClaimHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const data = await withdrawCustomerServiceWarrantyClaim(
      actor(req),
      p(req.params.claimId),
      req.body,
    );
    sendSuccess(res, data);
  } catch (error) {
    next(error);
  }
}

export async function postAuthorizeServiceWarrantyReworkHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const data = await authorizeCustomerServiceWarrantyRework(
      actor(req),
      p(req.params.reworkId),
      req.body,
    );
    sendSuccess(res, data);
  } catch (error) {
    next(error);
  }
}

export async function postAcceptChargeableAdditionalWorkHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const data = await acceptCustomerChargeableAdditionalWork(
      actor(req),
      p(req.params.workId),
      req.body,
    );
    sendSuccess(res, data);
  } catch (error) {
    next(error);
  }
}

export async function postRejectChargeableAdditionalWorkHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const data = await rejectCustomerChargeableAdditionalWork(
      actor(req),
      p(req.params.workId),
      req.body,
    );
    sendSuccess(res, data);
  } catch (error) {
    next(error);
  }
}
