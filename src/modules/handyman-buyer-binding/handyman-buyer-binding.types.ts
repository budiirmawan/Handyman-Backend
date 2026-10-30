export type BuyerBindingSnapshot = Readonly<{
  schema: 'HANDYMAN_BUYER_BINDING_V1';
  id: string; version: number; previousBindingId: string | null;
  clientId: string; requestId: string; buildingId: string; propertyId: string; spaceId: string | null;
  representedTenantCompanyId: string; tenantPicId: string | null; requestCreatedByUserId: string | null;
  channelAttributionId: string | null; unlistedIntakeCaseId: string | null;
  originChannel: string; originActorType: string | null; originCareActorId: string | null;
  costResponsibilityId: string | null;
  buyerTenantCompanyId: string; buyerKind: 'INDIVIDUAL' | 'LEGAL_ENTITY'; buyerLegalName: string;
  buyerMasterDigest: string; relationKind: 'REPRESENTED_TENANT' | 'UNIT_ROLE'; unitPartyRoleId: string | null;
  unitRoleKind: 'OWNER' | 'OCCUPANT' | 'PIC' | null; unitRoleFrom: string | null; unitRoleUntil: string | null;
  consentAuthority: 'NOT_ASSERTED';
  evidenceSource: string; evidenceReference: string; createdByUserId: string;
}>;
export type BuyerBindingPin = Readonly<{
  bindingId: string; bindingVersion: number; bindingDigest: string; decisionId: string; decisionDigest: string;
}>;
export type ProposeBuyerBinding = Readonly<{
  clientId: string; requestId: string; buyerTenantCompanyId: string; expectedVersion: number | null;
  evidenceSource: string; evidenceReference: string;
}>;
export type DecideBuyerBinding = Readonly<{
  clientId: string; requestId: string; bindingId: string; bindingVersion: number; bindingDigest: string;
  decision: 'VERIFY' | 'REJECT'; evidenceSource: string; evidenceReference: string;
}>;
export type BuyerBindingView = Readonly<{
  snapshot: BuyerBindingSnapshot; digestAlgorithm: 'SHA-256'; digest: string; createdAt: string;
}>;
export type BuyerBindingDecision = Readonly<{
  id: string; bindingId: string; requestId: string; clientId: string; buildingId: string;
  bindingVersion: number; bindingDigest: string; decision: 'VERIFY' | 'REJECT';
  evidenceSource: string; evidenceReference: string; actorUserId: string; occurredAt: string; decisionDigest: string;
}>;
export type VerifiedBuyerBinding = Readonly<{
  binding: BuyerBindingView; decision: BuyerBindingDecision;
  /** A binding is not a tax registration, PKP determination, consent or invoice authorization. */
  taxIdentityApproval: 'NOT_ASSERTED';
}>;
export type ResolveBuyerBinding = Readonly<{
  clientId: string; requestId: string; pin: BuyerBindingPin;
  /** Zoned instant at which the binding must already have been verified. */
  at: string;
}>;
