/**
 * CR-HM-FIN-DOCUMENTS-01 — Finance payment-proof & receipt retrieval
 * authority (bounded READ surface).
 *
 * Exposes exactly the missing secure retrieval door over the
 * authoritative 0433 payment proof: metadata + verified content for
 * ONE authorized payment, behind `handyman.finance.read` and the exact
 * Building scope of the payment's execution scope. Reads are strictly
 * read-only: no payment status, no evidence status, no retention or
 * integrity state and no financial fact is ever mutated from this
 * surface.
 *
 * What is deliberately NOT here (kept as separate capabilities):
 *  - proof UPLOAD (Care workspace route, CR-HM-CARE-WORKSPACE);
 *  - Finance verification (confirm / reject, `handyman.finance.manage`);
 *  - an official payment receipt (capability gap — see the operations
 *    handoff; no receipt is ever manufactured from a proof screenshot).
 */

export {
  createHandymanPaymentProofRouter,
  PAYMENT_PROOF_ERROR_CODES,
} from './handyman-payment-proof.routes';

export {
  handymanPaymentProofService,
  getHandymanPaymentProofMetadata,
  loadAuthorizedPaymentProof,
  readHandymanPaymentProofContent,
  toPaymentProofMetadata,
  uploadExecutionScopePaymentProof,
} from './handyman-payment-proof.service';
export type {
  HandymanPaymentProofContent,
  HandymanPaymentProofMetadata,
  HandymanPaymentProofRecord,
  UploadExecutionScopePaymentProofInput,
} from './handyman-payment-proof.service';

export {
  handymanPaymentProofIntegrityConflictError,
  handymanPaymentProofNotFoundError,
} from './handyman-payment-proof.errors';
