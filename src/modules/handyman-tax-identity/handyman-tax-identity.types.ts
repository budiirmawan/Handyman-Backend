/** The owner is an existing 0490 provider or one exact 0493 BM legal party. */
export type HandymanTaxIdentityOwner =
  | { kind: 'HANDYMAN_ISSUER'; clientId: string }
  | { kind: 'BM_BENEFICIARY'; clientId: string; counterpartyId: string };

export type TaxpayerKind = 'UNKNOWN' | 'LEGAL_ENTITY' | 'INDIVIDUAL';
export type IndividualResidency = 'UNKNOWN' | 'RESIDENT' | 'NON_RESIDENT';
export type TaxIdentifierKind = 'NPWP_15' | 'NPWP_16' | 'NIK_NPWP_16';
export type PkpStatus = 'UNKNOWN' | 'PKP' | 'NON_PKP';

export type CaptureHandymanTaxIdentityInput = {
  owner: HandymanTaxIdentityOwner;
  /** Required only for an issuer; anchors the exact 0490 content version. */
  issuerProfileId?: string | null;
  legalName: string;
  taxpayerKind: TaxpayerKind;
  /** Required for individuals; NULL for legal entities and unknown type. */
  individualResidency: IndividualResidency | null;
  identifier: { kind: TaxIdentifierKind; value: string } | null;
  pkpStatus: PkpStatus;
  effectiveFrom: string;
  effectiveTo?: string | null;
  evidenceSource: string;
  evidenceReference: string;
  expectedVersion: number | null;
  idempotencyKey: string;
};

/** Immutable asserted content, not a verified or approved tax decision. */
export type HandymanTaxIdentitySnapshot = Readonly<{
  schema: 'HANDYMAN_TAX_IDENTITY_V1';
  id: string;
  clientId: string;
  ownerKind: HandymanTaxIdentityOwner['kind'];
  ownerId: string;
  issuerProfileId: string | null;
  counterpartyId: string | null;
  verificationId: string | null;
  version: number;
  legalName: string;
  taxpayerKind: TaxpayerKind;
  individualResidency: IndividualResidency | null;
  identifierKind: TaxIdentifierKind | null;
  identifierValue: string | null;
  pkpStatus: PkpStatus;
  approvalStatus: 'UNAPPROVED';
  effectiveFrom: string;
  declaredEffectiveTo: string | null;
  evidenceSource: string;
  evidenceReference: string;
  createdByUserId: string;
  createdAt: string;
}>;

export type HandymanTaxIdentityView = Readonly<{
  snapshot: HandymanTaxIdentitySnapshot;
  digestAlgorithm: 'SHA-256';
  digest: string;
  /** Current projection; a later prospective closure may shorten this window. */
  effectiveWindow: Readonly<{
    from: string;
    /** End after also limiting the window to the referenced issuer version. */
    to: string | null;
    identityWindowTo: string | null;
    issuerProfileSupersededAt: string | null;
    closure: Readonly<{
      id: string;
      kind: 'CLOSED' | 'CANCELLED_BEFORE_START';
      effectiveTo: string;
      reason: string;
      createdByUserId: string;
      createdAt: string;
    }> | null;
  }>;
  taxUse: Readonly<{
    allowed: false;
    reason: 'TAXPAYER_KIND_UNKNOWN' | 'INDIVIDUAL_RESIDENCY_UNKNOWN' | 'PKP_STATUS_UNKNOWN' | 'APPROVAL_REQUIRED';
  }>;
}>;
