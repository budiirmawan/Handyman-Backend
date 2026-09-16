import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { parseEmptyCommandBody } from '../handyman-request-governance/handyman-request-governance.validation';
import {
  decideHandymanQuotationApprovalInApp,
  getHandymanQuotationApproval,
  listHandymanQuotationApprovals,
  recordHandymanQuotationApprovalAssistedDecision,
} from './handyman-quotation-approval.service';
import {
  getHandymanQuotationApprovalLink,
  issueHandymanQuotationApprovalLink,
  listHandymanQuotationApprovalLinks,
  revokeHandymanQuotationApprovalLink,
} from './handyman-quotation-approval-link.service';
import { parseHandymanQuotationIdParam } from './handyman-quotation.validation';
import {
  parseDecideApprovalInAppHttpBody,
  parseHandymanQuotationApprovalIdParam,
  parseHandymanQuotationApprovalLinkIdParam,
  parseIssueApprovalLinkHttpBody,
  parseRecordApprovalAssistedHttpBody,
} from './handyman-quotation-approval.validation';

/**
 * CR-HM-BE-03 RUN 4 — thin HTTP handlers for the Run 3 customer approval
 * authority and the staff secure-link readiness surfaces.
 *
 * - IN_APP decision: authenticated session ONLY (no staff permission code);
 *   the Run 3 service verifies the actor is the linked authorized tenant PIC
 *   through governed identity/context links. Body allowlist is strictly
 *   `decision` + optional `notes`; approvedFor/recordedBy cannot be smuggled.
 * - ASSISTED decision: authenticated staff with the governed approval-record
 *   permission; approvedFor explicit, notes mandatory, recordedBy derived
 *   ONLY from req.auth.
 * - Secure links: authenticated governed staff issue/read/revoke metadata
 *   only. The raw token appears exactly once — in the successful issue
 *   response — and token_hash is never serialized by the Run 3 public read
 *   model. There is deliberately NO public resolve/decide/consume endpoint.
 *
 * All business authority stays in the Run 3 services; errors flow to the
 * shared Express error pipeline via `next(error)`.
 */

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

// ---------------------------------------------------------------------------
// Approval reads
// ---------------------------------------------------------------------------

export async function listHandymanQuotationApprovalsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const quotationId = parseHandymanQuotationIdParam(param(req.params.quotationId));
    sendSuccess(res, await listHandymanQuotationApprovals(quotationId, actor(req)));
  } catch (error) {
    next(error);
  }
}

export async function getHandymanQuotationApprovalHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const approvalId = parseHandymanQuotationApprovalIdParam(
      param(req.params.approvalId),
    );
    sendSuccess(res, await getHandymanQuotationApproval(approvalId, actor(req)));
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export async function decideHandymanQuotationApprovalInAppHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const quotationId = parseHandymanQuotationIdParam(param(req.params.quotationId));
    const body = parseDecideApprovalInAppHttpBody(req.body);
    sendSuccess(
      res,
      await decideHandymanQuotationApprovalInApp({ quotationId, ...body }, actor(req)),
    );
  } catch (error) {
    next(error);
  }
}

export async function recordHandymanQuotationApprovalAssistedDecisionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const quotationId = parseHandymanQuotationIdParam(param(req.params.quotationId));
    const body = parseRecordApprovalAssistedHttpBody(req.body);
    sendSuccess(
      res,
      await recordHandymanQuotationApprovalAssistedDecision(
        { quotationId, ...body },
        actor(req),
      ),
    );
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------------
// Secure-link staff readiness (issue / metadata reads / revoke ONLY)
// ---------------------------------------------------------------------------

export async function issueHandymanQuotationApprovalLinkHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const approvalId = parseHandymanQuotationApprovalIdParam(
      param(req.params.approvalId),
    );
    const body = parseIssueApprovalLinkHttpBody(req.body);
    // The result carries `rawToken` EXACTLY ONCE (issuance response only);
    // `link` is the Run 3 public read model, which never contains tokenHash.
    sendSuccess(
      res,
      await issueHandymanQuotationApprovalLink({ approvalId, ...body }, actor(req)),
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function listHandymanQuotationApprovalLinksHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const quotationId = parseHandymanQuotationIdParam(param(req.params.quotationId));
    sendSuccess(
      res,
      await listHandymanQuotationApprovalLinks(quotationId, actor(req)),
    );
  } catch (error) {
    next(error);
  }
}

export async function getHandymanQuotationApprovalLinkHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const linkId = parseHandymanQuotationApprovalLinkIdParam(param(req.params.linkId));
    sendSuccess(res, await getHandymanQuotationApprovalLink(linkId, actor(req)));
  } catch (error) {
    next(error);
  }
}

export async function revokeHandymanQuotationApprovalLinkHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const linkId = parseHandymanQuotationApprovalLinkIdParam(param(req.params.linkId));
    parseEmptyCommandBody(req.body);
    sendSuccess(res, await revokeHandymanQuotationApprovalLink(linkId, actor(req)));
  } catch (error) {
    next(error);
  }
}
