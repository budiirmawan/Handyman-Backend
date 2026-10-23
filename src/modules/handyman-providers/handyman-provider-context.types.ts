/**
 * CR-HM-04 PART 01 — Handyman Provider Context types (FROZEN F1/F8).
 *
 * The context carries ONLY Handyman eligibility/state: `clientId` is a
 * verbatim snapshot of the authoritative `vendors` row's client at time
 * of creation (the service derives it from the vendor authority, never
 * from caller input). No vendor name/contact/PIC, compliance, capability,
 * or commercial data exists here.
 *
 * CR-HM-WORKER-COMPETENCY-01 PART 03B2D — two KINDS of provider context:
 *
 *   VENDOR  the legacy/external-subcontractor pool: exactly one per `vendors`
 *           row, `vendorId` is the authoritative identity. Behaviour is
 *           byte-for-byte the pre-03B2D behaviour.
 *   DIRECT  Handyman's OWN workforce pool for one Client: no vendor exists and
 *           none is fabricated. Permanent (INTERNAL), CONTRACT and FREELANCE
 *           workers are admitted here by Operations directly.
 *
 * `providerType` is additive; every pre-existing row is VENDOR.
 */

export const HANDYMAN_PROVIDER_CONTEXT_TYPES = ['VENDOR', 'DIRECT'] as const;
export type HandymanProviderContextType =
  (typeof HANDYMAN_PROVIDER_CONTEXT_TYPES)[number];

export function isHandymanProviderContextType(
  value: unknown,
): value is HandymanProviderContextType {
  return (
    typeof value === 'string' &&
    (HANDYMAN_PROVIDER_CONTEXT_TYPES as readonly string[]).includes(value)
  );
}

export const HANDYMAN_PROVIDER_CONTEXT_STATUSES = [
  'ACTIVE',
  'INACTIVE',
] as const;
export type HandymanProviderContextStatus =
  (typeof HANDYMAN_PROVIDER_CONTEXT_STATUSES)[number];

export function isHandymanProviderContextStatus(
  value: unknown,
): value is HandymanProviderContextStatus {
  return (
    typeof value === 'string' &&
    (HANDYMAN_PROVIDER_CONTEXT_STATUSES as readonly string[]).includes(value)
  );
}

export type HandymanProviderContextRecord = {
  id: string;
  /** Tenant isolation root, derived from the vendor authority (VENDOR) or
   * supplied explicitly and access-checked (DIRECT). */
  clientId: string;
  /** VENDOR | DIRECT (PART 03B2D). */
  providerType: HandymanProviderContextType;
  /** Authoritative identity for a VENDOR context; NULL for DIRECT. */
  vendorId: string | null;
  status: HandymanProviderContextStatus;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Caller input — clientId/actor are NEVER input (derived from the vendor). */
export type CreateHandymanProviderContextInput = {
  vendorId: string;
};

/**
 * PART 03B2D — caller input for the direct pool. The Client IS caller-supplied
 * because there is no vendor to derive it from; the service verifies the actor
 * can actually reach that Client (a broad permission never widens access).
 */
export type CreateDirectHandymanProviderContextInput = {
  clientId: string;
};

export type NewHandymanProviderContextRecord = Omit<
  HandymanProviderContextRecord,
  'id' | 'createdAt' | 'updatedAt' | 'status'
>;

/** Safe public representation (timestamps ISO). */
export type PublicHandymanProviderContext = Omit<
  HandymanProviderContextRecord,
  'createdAt' | 'updatedAt'
> & {
  createdAt: string;
  updatedAt: string;
};
