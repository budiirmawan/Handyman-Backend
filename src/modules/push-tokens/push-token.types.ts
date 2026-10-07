/**
 * BE-25L — Push Token Registration types.
 *
 * Backend registration of mobile push notification tokens. A token always
 * belongs to an authenticated user/device context; registration supports
 * refresh/rotation (same device re-registers → the ACTIVE row's token is
 * replaced) and deactivation/unregister.
 *
 * CR-BE-PUSH-01 PART 01 extends the record with INTERNAL delivery-readiness
 * evidence (migration 0334) and the `INVALID` lifecycle state. No delivery
 * exists: nothing in this module sends, and none of the internal evidence
 * fields is exposed publicly (see `PublicPushToken`).
 */

export const PUSH_PLATFORMS = ['ANDROID', 'IOS'] as const;
export type PushPlatform = (typeof PUSH_PLATFORMS)[number];

/**
 * Device lifecycle (CR-BE-PUSH-01 §7):
 *   ACTIVE   — usable registration; the only state a future delivery may target.
 *   INACTIVE — the user or the app deliberately unregistered the device.
 *   INVALID  — the provider declared the registration unusable (§8). The row
 *              is RETAINED as evidence and may be superseded by a later valid
 *              registration; it is never deleted.
 */
export const PUSH_TOKEN_STATUSES = ['ACTIVE', 'INACTIVE', 'INVALID'] as const;
export type PushTokenStatus = (typeof PUSH_TOKEN_STATUSES)[number];

/**
 * The persisted row. `provider`, `lastSuccessAt`, `lastFailureAt`,
 * `consecutiveFailureCount`, `invalidatedAt` and `invalidationReason` are
 * INTERNAL delivery-readiness evidence: they never leave the backend through
 * the registration API (boundary guard B-01c).
 */
export type PushTokenRecord = {
  id: string;
  userId: string;
  deviceId: string;
  pushToken: string;
  platform: PushPlatform;
  appVersion: string | null;
  deviceModel: string | null;
  deviceOsVersion: string | null;
  status: PushTokenStatus;
  registeredAt: Date;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
  provider: string | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  consecutiveFailureCount: number;
  invalidatedAt: Date | null;
  invalidationReason: string | null;
};

/**
 * The public registration shape — DELIBERATELY UNCHANGED by
 * CR-BE-PUSH-01 PART 01. No provider identity, no success/failure
 * timestamps, no failure counters, no invalidation reason: routing and
 * delivery-readiness metadata stay internal (§9, boundary guard B-01c).
 */
export type PublicPushToken = {
  id: string;
  userId: string;
  deviceId: string;
  pushToken: string;
  platform: PushPlatform;
  appVersion: string | null;
  deviceModel: string | null;
  deviceOsVersion: string | null;
  status: PushTokenStatus;
  registeredAt: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
};

export type RegisterPushTokenInput = {
  deviceId: string;
  pushToken: string;
  platform: PushPlatform;
  appVersion?: string | null;
  deviceModel?: string | null;
  deviceOsVersion?: string | null;
};
