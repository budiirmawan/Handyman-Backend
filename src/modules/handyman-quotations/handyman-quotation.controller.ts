import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import {
  addHandymanQuotationLine,
  listHandymanQuotationLines,
  removeHandymanQuotationLine,
  updateHandymanQuotationLine,
} from './handyman-quotation-line.service';
import {
  createHandymanQuotationRevision,
  getHandymanQuotationRevision,
  listHandymanQuotationRevisions,
  submitHandymanQuotationRevision,
} from './handyman-quotation-revision.service';
import {
  createHandymanQuotation,
  getHandymanQuotation,
  listHandymanQuotationsByRequest,
  sendHandymanQuotation,
  withdrawHandymanQuotation,
} from './handyman-quotation.service';
import {
  parseAddHandymanQuotationLineHttpBody,
  parseCreateHandymanQuotationHttpBody,
  parseCreateHandymanQuotationRevisionHttpBody,
  parseHandymanQuotationIdParam,
  parseHandymanQuotationLineIdParam,
  parseHandymanQuotationRequestIdParam,
  parseHandymanQuotationRevisionIdParam,
  parseSendHandymanQuotationHttpBody,
  parseUpdateHandymanQuotationLineHttpBody,
} from './handyman-quotation.validation';
import { parseEmptyCommandBody } from '../handyman-request-governance/handyman-request-governance.validation';

/**
 * CR-HM-BE-03 RUN 4 — thin HTTP handlers for the Run 2 customer quotation
 * commerce authority. The request/quotation/revision scope comes from the
 * route, the actor only from the authenticated session, the optional
 * Idempotency-Key header is forwarded to the existing create service, and
 * every business rule (pricing governance, lifecycle guards, access,
 * concurrency) stays in the Run 2 services; these handlers only parse
 * governed inputs and delegate. Errors flow to the shared Express error
 * pipeline via `next(error)`.
 */

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

function idempotencyHeader(req: Request): string | undefined {
  const value = req.header('Idempotency-Key');
  return value?.trim() || undefined;
}

// ---------------------------------------------------------------------------
// Quotation envelope
// ---------------------------------------------------------------------------

export async function createHandymanQuotationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const requestId = parseHandymanQuotationRequestIdParam(
      param(req.params.handymanRequestId),
    );
    const body = parseCreateHandymanQuotationHttpBody(req.body);
    sendSuccess(
      res,
      await createHandymanQuotation(
        { requestId, ...body, idempotencyKey: idempotencyHeader(req) ?? null },
        actor(req),
      ),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function listRequestHandymanQuotationsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const requestId = parseHandymanQuotationRequestIdParam(
      param(req.params.handymanRequestId),
    );
    sendSuccess(res, await listHandymanQuotationsByRequest(requestId, actor(req)));
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
    const quotationId = parseHandymanQuotationIdParam(param(req.params.quotationId));
    sendSuccess(res, await getHandymanQuotation(quotationId, actor(req)));
  } catch (error) {
    next(error);
  }
}

export async function sendHandymanQuotationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const quotationId = parseHandymanQuotationIdParam(param(req.params.quotationId));
    const body = parseSendHandymanQuotationHttpBody(req.body);
    sendSuccess(
      res,
      await sendHandymanQuotation({ quotationId, ...body }, actor(req)),
    );
  } catch (error) {
    next(error);
  }
}

export async function withdrawHandymanQuotationHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const quotationId = parseHandymanQuotationIdParam(param(req.params.quotationId));
    parseEmptyCommandBody(req.body);
    sendSuccess(res, await withdrawHandymanQuotation(quotationId, actor(req)));
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------------
// Revisions
// ---------------------------------------------------------------------------

export async function createHandymanQuotationRevisionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const quotationId = parseHandymanQuotationIdParam(param(req.params.quotationId));
    const body = parseCreateHandymanQuotationRevisionHttpBody(req.body);
    sendSuccess(
      res,
      await createHandymanQuotationRevision({ quotationId, ...body }, actor(req)),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function listHandymanQuotationRevisionsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const quotationId = parseHandymanQuotationIdParam(param(req.params.quotationId));
    sendSuccess(res, await listHandymanQuotationRevisions(quotationId, actor(req)));
  } catch (error) {
    next(error);
  }
}

export async function getHandymanQuotationRevisionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const revisionId = parseHandymanQuotationRevisionIdParam(
      param(req.params.revisionId),
    );
    sendSuccess(res, await getHandymanQuotationRevision(revisionId, actor(req)));
  } catch (error) {
    next(error);
  }
}

export async function submitHandymanQuotationRevisionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const revisionId = parseHandymanQuotationRevisionIdParam(
      param(req.params.revisionId),
    );
    parseEmptyCommandBody(req.body);
    sendSuccess(res, await submitHandymanQuotationRevision(revisionId, actor(req)));
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------------
// DRAFT lines
// ---------------------------------------------------------------------------

export async function addHandymanQuotationLineHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const revisionId = parseHandymanQuotationRevisionIdParam(
      param(req.params.revisionId),
  );
    const body = parseAddHandymanQuotationLineHttpBody(req.body);
    sendSuccess(
      res,
      await addHandymanQuotationLine({ revisionId, ...body }, actor(req)),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function listHandymanQuotationLinesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const revisionId = parseHandymanQuotationRevisionIdParam(
      param(req.params.revisionId),
    );
    sendSuccess(res, await listHandymanQuotationLines(revisionId, actor(req)));
  } catch (error) {
    next(error);
  }
}

export async function updateHandymanQuotationLineHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const lineId = parseHandymanQuotationLineIdParam(param(req.params.lineId));
    const body = parseUpdateHandymanQuotationLineHttpBody(req.body);
    sendSuccess(res, await updateHandymanQuotationLine(lineId, body, actor(req)));
  } catch (error) {
    next(error);
  }
}

export async function removeHandymanQuotationLineHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const lineId = parseHandymanQuotationLineIdParam(param(req.params.lineId));
    parseEmptyCommandBody(req.body);
    sendSuccess(res, await removeHandymanQuotationLine(lineId, actor(req)));
  } catch (error) {
    next(error);
  }
}
