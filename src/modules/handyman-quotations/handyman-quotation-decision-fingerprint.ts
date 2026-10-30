import { createHash } from 'node:crypto';
import type { QuotationDecisionOffer } from './handyman-quotation-document.service';

/** The null-offer branch is the unmodified historical fingerprint. */
export function quotationDecisionFingerprint(versionId: string, decision: string, offer: QuotationDecisionOffer | null): string {
  const identity = offer
    ? [versionId, decision, 'ISSUED_PRICE_BASIS_OFFER_V1', offer.id, offer.sourceSha256, offer.pdfSha256]
    : [versionId, decision];
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}
export function careQuotationDecisionFingerprint(personal: string, careActorId: string, consentId: string): string {
  return createHash('sha256').update(JSON.stringify([personal, careActorId, consentId])).digest('hex');
}
