/**
 * BE-02C — Module Entitlement domain types.
 *
 * The commercial relationship Subscription → Entitlement → Module. It answers
 * "what modules/capabilities has this Client commercially enabled through its
 * valid Subscription?" It does NOT answer "what may a User do" (BE-01
 * Permission).
 */
export const ENTITLEMENT_STATUSES = ['ACTIVE', 'SUSPENDED', 'EXPIRED', 'REVOKED'] as const;

export type EntitlementStatus = (typeof ENTITLEMENT_STATUSES)[number];

export function isEntitlementStatus(value: unknown): value is EntitlementStatus {
  return (
    typeof value === 'string' &&
    (ENTITLEMENT_STATUSES as readonly string[]).includes(value)
  );
}

export type EntitlementRecord = {
  id: string;
  subscriptionId: string;
  moduleId: string;
  status: EntitlementStatus;
  startsAt: Date;
  endsAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicEntitlement = {
  id: string;
  subscriptionId: string;
  moduleId: string;
  status: EntitlementStatus;
  startsAt: Date;
  endsAt: Date | null;
};

export type CreateEntitlementInput = {
  moduleId: string;
  startsAt: Date;
  endsAt?: Date;
  status?: EntitlementStatus;
};

/** Fully-resolved entitlement data ready for persistence. */
export type NewEntitlement = {
  subscriptionId: string;
  moduleId: string;
  status: EntitlementStatus;
  startsAt: Date;
  endsAt: Date | null;
};

export type UpdateEntitlementStatusInput = {
  status: EntitlementStatus;
};

/** Safe summary of an effectively-entitled Module for a Subscription. */
export type EffectiveModuleSummary = {
  moduleId: string;
  code: string;
  name: string;
};
