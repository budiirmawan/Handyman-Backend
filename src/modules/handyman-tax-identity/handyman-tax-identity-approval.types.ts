import type { HandymanTaxIdentityOwner, HandymanTaxIdentityView } from './handyman-tax-identity.types';

export type TaxIdentityApprovalCommand = {
  owner: HandymanTaxIdentityOwner;
  profileId: string;
  profileVersion: number;
  /** SHA-256 digest of the exact immutable HANDYMAN_TAX_IDENTITY_V1 snapshot. */
  profileDigest: string;
  evidenceSource: string;
  evidenceReference: string;
};
export type TaxIdentityDecisionCommand = TaxIdentityApprovalCommand & {
  submissionId: string;
  decision: 'APPROVE' | 'REJECT';
};
export type TaxIdentityApprovalEvent = Readonly<{
  id: string;
  profileId: string;
  clientId: string;
  ownerKind: HandymanTaxIdentityOwner['kind'];
  ownerId: string;
  profileVersion: number;
  profileDigest: string;
  eventType: 'SUBMIT' | 'APPROVE' | 'REJECT';
  submissionId: string | null;
  actorUserId: string;
  evidenceSource: string;
  evidenceReference: string;
  occurredAt: string;
  reviewFrom: string;
  reviewTo: string | null;
  approvedFrom: string | null;
  approvedTo: string | null;
}>;

/** The 0495 capture remains unchanged; authority comes from separate events. */
export type ApprovedHandymanTaxIdentity = Readonly<Omit<HandymanTaxIdentityView, 'taxUse'> & {
  approval: Readonly<{ submission: TaxIdentityApprovalEvent; decision: TaxIdentityApprovalEvent }>;
  taxUse: Readonly<{ allowed: true; reason: 'FINANCE_APPROVED' }>;
}>;
