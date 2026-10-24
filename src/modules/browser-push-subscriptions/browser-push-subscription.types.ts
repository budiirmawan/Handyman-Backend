/**
 * CR-HM-MULTICLIENT-NOTIFICATION-01 PART 02 — browser push subscription
 * types (S-1).
 *
 * GOVERNANCE: docs/handyman/CR-HM-MULTICLIENT-NOTIFICATION-01_PART02_MULTI_CLIENT_PUSH_TRANSPORT.md
 * §2 (S-1) and §4 (the distinct Browser contract).
 *
 * A browser subscription is the browser's OWN registration of a push
 * service endpoint. It is NOT a native device token and does not share the
 * `mobile_push_tokens` vocabulary: it is a three-part object (endpoint,
 * subscriber public key, auth secret) with its own rotation and revocation
 * lifecycle, and it is delivered by a different transport.
 *
 * The client-neutral rule is unchanged: the CLIENT owns its registration,
 * the BACKEND owns the delivery.
 */

/**
 * The lifecycle of a browser subscription.
 *
 *   ACTIVE   — the browser may be targeted right now.
 *   INACTIVE — the user revoked it (kept as history).
 *   INVALID  — the push service proved the subscription is gone (404/410);
 *              kept as evidence with its provenance, never silently dropped.
 */
export const BROWSER_PUSH_SUBSCRIPTION_STATUSES = [
  'ACTIVE',
  'INACTIVE',
  'INVALID',
] as const;

export type BrowserPushSubscriptionStatus =
  (typeof BROWSER_PUSH_SUBSCRIPTION_STATUSES)[number];

/** The persisted row. */
export type BrowserPushSubscriptionRecord = {
  id: string;
  userId: string;
  /** The browser/device label the client uses to identify its installation. */
  deviceId: string;
  /** The push service endpoint (credential-grade — never logged, never public). */
  endpoint: string;
  /** The subscriber's P-256 public key, base64url (credential-grade). */
  p256dh: string;
  /** The subscriber's auth secret, base64url (credential-grade). */
  auth: string;
  userAgent: string | null;
  status: BrowserPushSubscriptionStatus;
  registeredAt: Date;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
  /** INTERNAL delivery-readiness evidence — never public. */
  provider: string | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  consecutiveFailureCount: number;
  invalidatedAt: Date | null;
  invalidationReason: string | null;
};

/**
 * The PUBLIC registration shape.
 *
 * Deliberately NARROWER than the native BE-25L shape: the endpoint, the
 * subscriber's public key and the auth secret are credential-grade and are
 * NEVER returned to a client, and neither is the provider evidence. The
 * client already owns those values — it sent them — so returning them would
 * only widen the blast radius of a leaked token.
 */
export type PublicBrowserPushSubscription = {
  id: string;
  userId: string;
  deviceId: string;
  status: BrowserPushSubscriptionStatus;
  registeredAt: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
};

/** The registration input (client-supplied). */
export type RegisterBrowserPushSubscriptionInput = {
  /** The browser installation label. */
  deviceId: string;
  /** The push service endpoint URL. */
  endpoint: string;
  /** The subscriber's P-256 public key, base64url. */
  p256dh: string;
  /** The subscriber's auth secret, base64url. */
  auth: string;
  /** Optional client description for diagnostics. */
  userAgent?: string | null;
};
