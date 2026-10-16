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
import type { HandymanQuotationLineServiceView }
  from '../handyman-quotations/handyman-quotation-line.types';
import {
  parseQuotationApiUuidParam,
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

/**
 * Explicit customer-facing quotation-line allow-list. The service result
 * intentionally retains immutable commercial provenance for Backend
 * calculations, but this HTTP contract never serializes reference pricing,
 * source catalog IDs, or internal actor identity.
 */
type CustomerHandymanQuotationLinePayload = Pick<
  HandymanQuotationLineServiceView,
  | 'id'
  | 'quotationVersionId'
  | 'lineType'
  | 'description'
  | 'quantity'
  | 'uomId'
  | 'finalQuotedUnitAmount'
  | 'lineTotal'
  | 'currency'
  | 'createdAt'
  | 'updatedAt'
>;

function toCustomerQuotationLinePayload(
  line: HandymanQuotationLineServiceView,
): CustomerHandymanQuotationLinePayload {
  return {
    id: line.id,
    quotationVersionId: line.quotationVersionId,
    lineType: line.lineType,
    description: line.description,
    quantity: line.quantity,
    uomId: line.uomId,
    finalQuotedUnitAmount: line.finalQuotedUnitAmount,
    lineTotal: line.lineTotal,
    currency: line.currency,
    createdAt: line.createdAt,
    updatedAt: line.updatedAt,
  };
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
      toCustomerQuotationLinePayload(
        await addHandymanQuotationLine(
          parseQuotationApiUuidParam(
            p(req.params.quotationVersionId),
            'quotationVersionId',
          ),
          parseQuotationLineBody(req.body),
          actor(req),
        ),
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
    const lines = await listHandymanQuotationVersionLines(
      parseQuotationApiUuidParam(
        p(req.params.quotationVersionId),
        'quotationVersionId',
      ),
      actor(req),
    );
    sendSuccess(res, lines.map(toCustomerQuotationLinePayload));
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
