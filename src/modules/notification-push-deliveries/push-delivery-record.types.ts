/**
 * CR-BE-PUSH-01 PART 03C — per-device push attempt evidence types.
 *
 * GOVERNANCE: docs/CR-BE-PUSH-01_START_GOVERNANCE.md §12.7 (frozen table
 * shape), §10.2 (one ledger row per recipient + N per-device attempt rows).
 *
 * These mirror migration `0336` exactly. The row is EVIDENCE: it records what
 * was sent to one device and what the provider said about it. It is never a
 * queue entry, never a retry cursor, and never authoritative for delivery
 * state — the outbound ledger remains the single source of truth for that.
 */

/** Attempt outcome as stored (matches the 0336 CHECK). */
export const PUSH_DELIVERY_RECORD_STATUSES = ['SENT', 'FAILED'] as const;

export type PushDeliveryRecordStatus = (typeof PUSH_DELIVERY_RECORD_STATUSES)[number];

/** One immutable per-device attempt row. */
export type PushDeliveryRecord = {
  id: string;
  clientId: string;
  buildingId: string | null;
  recipientUserId: string;
  /** The device this attempt targeted. The token VALUE is never stored here. */
  pushTokenId: string;
  deviceId: string;
  platform: string;
  templateKey: string | null;
  title: string;
  body: string | null;
  status: PushDeliveryRecordStatus;
  provider: string;
  /** Provider message id when the provider returned one. */
  providerReference: string | null;
  /** Sanitized failure text — never a credential, never a token value. */
  errorMessage: string | null;
  /** Normalized PART 02 failure code (e.g. INVALID_TOKEN). */
  errorCode: string | null;
  sentAt: Date | null;
  /** The outbound ledger row this attempt belongs to. */
  deliveryId: string | null;
  createdAt: Date;
};

export type NewPushDelivery = {
  clientId: string;
  buildingId?: string | null;
  recipientUserId: string;
  pushTokenId: string;
  deviceId: string;
  platform: string;
  templateKey?: string | null;
  title: string;
  body?: string | null;
  status: PushDeliveryRecordStatus;
  provider: string;
  providerReference?: string | null;
  errorMessage?: string | null;
  errorCode?: string | null;
  sentAt?: Date | null;
  deliveryId?: string | null;
};
