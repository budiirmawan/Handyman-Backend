/**
 * BE-14A — Client-scoped Tenant Company master data.
 *
 * CR-HM-MASTER-IND-01 — the master is a PHYSICAL PARTY master, not a
 * company-only master: `partyKind` discriminates an INDIVIDUAL from a
 * LEGAL_ENTITY. Both live in the same governed table (migration 0456), so an
 * individual Owner/Tenant/Occupant never requires inventing a fictitious
 * company. `tenantCode` stays the stable machine-readable identity and
 * `tenantName` is the display name (for an INDIVIDUAL: the person's name).
 */
export const TENANT_COMPANY_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type TenantCompanyStatus = (typeof TENANT_COMPANY_STATUSES)[number];

export function isTenantCompanyStatus(value: unknown): value is TenantCompanyStatus {
  return typeof value === 'string' &&
    (TENANT_COMPANY_STATUSES as readonly string[]).includes(value);
}

export const TENANT_PARTY_KINDS = ['INDIVIDUAL', 'LEGAL_ENTITY'] as const;
export type TenantPartyKind = (typeof TENANT_PARTY_KINDS)[number];

export function isTenantPartyKind(value: unknown): value is TenantPartyKind {
  return typeof value === 'string' &&
    (TENANT_PARTY_KINDS as readonly string[]).includes(value);
}

/**
 * Indonesian identity-document vocabulary (bounded, no invented types):
 *   INDIVIDUAL   → KTP (16 digits) / PASSPORT / KITAS
 *   LEGAL_ENTITY → NPWP (15 or 16 digits) / NIB (13 digits)
 */
export const TENANT_IDENTITY_DOCUMENT_TYPES = [
  'KTP',
  'PASSPORT',
  'KITAS',
  'NPWP',
  'NIB',
] as const;
export type TenantIdentityDocumentType =
  (typeof TENANT_IDENTITY_DOCUMENT_TYPES)[number];

export function isTenantIdentityDocumentType(
  value: unknown,
): value is TenantIdentityDocumentType {
  return typeof value === 'string' &&
    (TENANT_IDENTITY_DOCUMENT_TYPES as readonly string[]).includes(value);
}

export const INDIVIDUAL_IDENTITY_DOCUMENT_TYPES: readonly TenantIdentityDocumentType[] = [
  'KTP',
  'PASSPORT',
  'KITAS',
];
export const LEGAL_ENTITY_IDENTITY_DOCUMENT_TYPES: readonly TenantIdentityDocumentType[] = [
  'NPWP',
  'NIB',
];

/**
 * CR-HM-MASTER-TENANT-BATCH-01 — explicit verification state.
 *
 * TEMPORARY registrations (batch import, quick hand-entry) land as
 * `PENDING_VERIFICATION` and are operable master data, but unverified data
 * must never receive approval authority or billing authority (the request
 * party designation services refuse `TENANT_VERIFICATION_REQUIRED`).
 * Existing rows default to `VERIFIED` — no existing caller changes behavior.
 * `REJECTED` is terminal for authority purposes and is set only through the
 * auditable verification action.
 */
export const TENANT_VERIFICATION_STATUSES = [
  'PENDING_VERIFICATION',
  'VERIFIED',
  'REJECTED',
] as const;
export type TenantVerificationStatus =
  (typeof TENANT_VERIFICATION_STATUSES)[number];

export function isTenantVerificationStatus(
  value: unknown,
): value is TenantVerificationStatus {
  return (
    typeof value === 'string' &&
    (TENANT_VERIFICATION_STATUSES as readonly string[]).includes(value)
  );
}

/** Verification values accepted at create time (never REJECTED). */
export const CREATABLE_TENANT_VERIFICATION_STATUSES = [
  'PENDING_VERIFICATION',
  'VERIFIED',
] as const;

/** Per-type format rules. Validation lives here so API and services agree. */
export const IDENTITY_DOCUMENT_PATTERNS: Record<TenantIdentityDocumentType, RegExp> = {
  KTP: /^\d{16}$/,
  PASSPORT: /^[A-Z0-9]{6,20}$/,
  KITAS: /^[A-Z0-9-]{6,20}$/,
  NPWP: /^\d{15,16}$/,
  NIB: /^\d{13}$/,
};

export type TenantCompanyRecord = {
  id: string;
  clientId: string;
  tenantCode: string;
  tenantName: string;
  partyKind: TenantPartyKind;
  legalName: string | null;
  identityDocumentType: TenantIdentityDocumentType | null;
  identityDocumentNumber: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  status: TenantCompanyStatus;
  verificationStatus: TenantVerificationStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicTenantCompany = Omit<TenantCompanyRecord, 'createdAt' | 'updatedAt'> & {
  createdAt: string;
  updatedAt: string;
};

export type CreateTenantCompanyInput = {
  clientId: string;
  tenantCode: string;
  tenantName: string;
  /** Defaults to LEGAL_ENTITY (existing master data keeps its meaning). */
  partyKind?: TenantPartyKind;
  legalName?: string;
  identityDocumentType?: TenantIdentityDocumentType;
  identityDocumentNumber?: string;
  email?: string;
  phone?: string;
  address?: string;
  status?: TenantCompanyStatus;
  /**
   * Optional explicit verification state (default VERIFIED keeps existing
   * callers byte-identical). REJECTED cannot be set at create.
   */
  verificationStatus?: TenantVerificationStatus;
};

/**
 * Partial update input (PATCH). `clientId`, `tenantCode` and `partyKind` are
 * immutable — a party does not become a different kind of physical customer.
 * Identity document values remain correctable. `verificationStatus` is NOT
 * patchable here — only the auditable verification action changes it.
 */
export type UpdateTenantCompanyInput = {
  tenantName?: string;
  legalName?: string | null;
  identityDocumentType?: TenantIdentityDocumentType | null;
  identityDocumentNumber?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  status?: TenantCompanyStatus;
};

export type TenantCompanyListFilters = {
  search?: string;
  status?: TenantCompanyStatus;
  partyKind?: TenantPartyKind;
};
