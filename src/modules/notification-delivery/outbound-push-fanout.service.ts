import { getPool } from '../../database';
import { listActivePushTokensForUser } from '../push-tokens';
import type { PushPlatform, PushTokenRecord } from '../push-tokens';
import type { OutboundDeliveryRecord } from '../notification-outbound-deliveries';
import {
  buildPushPointerPayload,
  type BuildPushPointerPayloadOptions,
  type PushPointerPayload,
} from './outbound-push-payload';

/**
 * CR-BE-PUSH-01 PART 03B — active-device fan-out resolution.
 *
 * GOVERNANCE: docs/CR-BE-PUSH-01_START_GOVERNANCE.md §10.1, §10.2.
 *
 * Turns ONE logical PUSH delivery (one ledger row, one recipient) into the
 * per-device send plan: N targets, one per ACTIVE registration owned by that
 * recipient, each carrying the SAME §9 pointer payload.
 *
 * THIS MODULE RESOLVES; IT DOES NOT SEND. No adapter is constructed, no
 * provider is contacted, no ledger row is written, and no `mobile_push_tokens`
 * row is mutated. Wiring the plan into `processOutboundDelivery` — the actual
 * send, the per-device attempt rows, and the INVALID_TOKEN evidence path — is
 * the remainder of PART 03/04. Keeping resolution pure makes the isolation
 * rules below testable without a provider.
 *
 * ISOLATION (§10.1)
 * -----------------
 * The recipient is taken from the LEDGER ROW, never from a device, a token,
 * or anything a payload carries. `listActivePushTokensForUser` is filtered by
 * `user_id` in SQL, so a device belonging to another user is unreachable by
 * construction; `assertSingleRecipientOwnership` re-checks that invariant in
 * code so a future change to the query cannot silently cross users. Tokens
 * are user-scoped, so tenant isolation is INHERITED from the already-resolved
 * recipient — it is never re-derived here, and this module introduces no
 * permission code and no RBAC check.
 */

/**
 * Why a recipient produced no targets. Distinguishing these matters: a user
 * who never installed the app is an ordinary, expected outcome, while a user
 * whose every device was invalidated is a different operational signal.
 */
export const PUSH_FANOUT_EMPTY_REASONS = [
  /** The user has no push registrations at all (never installed / never registered). */
  'NO_REGISTRATIONS',
  /** Registrations exist, but every one is INACTIVE or INVALID. */
  'NO_ACTIVE_REGISTRATIONS',
] as const;

export type PushFanoutEmptyReason = (typeof PUSH_FANOUT_EMPTY_REASONS)[number];

/** One device to send to. The token is carried for the SEND step only. */
export type PushFanoutTarget = {
  /** `mobile_push_tokens.id` — the attempt row's device reference. */
  pushTokenId: string;
  /** The device's opaque provider token. Never logged, never persisted to the ledger. */
  token: string;
  platform: PushPlatform;
  deviceId: string;
};

/** The resolved send plan for one ledger row. */
export type PushFanoutPlan = {
  deliveryId: string;
  recipientUserId: string;
  /** The identical §9 pointer payload every target receives. */
  payload: PushPointerPayload;
  /** ACTIVE devices, in a deterministic order. Possibly empty. */
  targets: PushFanoutTarget[];
  /**
   * Set only when `targets` is empty — the truthful reason. Governance §10.2
   * makes zero ACTIVE devices a PERMANENT, non-retryable outcome: it must
   * never be reported as a send and must never consume the retry budget.
   */
  emptyReason: PushFanoutEmptyReason | null;
};

/** The `user:<userId>` recipient reference PART 03A writes to the ledger. */
const RECIPIENT_ADDRESS_PATTERN = /^user:([0-9a-fA-F-]{36})$/;

/**
 * Extracts the user id from a PUSH `recipient_address`.
 *
 * The ledger's recipient reference is the authority for WHO is being
 * notified. It is parsed strictly: an address that is not exactly
 * `user:<uuid>` returns null rather than being coerced, so a malformed or
 * hand-edited row can never be silently redirected at another user.
 */
export function parsePushRecipientAddress(recipientAddress: string): string | null {
  const match = RECIPIENT_ADDRESS_PATTERN.exec(recipientAddress.trim());
  return match ? match[1].toLowerCase() : null;
}

/**
 * Cross-user safety net (§10.1). `listActivePushTokensForUser` already filters
 * by `user_id`, so this can only fire on a programming error — which is
 * exactly when it matters. Throwing beats sending a notification to the wrong
 * person's handset.
 */
function assertSingleRecipientOwnership(
  tokens: PushTokenRecord[],
  recipientUserId: string,
): void {
  for (const token of tokens) {
    if (token.userId !== recipientUserId) {
      throw new Error(
        'Push fan-out aborted: device registration does not belong to the delivery recipient.',
      );
    }
  }
}

/**
 * Resolves the ACTIVE devices for a PUSH ledger row and pairs them with the
 * §9 pointer payload.
 *
 * Returns `null` when the row is not a PUSH delivery or its recipient
 * reference is unparseable — the caller decides what to do; this module never
 * guesses a recipient.
 *
 * DEVICE SELECTION RULE (§7, §10.2): ACTIVE only. INACTIVE (the user
 * deliberately unregistered) and INVALID (the provider declared the token
 * dead) are BOTH excluded. INVALID rows are retained as evidence and are
 * never resurrected by a delivery.
 */
export async function resolvePushFanoutPlan(
  record: OutboundDeliveryRecord,
  options: BuildPushPointerPayloadOptions = {},
): Promise<PushFanoutPlan | null> {
  if (record.channel !== 'PUSH') {
    return null;
  }

  // WHO is notified comes from the ledger row, never from a device (§10.1).
  const recipientUserId = parsePushRecipientAddress(record.recipientAddress);
  if (!recipientUserId) {
    return null;
  }

  // The recipient_user_id column and the recipient_address must agree. They
  // are written together by the intent seam; a divergence means the row was
  // tampered with or mis-migrated, and sending on it would be a guess.
  if (record.recipientUserId.toLowerCase() !== recipientUserId) {
    return null;
  }

  const activeTokens = await listActivePushTokensForUser(recipientUserId);
  assertSingleRecipientOwnership(activeTokens, recipientUserId);

  const payload = buildPushPointerPayload(record, options);

  const targets: PushFanoutTarget[] = activeTokens.map((token) => ({
    pushTokenId: token.id,
    token: token.pushToken,
    platform: token.platform,
    deviceId: token.deviceId,
  }));

  return {
    deliveryId: record.id,
    recipientUserId,
    payload,
    targets,
    emptyReason: targets.length > 0 ? null : await resolveEmptyReason(recipientUserId),
  };
}

/**
 * Distinguishes "never registered" from "all registrations are dead". Only
 * consulted when the ACTIVE set is empty, so the common path costs no extra
 * query.
 */
async function resolveEmptyReason(recipientUserId: string): Promise<PushFanoutEmptyReason> {
  const result = await getPool().query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM mobile_push_tokens WHERE user_id = $1`,
    [recipientUserId],
  );
  const total = Number(result.rows[0]?.count ?? '0');
  return total > 0 ? 'NO_ACTIVE_REGISTRATIONS' : 'NO_REGISTRATIONS';
}
