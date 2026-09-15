import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { vendorQuotationService } from './vendor-quotation.service';
import {
  parseCreateQuotationAttachmentBody,
  parseCreateVendorQuotationBody,
  parseCreateVendorQuotationLineBody,
  parseCreateVendorQuotationRevisionBody,
  parseInvitationIdParam,
  parseQuotationFilters,
  parseQuotationIdParam,
  parseQuotationLineIdParam,
  parseQuotationRevisionIdParam,
  parseUpdateVendorQuotationLineBody,
  parseUpdateVendorQuotationRevisionBody,
} from './vendor-quotation.validation';

function param(value: string | string[] | undefined): string { return Array.isArray(value) ? value[0] ?? '' : value ?? ''; }
function key(req: Request): string | undefined { return req.header('Idempotency-Key')?.trim() || undefined; }
function session(req: Request) { return req.vendorRfqSession!; }

export async function createVendorQuotationHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const context = session(req);
    const invitationId = parseInvitationIdParam(param(req.params.invitationId));
    const input = parseCreateVendorQuotationBody(req.body, key(req));
    sendSuccess(res, await vendorQuotationService.createVendorQuotation(context, { ...input, invitationId }), 201);
  } catch (error) { next(error); }
}

export async function getVendorCurrentQuotationHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { sendSuccess(res, await vendorQuotationService.getVendorCurrentQuotation(session(req))); } catch (error) { next(error); }
}
export async function getVendorQuotationHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { sendSuccess(res, await vendorQuotationService.getVendorQuotation(session(req), parseQuotationIdParam(param(req.params.quotationId)))); } catch (error) { next(error); }
}
export async function listVendorQuotationRevisionsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { sendSuccess(res, await vendorQuotationService.listVendorQuotationRevisions(session(req), parseQuotationIdParam(param(req.params.quotationId)))); } catch (error) { next(error); }
}
export async function createVendorQuotationRevisionHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await vendorQuotationService.createVendorQuotationRevision(session(req), {
      ...parseCreateVendorQuotationRevisionBody(req.body, key(req)),
      quotationId: parseQuotationIdParam(param(req.params.quotationId)),
    }), 201);
  } catch (error) { next(error); }
}
export async function updateVendorQuotationRevisionHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { sendSuccess(res, await vendorQuotationService.updateVendorQuotationRevision(session(req), parseQuotationRevisionIdParam(param(req.params.revisionId)), parseUpdateVendorQuotationRevisionBody(req.body))); } catch (error) { next(error); }
}
export async function addVendorQuotationLineHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { sendSuccess(res, await vendorQuotationService.addVendorQuotationLine(session(req), parseQuotationRevisionIdParam(param(req.params.revisionId)), parseCreateVendorQuotationLineBody(req.body)), 201); } catch (error) { next(error); }
}
export async function updateVendorQuotationLineHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { sendSuccess(res, await vendorQuotationService.updateVendorQuotationLine(session(req), parseQuotationLineIdParam(param(req.params.lineId)), parseUpdateVendorQuotationLineBody(req.body))); } catch (error) { next(error); }
}
export async function submitVendorQuotationRevisionHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { sendSuccess(res, await vendorQuotationService.submitVendorQuotationRevision(session(req), parseQuotationRevisionIdParam(param(req.params.revisionId)))); } catch (error) { next(error); }
}
export async function addVendorQuotationAttachmentHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await vendorQuotationService.addVendorQuotationAttachment(session(req), {
      ...parseCreateQuotationAttachmentBody(req.body),
      quotationRevisionId: parseQuotationRevisionIdParam(param(req.params.revisionId)),
    }), 201);
  } catch (error) { next(error); }
}
export async function listVendorQuotationAttachmentsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const revisionId = parseQuotationRevisionIdParam(param(req.params.revisionId));
    sendSuccess(res, await vendorQuotationService.listVendorQuotationAttachments(session(req), revisionId));
  } catch (error) { next(error); }
}
export async function getVendorQuotationAttachmentHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { sendSuccess(res, await vendorQuotationService.getQuotationAttachment(parseQuotationAttachmentId(param(req.params.attachmentId)), session(req))); } catch (error) { next(error); }
}

function parseQuotationAttachmentId(raw: string): string { return parseQuotationIdParam(raw); }

export async function listRfqQuotationsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = parseQuotationIdParam(param(req.params.rfqId));
    sendSuccess(res, await vendorQuotationService.listRfqQuotations(id, parseQuotationFilters(req.query), req.auth!.userId));
  } catch (error) { next(error); }
}
export async function getInternalQuotationHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { sendSuccess(res, await vendorQuotationService.getInternalQuotation(parseQuotationIdParam(param(req.params.quotationId)), req.auth!.userId)); } catch (error) { next(error); }
}
export async function listInternalQuotationRevisionsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { sendSuccess(res, await vendorQuotationService.listInternalQuotationRevisions(parseQuotationIdParam(param(req.params.quotationId)), req.auth!.userId)); } catch (error) { next(error); }
}
export async function listInternalQuotationAttachmentsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { sendSuccess(res, await vendorQuotationService.listInternalQuotationAttachments(parseQuotationRevisionIdParam(param(req.params.revisionId)), req.auth!.userId)); } catch (error) { next(error); }
}
