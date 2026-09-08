export const PERMIT_VALIDITY_STATUSES = [
  'PENDING',
  'VALID',
  'EXPIRED',
  'REVOKED',
] as const;

export type PermitValidityStatus = (typeof PERMIT_VALIDITY_STATUSES)[number];

export function isPermitValidityStatus(
  value: unknown,
): value is PermitValidityStatus {
  return typeof value === 'string' &&
    (PERMIT_VALIDITY_STATUSES as readonly string[]).includes(value);
}

export type PermitValidityRecord = {
  id: string;
  permitApplicationId: string;
  permitId: string;
  permitReference: string;
  clientId: string;
  buildingId: string;
  contractorContextType: string;
  contractorVendorId: string;
  applicationStatus: string;
  validFrom: Date;
  validUntil: Date;
  status: PermitValidityStatus;
  activatedAt: Date | null;
  expiredAt: Date | null;
  revokedAt: Date | null;
  revokedByUserId: string | null;
  notes: string | null;
  revocationNotes: string | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicPermitValidity = Omit<
  PermitValidityRecord,
  | 'validFrom'
  | 'validUntil'
  | 'activatedAt'
  | 'expiredAt'
  | 'revokedAt'
  | 'createdAt'
  | 'updatedAt'
> & {
  active: boolean;
  validFrom: string;
  validUntil: string;
  activatedAt: string | null;
  expiredAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SetPermitValidityInput = {
  permitApplicationId: string;
  buildingId: string;
  validFrom: Date;
  validUntil: Date;
  notes?: string | null;
};

export type NewPermitValidity = {
  permitApplicationId: string;
  validFrom: Date;
  validUntil: Date;
  status: PermitValidityStatus;
  activatedAt: Date | null;
  expiredAt: Date | null;
  notes: string | null;
  createdByUserId: string;
};

export type RevokePermitValidityInput = {
  revocationNotes?: string | null;
};

export type PermitValidityFilters = {
  permitId?: string;
  buildingId?: string;
  status?: PermitValidityStatus;
  validFrom?: Date;
  validUntil?: Date;
  validAt?: Date;
};

export type PermitValidityState = {
  permitId: string;
  permitReference: string;
  buildingId: string;
  currentValidity: PublicPermitValidity | null;
  history: PublicPermitValidity[];
};
