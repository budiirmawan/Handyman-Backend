/**
 * W03 PART 03D — the bounded, credential-scoped quotation read for a Tenant PIC.
 *
 * Exports are the three reads, the router, and the eligibility vocabulary. What is
 * deliberately NOT here: any write, any decision submission, any staff projection
 * reuse, and any second implementation of "authenticated" (03C's
 * `withPicWorkspaceSession` is the only credential seam this module uses).
 */
export { createPicPortalRouter } from './pic-portal.routes';
export {
  readPicPortalApprovalEligibility,
  readPicPortalOwnDecision,
  readPicPortalQuotation,
} from './pic-portal.service';
export {
  evaluatePicApprovalEligibility,
  PIC_PORTAL_ELIGIBILITY_CODES,
  PIC_PORTAL_ELIGIBILITY_MESSAGES,
  type PicPortalEligibilityCode,
  type PicPortalEligibilityInput,
  type PublicPicPortalApprovalEligibility,
  type PublicPicPortalBinding,
  type PublicPicPortalDecision,
  type PublicPicPortalLine,
  type PublicPicPortalQuotationRead,
  type PublicPicPortalTotals,
  type PublicPicPortalVersion,
} from './pic-portal.types';
