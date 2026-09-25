/**
 * CR-BE-SAAS-01 PART 11 — Support Access Core types (frozen §19).
 *
 * Storage status is binary (`ACTIVE` / `ENDED`) per §19.1. Effective
 * status is DERIVED at read time: an `ACTIVE` row whose `expires_at`
 * has passed is "expired" (not "ended") — the row stays ACTIVE for
 * audit, but downstream checks treat it as ineffective (§19.2 rule 2).
 *
 * A session never impersonates. The audit record always carries the
 * Gatepro actor's real `support_actor_user_id` (§19.2 rule 3).
 */

/** Frozen storage status (§19.1) — two-value vocabulary. */
export type SupportSessionStorageStatus = 'ACTIVE' | 'ENDED';

/**
 * Effective status returned by readers and used by enforcement:
 *   - ACTIVE    → row is `ACTIVE` and `expires_at` is in the future
 *   - EXPIRED   → row is `ACTIVE` but `expires_at` has passed (derived)
 *   - REVOKED   → row is `ENDED` via explicit DELETE (§19.2 rule 2)
 *
 * NOTE: `EXPIRED` is a derived view, never persisted and never audited
 * (frozen §18.2 — no `SAAS_SUPPORT_ACCESS_EXPIRED` event in the
 * catalogue). Only grant/start and end/revoke are audited events.
 */
export type SupportSessionEffectiveStatus = 'ACTIVE' | 'EXPIRED' | 'REVOKED';

/** Read shape returned by the repository. */
export interface PlatformSupportSessionRecord {
  id: string;
  supportActorUserId: string;
  customerId: string;
  buildingId: string | null;
  reason: string;
  startedAt: Date;
  expiresAt: Date;
  endedAt: Date | null;
  endedByUserId: string | null;
  status: SupportSessionStorageStatus;
}

/** Input shape to open a session. */
export interface OpenSupportSessionInput {
  actorUserId: string;
  /** Verified by caller (route handler). */
  authority: string;
  customerId: string;
  buildingId?: string | null;
  reason: string;
  durationMinutes: number;
  /** Caller-provided correlation (request id). */
  requestId?: string;
}

/** Result of a liveness check (PART 11 enforcement seam). */
export type SupportSessionEffectiveness =
  | { kind: 'EFFECTIVE'; session: PlatformSupportSessionRecord }
  | { kind: 'EXPIRED'; session: PlatformSupportSessionRecord }
  | { kind: 'REVOKED'; session: PlatformSupportSessionRecord }
  | { kind: 'NOT_FOUND' };

/** Frozen event names (§18.2 / §19.2 rule 4 / rule 2). */
export const SUPPORT_ACCESS_STARTED = 'SAAS_SUPPORT_ACCESS_STARTED';
export const SUPPORT_ACCESS_ENDED = 'SAAS_SUPPORT_ACCESS_ENDED';

/** Audit entity type for control-plane operations. */
export const SUPPORT_SESSION_ENTITY_TYPE = 'SAAS_SUPPORT_SESSION';
