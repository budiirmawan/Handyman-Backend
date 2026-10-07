/**
 * BE-02B — License domain types.
 *
 * A License is the operational validity associated with a Client Subscription.
 * Deliberately lightweight — no cryptographic software license-key system.
 * A License is never valid on its own: the owning Subscription must itself be
 * commercially valid.
 */
export const LICENSE_STATUSES = ['ACTIVE', 'SUSPENDED', 'EXPIRED', 'REVOKED'] as const;

export type LicenseStatus = (typeof LICENSE_STATUSES)[number];

export function isLicenseStatus(value: unknown): value is LicenseStatus {
  return (
    typeof value === 'string' &&
    (LICENSE_STATUSES as readonly string[]).includes(value)
  );
}

export type LicenseRecord = {
  id: string;
  subscriptionId: string;
  status: LicenseStatus;
  validFrom: Date;
  validUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicLicense = {
  id: string;
  subscriptionId: string;
  status: LicenseStatus;
  validFrom: Date;
  validUntil: Date | null;
};

export type CreateLicenseInput = {
  validFrom: Date;
  validUntil?: Date;
  status?: LicenseStatus;
};

/** Fully-resolved license data ready for persistence. */
export type NewLicense = {
  subscriptionId: string;
  status: LicenseStatus;
  validFrom: Date;
  validUntil: Date | null;
};

export type UpdateLicenseStatusInput = {
  status: LicenseStatus;
};

export type LicenseEffectiveState = {
  license: PublicLicense;
  effective: boolean;
};
