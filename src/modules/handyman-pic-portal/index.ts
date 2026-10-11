/**
 * W03 PART 03D + 03E — the bounded, credential-scoped quotation thread for a
 * Tenant PIC: three reads and ONE write.
 *
 * What is deliberately NOT here: any staff projection reuse, any second
 * implementation of "authenticated" (03C's `withPicWorkspaceSession` is the only
 * credential seam this module uses), and any second ledger. 03E's
 * `submitPicQuotationDecision` reaches the decisions table exclusively through
 * `handyman-quotations`' in-transaction decision engine, so a PIC approval and the
 * pre-amendment staff approval are the same code path with a different actor —
 * which is what makes "no approval bypass" (03E item 13) a structural fact rather
 * than a reviewed behaviour.
 */
export { createPicPortalRouter } from './pic-portal.routes';
export {
  readPicPortalApprovalEligibility,
  readPicPortalOwnDecision,
  readPicPortalQuotation,
} from './pic-portal.service';
export {
  parsePicDecisionBody,
  submitPicQuotationDecision,
} from './pic-portal-decide.service';
export {
  evaluatePicApprovalEligibility,
  PIC_PORTAL_ELIGIBILITY_CODES,
  PIC_PORTAL_ELIGIBILITY_MESSAGES,
  type PicPortalEligibilityCode,
  type PicPortalEligibilityInput,
  type PublicPicPortalApprovalEligibility,
  type PublicPicPortalBinding,
  type PublicPicPortalDecision,
  type PublicPicPortalDecisionWrite,
  type PublicPicPortalExecutionScope,
  type PublicPicPortalLine,
  type PublicPicPortalQuotationRead,
  type PublicPicPortalTotals,
  type PublicPicPortalVersion,
} from './pic-portal.types';
