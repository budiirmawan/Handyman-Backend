/**
 * CR-HM-MULTICLIENT-NOTIFICATION-01 PART 02 — per-subscription browser push
 * attempt evidence types (S-6).
 *
 * GOVERNANCE: docs/handyman/CR-HM-MULTICLIENT-NOTIFICATION-01_PART02_MULTI_CLIENT_PUSH_TRANSPORT.md
 * §2 (S-6).
 *
 * These mirror migration `0475` exactly and are shaped after the native
 * per-device evidence (`0336`): the row is EVIDENCE of what was sent to one
 * browser subscription and what the push service said about it. It is never
 * a queue entry, never a retry cursor, and never authoritative for delivery
 * state — the outbound ledger remains the single source of truth for that.
 */

/** Attempt outcome as stored (matches the 0475 CHECK). */
export const BROWSER_PUSH_DELIVERY_RECORD_STATUSES = ['SENT', 'FAILED'] as const;

export type BrowserPushDeliveryRecordStatus =
  (typeof BROWSER_PUSH_DELIVERY_RECORD_STATUSES)[number];

/** One immutable per-subscription attempt row. */
export type BrowserPushDeliveryRecord = {
  id: string;
  clientId: string;
  buildingId: string | null;
  recipientUserId: string;
  /** The browser subscription this attempt targeted. */
  browserSubscriptionId: string;
  deviceId: string;
  platform: string;
  templateKey: string | null;
  title: string;
  body: string | null;
  status: BrowserPushDeliveryRecordStatus;
  provider: string;
  /** Provider message id when the provider returned one. */
  providerReference: string | null;
  /** Sanitized failure text — never a credential, never an endpoint. */
  errorMessage: string | null;
  /** Normalized failure code (e.g. INVALID_TOKEN). */
  errorCode: string | null;
  sentAt: Date | null;
  /** The outbound ledger row this attempt belongs to. */
  deliveryId: string | null;
  createdAt: Date;
};

export type NewBrowserPushDelivery = {
  clientId: string;
  buildingId?: string | null;
  recipientUserId: string;
  browserSubscriptionId: string;
  deviceId: string;
  platform?: string;
  templateKey?: string | null;
  title: string;
  body?: string | null;
  status: BrowserPushDeliveryRecordStatus;
  provider: string;
  providerReference?: string | null;
  errorMessage?: string | null;
  errorCode?: string | null;
  sentAt?: Date | null;
  deliveryId?: string | null;
};
