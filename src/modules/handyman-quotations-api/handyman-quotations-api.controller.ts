import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import {
  addHandymanQuotationLine,
  createHandymanQuotation,
  createHandymanQuotationRevision,
  decideHandymanQuotation,
  expireHandymanQuotationVersion,
  getCurrentHandymanIssuedQuotationVersion,
  getHandymanExecutionScopeByQuotationVersion,
  getHandymanQuotation,
  getHandymanQuotationDecision,
  getHandymanQuotationVersionTotals,
  issueHandymanQuotationVersion,
  listHandymanQuotationVersionLines,
  supersedeHandymanQuotationVersion,
} from '../handyman-quotations';
import {
  bindHandymanQuotationApprovalBinding,
  getHandymanQuotationApprovalBinding,
  revokeHandymanQuotationApprovalBinding,
} from '../handyman-quotation-approval-bindings';
import {
  parseQuotationApiUuidParam,
  parseQuotationApprovalBindingBody,
  parseQuotationApprovalBindingRevokeBody,
  parseQuotationDecisionBody,
  parseQuotationIssueBody,
  parseQuotationLineBody,
} from './handyman-quotations-api.validation';

/**
 * CR-HM-06 PART 07A — Handyman quotation HTTP handlers. Thin shells:
 * URL ids + whitelisted bodies + authenticated actor from
 * `req.auth.userId`; PART 01–05 services are the sole authority for
 * lineage, money, lifecycle, decision and scope semantics. ZERO crew/
 * scheduling/arrival/QR/geofence/work-session/payment/BAST/FM handlers.
 */

const p = (v: string | string[] | undefined) =>
  (Array.isArray(v) ? v[0] : v) ?? '';

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

function idempotencyHeader(req: Request): string {
  return req.header('Idempotency-Key')?.trim() ?? '';
}

export async function postHandymanQuotationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await createHandymanQuotation(
        {
          handymanRequestId: parseQuotationApiUuidParam(
            p(req.params.handymanRequestId),
            'handymanRequestId',
          ),
        },
        actor(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function getHandymanQuotationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await getHandymanQuotation(
        parseQuotationApiUuidParam(
          p(req.params.handymanRequestId),
          'handymanRequestId',
        ),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getHandymanPresentedQuotationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await getCurrentHandymanIssuedQuotationVersion(
        parseQuotationApiUuidParam(
          p(req.params.handymanRequestId),
          'handymanRequestId',
        ),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function postHandymanQuotationRevisionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await createHandymanQuotationRevision(
        parseQuotationApiUuidParam(
          p(req.params.quotationId),
          'quotationId',
        ),
        actor(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function postHandymanQuotationLineHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await addHandymanQuotationLine(
        parseQuotationApiUuidParam(
          p(req.params.quotationVersionId),
          'quotationVersionId',
        ),
        parseQuotationLineBody(req.body),
        actor(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function getHandymanQuotationLinesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await listHandymanQuotationVersionLines(
        parseQuotationApiUuidParam(
          p(req.params.quotationVersionId),
          'quotationVersionId',
        ),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getHandymanQuotationTotalsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await getHandymanQuotationVersionTotals(
        parseQuotationApiUuidParam(
          p(req.params.quotationVersionId),
          'quotationVersionId',
        ),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function postHandymanQuotationIssueHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await issueHandymanQuotationVersion(
        parseQuotationApiUuidParam(
          p(req.params.quotationVersionId),
          'quotationVersionId',
        ),
        parseQuotationIssueBody(req.body),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function postHandymanQuotationExpireHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await expireHandymanQuotationVersion(
        parseQuotationApiUuidParam(
          p(req.params.quotationVersionId),
          'quotationVersionId',
        ),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function postHandymanQuotationSupersedeHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await supersedeHandymanQuotationVersion(
        parseQuotationApiUuidParam(
          p(req.params.quotationVersionId),
          'quotationVersionId',
        ),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function postHandymanQuotationDecisionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await decideHandymanQuotation(
        parseQuotationApiUuidParam(
          p(req.params.quotationVersionId),
          'quotationVersionId',
        ),
        {
          ...parseQuotationDecisionBody(req.body),
          idempotencyKey: idempotencyHeader(req),
        },
        actor(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function getHandymanQuotationDecisionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await getHandymanQuotationDecision(
        parseQuotationApiUuidParam(
          p(req.params.quotationVersionId),
          'quotationVersionId',
        ),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function getHandymanExecutionScopeHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await getHandymanExecutionScopeByQuotationVersion(
        parseQuotationApiUuidParam(
          p(req.params.quotationVersionId),
          'quotationVersionId',
        ),
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

/**
 * W03 PART 03B2 — Tenant PIC approval-binding staff surface (ADD-A C21/C22,
 * B8/B11, A01 §9). Thin shells, exactly like the quotation handlers above:
 * URL id + whitelisted body + `Idempotency-Key` header + authenticated actor,
 * and the service module owns every eligibility decision.
 *
 * The three handlers are the ONLY way a binding row is ever written, and none
 * of them can approve anything: the ledger write path has no reachable
 * `handyman_quotation_decisions` surface (B9). A replayed write returns the
 * ORIGINAL stored success (same body, same status) with `replayed: true`, and
 * a revoke of an already-revoked thread is a 200 restatement, never an error.
 */

export async function postHandymanQuotationApprovalBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { status, data } = await bindHandymanQuotationApprovalBinding(
      {
        quotationId: parseQuotationApiUuidParam(
          p(req.params.quotationId),
          'quotationId',
        ),
        ...parseQuotationApprovalBindingBody(req.body),
        idempotencyKey: idempotencyHeader(req),
      },
      actor(req),
    );
    sendSuccess(res, data, status);
  } catch (error) {
    next(error);
  }
}

export async function postHandymanQuotationApprovalBindingRevokeHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { status, data } = await revokeHandymanQuotationApprovalBinding(
      {
        quotationId: parseQuotationApiUuidParam(
          p(req.params.quotationId),
          'quotationId',
        ),
        ...parseQuotationApprovalBindingRevokeBody(req.body),
        idempotencyKey: idempotencyHeader(req),
      },
      actor(req),
    );
    sendSuccess(res, data, status);
  } catch (error) {
    next(error);
  }
}

export async function getHandymanQuotationApprovalBindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    sendSuccess(
      res,
      await getHandymanQuotationApprovalBinding({
        quotationId: parseQuotationApiUuidParam(
          p(req.params.quotationId),
          'quotationId',
        ),
        actorUserId: actor(req),
      }),
    );
  } catch (error) {
    next(error);
  }
}
