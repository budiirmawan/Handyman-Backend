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
import type {
  PublicHandymanExecutionScope,
  PublicHandymanQuotationBundle,
  PublicHandymanQuotationDecision,
  PublicHandymanQuotationVersion,
} from '../handyman-quotations';
import type { HandymanQuotationLineServiceView }
  from '../handyman-quotations/handyman-quotation-line.types';
import {
  parseQuotationApiUuidParam,
  parseQuotationDecisionBody,
  parseQuotationDpTermsBody,
  parseQuotationRevisionBody,
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

type CustomerHandymanQuotationVersionPayload = Pick<
  PublicHandymanQuotationVersion,
  | 'id'
  | 'quotationId'
  | 'versionNumber'
  | 'status'
  | 'validUntil'
  | 'dpRequired'
  | 'dpPercentage'
  | 'dpAmount'
  | 'dpTermsNotes'
  | 'createdAt'
  | 'updatedAt'
>;

function toCustomerQuotationVersionPayload(
  version: PublicHandymanQuotationVersion,
): CustomerHandymanQuotationVersionPayload {
  return {
    id: version.id,
    quotationId: version.quotationId,
    versionNumber: version.versionNumber,
    status: version.status,
    validUntil: version.validUntil,
    dpRequired: version.dpRequired,
    dpPercentage: version.dpPercentage,
    dpAmount: version.dpAmount,
    dpTermsNotes: version.dpTermsNotes,
    createdAt: version.createdAt,
    updatedAt: version.updatedAt,
  };
}

type CustomerHandymanQuotationBundlePayload = {
  quotation: Pick<
    PublicHandymanQuotationBundle['quotation'],
    'id' | 'clientId' | 'handymanRequestId' | 'createdAt' | 'updatedAt'
  >;
  versions: CustomerHandymanQuotationVersionPayload[];
};

function toCustomerQuotationBundlePayload(
  bundle: PublicHandymanQuotationBundle,
): CustomerHandymanQuotationBundlePayload {
  return {
    quotation: {
      id: bundle.quotation.id,
      clientId: bundle.quotation.clientId,
      handymanRequestId: bundle.quotation.handymanRequestId,
      createdAt: bundle.quotation.createdAt,
      updatedAt: bundle.quotation.updatedAt,
    },
    versions: bundle.versions.map(toCustomerQuotationVersionPayload),
  };
}

type CustomerHandymanQuotationDecisionPayload = Pick<
  PublicHandymanQuotationDecision,
  | 'id'
  | 'clientId'
  | 'quotationId'
  | 'quotationVersionId'
  | 'decision'
  | 'tenantCompanyId'
  | 'tenantPicId'
  | 'idempotencyKey'
  | 'decidedAt'
  | 'createdAt'
  | 'updatedAt'
>;

function toCustomerQuotationDecisionPayload(
  decision: PublicHandymanQuotationDecision,
): CustomerHandymanQuotationDecisionPayload {
  return {
    id: decision.id,
    clientId: decision.clientId,
    quotationId: decision.quotationId,
    quotationVersionId: decision.quotationVersionId,
    decision: decision.decision,
    tenantCompanyId: decision.tenantCompanyId,
    tenantPicId: decision.tenantPicId,
    idempotencyKey: decision.idempotencyKey,
    decidedAt: decision.decidedAt,
    createdAt: decision.createdAt,
    updatedAt: decision.updatedAt,
  };
}

type CustomerHandymanExecutionScopePayload = Pick<
  PublicHandymanExecutionScope,
  | 'id'
  | 'clientId'
  | 'handymanRequestId'
  | 'channelAttributionId'
  | 'quotationId'
  | 'approvedQuotationVersionId'
  | 'quotationDecisionId'
  | 'tenantCompanyId'
  | 'tenantPicId'
  | 'buildingId'
  | 'floorId'
  | 'areaId'
  | 'roomId'
  | 'spaceId'
  | 'status'
  | 'createdAt'
  | 'updatedAt'
>;

function toCustomerExecutionScopePayload(
  scope: PublicHandymanExecutionScope,
): CustomerHandymanExecutionScopePayload {
  return {
    id: scope.id,
    clientId: scope.clientId,
    handymanRequestId: scope.handymanRequestId,
    channelAttributionId: scope.channelAttributionId,
    quotationId: scope.quotationId,
    approvedQuotationVersionId: scope.approvedQuotationVersionId,
    quotationDecisionId: scope.quotationDecisionId,
    tenantCompanyId: scope.tenantCompanyId,
    tenantPicId: scope.tenantPicId,
    buildingId: scope.buildingId,
    floorId: scope.floorId,
    areaId: scope.areaId,
    roomId: scope.roomId,
    spaceId: scope.spaceId,
    status: scope.status,
    createdAt: scope.createdAt,
    updatedAt: scope.updatedAt,
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
          ...parseQuotationDpTermsBody(req.body),
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
    const bundle = await getHandymanQuotation(
      parseQuotationApiUuidParam(
        p(req.params.handymanRequestId),
        'handymanRequestId',
      ),
      actor(req),
    );
    sendSuccess(res, toCustomerQuotationBundlePayload(bundle));
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
    const version = await getCurrentHandymanIssuedQuotationVersion(
      parseQuotationApiUuidParam(
        p(req.params.handymanRequestId),
        'handymanRequestId',
      ),
      actor(req),
    );
    sendSuccess(
      res,
      version ? toCustomerQuotationVersionPayload(version) : null,
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
    const { carryForwardLineIds, ...dpTerms } = parseQuotationRevisionBody(
      req.body,
    );
    sendSuccess(
      res,
      await createHandymanQuotationRevision(
        parseQuotationApiUuidParam(
          p(req.params.quotationId),
          'quotationId',
        ),
        actor(req),
        dpTerms,
        carryForwardLineIds === undefined ? {} : { carryForwardLineIds },
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
    const decision = await getHandymanQuotationDecision(
      parseQuotationApiUuidParam(
        p(req.params.quotationVersionId),
        'quotationVersionId',
      ),
      actor(req),
    );
    sendSuccess(res, toCustomerQuotationDecisionPayload(decision));
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
    const scope = await getHandymanExecutionScopeByQuotationVersion(
      parseQuotationApiUuidParam(
        p(req.params.quotationVersionId),
        'quotationVersionId',
      ),
      actor(req),
    );
    sendSuccess(res, toCustomerExecutionScopePayload(scope));
  } catch (error) {
    next(error);
  }
}
