/**
 * BE-02B — Subscription domain types.
 *
 * A Subscription is the commercial state of an Asentra Client (the company/
 * customer boundary from BE-02A). It does NOT answer "which modules are
 * enabled" — module-level commercial access belongs to BE-02C (Entitlement).
 */
export const SUBSCRIPTION_STATUSES = [
  'PENDING',
  'ACTIVE',
  'SUSPENDED',
  'EXPIRED',
  'CANCELLED',
] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export function isSubscriptionStatus(value: unknown): value is SubscriptionStatus {
  return (
    typeof value === 'string' &&
    (SUBSCRIPTION_STATUSES as readonly string[]).includes(value)
  );
}

export type SubscriptionRecord = {
  id: string;
  clientId: string;
  code: string;
  planCode: string;
  status: SubscriptionStatus;
  startsAt: Date;
  endsAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicSubscription = {
  id: string;
  clientId: string;
  code: string;
  planCode: string;
  status: SubscriptionStatus;
  startsAt: Date;
  endsAt: Date | null;
};

export type CreateSubscriptionInput = {
  clientId: string;
  code: string;
  planCode: string;
  startsAt: Date;
  endsAt?: Date;
  status?: SubscriptionStatus;
};

/** Fully-resolved subscription data ready for persistence. */
export type NewSubscription = {
  clientId: string;
  code: string;
  planCode: string;
  status: SubscriptionStatus;
  startsAt: Date;
  endsAt: Date | null;
};

export type UpdateSubscriptionStatusInput = {
  status: SubscriptionStatus;
};

export type SubscriptionEffectiveState = {
  subscription: PublicSubscription;
  effective: boolean;
};
