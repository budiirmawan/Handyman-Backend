import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { isAllowedBrowserPushEndpoint } from '../push-delivery';
import type {
  BrowserPushSubscriptionRecord,
  PublicBrowserPushSubscription,
  RegisterBrowserPushSubscriptionInput,
} from './browser-push-subscription.types';

/**
 * CR-HM-MULTICLIENT-NOTIFICATION-01 PART 02 — browser push subscription
 * authority (S-1).
 *
 * GOVERNANCE: docs/handyman/CR-HM-MULTICLIENT-NOTIFICATION-01_PART02_MULTI_CLIENT_PUSH_TRANSPORT.md
 * §2 (S-1).
 *
 * This module is the browser's REGISTRATION authority. It is deliberately the
 * exact mirror of the native token authority (`push-tokens`), with one
 * decisive difference: the registered object is a subscription (endpoint +
 * key pair), not a provider token.
 *
 * RULES
 * -----
 *   - a subscription always belongs to the AUTHENTICATED user (the user id
 *     is never client-supplied) and possession of a subscription is NEVER
 *     authentication or authorization for anything,
 *   - one ACTIVE registration per (user, deviceId): re-registering the same
 *     browser ROTATES the endpoint and the key pair (UPDATE, not a duplicate
 *     row) — this is the browser's key-pair rotation,
 *   - one ACTIVE registration per endpoint GLOBALLY: an endpoint that
 *     reappears under another account retires the previous ACTIVE row, which
 *     becomes INACTIVE history. One subscription can never route to two
 *     active users,
 *   - revocation sets the row INACTIVE (kept as history); a push service
 *     that proves the subscription is gone sets it INVALID with provenance,
 *   - rows are NEVER deleted,
 *   - the endpoint and the key material are NEVER logged and never returned
 *     by the public shape.
 *
 * REGISTRATION IS NOT DELIVERY. This module never contacts a push service,
 * holds no credential and runs no transport. Delivery lives in the governed
 * provider module (`push-delivery`), and the durable ledger lives in the
 * outbound delivery family.
 */

/** Maximum length of the endpoint URL (defensive bound). */
const MAX_ENDPOINT_LENGTH = 2048;
/** Maximum length of the device label. */
const MAX_DEVICE_ID_LENGTH = 128;
/** Maximum length of the client description. */
const MAX_USER_AGENT_LENGTH = 256;
/** Maximum length of the stored invalidation reason. */
const MAX_INVALIDATION_REASON_LENGTH = 200;
/** Maximum length of the provider name. */
const MAX_PROVIDER_LENGTH = 32;

const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+={0,2}$/;

/**
 * The push service origins a browser subscription may point at are owned by
 * the TRANSPORT module (`../push-delivery`): the set of legitimate push
 * service origins is transport knowledge, and the module that contacts them
 * owns the list. The endpoint is a CAPABILITY URL, so accepting an arbitrary
 * URL would turn the backend into a relay that POSTs to any host the caller
 * names (server-side request forgery).
 */

/** Decodes a base64url value, returning null when it is not valid base64url. */
function decodeBase64Url(value: string): Buffer | null {
  if (!BASE64URL_PATTERN.test(value)) {
    return null;
  }
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    '=',
  );
  try {
    return Buffer.from(padded, 'base64');
  } catch {
    return null;
  }
}

/**
 * Validates the subscriber's public key: an uncompressed P-256 point is 65
 * bytes (0x04 || X || Y). A compressed or wrong-sized key is rejected here
 * rather than failing deep inside the transport.
 */
export function isValidBrowserPushPublicKey(p256dh: string): boolean {
  const decoded = decodeBase64Url(p256dh);
  if (!decoded || decoded.length !== 65) {
    return false;
  }
  return decoded[0] === 0x04;
}

/** The auth secret is 16 bytes. */
export function isValidBrowserPushAuthSecret(auth: string): boolean {
  const decoded = decodeBase64Url(auth);
  return decoded !== null && decoded.length === 16;
}

/**
 * Validates the registration input. Every failure is a VALIDATION error
 * naming the field — never the value, because the endpoint and the key
 * material are credential-grade.
 */
export function validateRegisterBrowserPushSubscriptionInput(
  input: RegisterBrowserPushSubscriptionInput,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const details: { field: string; message: string }[] = [];

  if (
    typeof input.deviceId !== 'string' ||
    input.deviceId.length === 0 ||
    input.deviceId.length > MAX_DEVICE_ID_LENGTH ||
    !DEVICE_ID_PATTERN.test(input.deviceId)
  ) {
    details.push({
      field: 'deviceId',
      message: `deviceId must be 1-${MAX_DEVICE_ID_LENGTH} characters of letters, digits, dots, underscores, colons, and hyphens.`,
    });
  }

  if (
    typeof input.endpoint !== 'string' ||
    input.endpoint.trim().length === 0 ||
    input.endpoint.trim().length > MAX_ENDPOINT_LENGTH
  ) {
    details.push({
      field: 'endpoint',
      message: `endpoint must be a non-empty push service URL of at most ${MAX_ENDPOINT_LENGTH} characters.`,
    });
  } else if (!isAllowedBrowserPushEndpoint(input.endpoint.trim(), env)) {
    details.push({
      field: 'endpoint',
      message:
        'endpoint must be an HTTPS URL on a known browser push service origin.',
    });
  }

  if (
    typeof input.p256dh !== 'string' ||
    !isValidBrowserPushPublicKey(input.p256dh.trim())
  ) {
    details.push({
      field: 'p256dh',
      message:
        'p256dh must be the base64url encoded uncompressed P-256 public key of the subscription.',
    });
  }

  if (
    typeof input.auth !== 'string' ||
    !isValidBrowserPushAuthSecret(input.auth.trim())
  ) {
    details.push({
      field: 'auth',
      message: 'auth must be the base64url encoded 16-byte subscription secret.',
    });
  }

  if (
    input.userAgent !== undefined &&
    input.userAgent !== null &&
    (typeof input.userAgent !== 'string' ||
      input.userAgent.trim().length > MAX_USER_AGENT_LENGTH)
  ) {
    details.push({
      field: 'userAgent',
      message: `userAgent must be at most ${MAX_USER_AGENT_LENGTH} characters.`,
    });
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }
}

const ROW_COLUMNS = `id, user_id AS "userId", device_id AS "deviceId",
            endpoint, p256dh, auth, user_agent AS "userAgent",
            status, registered_at AS "registeredAt", last_seen_at AS "lastSeenAt",
            created_at AS "createdAt", updated_at AS "updatedAt",
            provider, last_success_at AS "lastSuccessAt",
            last_failure_at AS "lastFailureAt",
            consecutive_failure_count AS "consecutiveFailureCount",
            invalidated_at AS "invalidatedAt",
            invalidation_reason AS "invalidationReason"`;

/**
 * Maps the persisted row to the PUBLIC shape. The endpoint, the public key
 * and the auth secret are credential-grade and are NOT copied into the
 * public shape — the client already owns them.
 */
export function toPublicBrowserPushSubscription(
  row: BrowserPushSubscriptionRecord,
): PublicBrowserPushSubscription {
  return {
    id: row.id,
    userId: row.userId,
    deviceId: row.deviceId,
    status: row.status,
    registeredAt: row.registeredAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The ACTIVE registration of one browser device. */
async function findActiveByDevice(
  userId: string,
  deviceId: string,
): Promise<BrowserPushSubscriptionRecord | null> {
  const result = await getPool().query<BrowserPushSubscriptionRecord>(
    `SELECT ${ROW_COLUMNS}
       FROM browser_push_subscriptions
      WHERE user_id = $1 AND device_id = $2 AND status = 'ACTIVE'`,
    [userId, deviceId],
  );
  return result.rows[0] ?? null;
}

/**
 * The single ACTIVE row holding this endpoint, across ALL users.
 *
 * Deliberately not user-scoped: an endpoint identifies a browser
 * installation, and the same installation re-registering under another
 * account must not leave the previous account still routed to it. This is
 * the only cross-user read in the module, it returns nothing to any
 * caller-facing surface, and it exists solely to retire the stale
 * registration.
 */
async function findActiveByEndpoint(
  endpoint: string,
): Promise<BrowserPushSubscriptionRecord | null> {
  const result = await getPool().query<BrowserPushSubscriptionRecord>(
    `SELECT ${ROW_COLUMNS}
       FROM browser_push_subscriptions
      WHERE endpoint = $1 AND status = 'ACTIVE'`,
    [endpoint],
  );
  return result.rows[0] ?? null;
}

async function retireActiveRow(id: string): Promise<void> {
  await getPool().query(
    `UPDATE browser_push_subscriptions
        SET status = 'INACTIVE', updated_at = NOW()
      WHERE id = $1 AND status = 'ACTIVE'`,
    [id],
  );
}

/**
 * Rotates the ACTIVE row of a browser device: the endpoint and the key pair
 * are replaced, and the failure evidence of the previous subscription is
 * reset — it described a subscription that no longer exists on this row.
 */
async function rotateActiveRow(
  id: string,
  endpoint: string,
  p256dh: string,
  auth: string,
  userAgent: string | null,
): Promise<BrowserPushSubscriptionRecord> {
  const updated = await getPool().query<BrowserPushSubscriptionRecord>(
    `UPDATE browser_push_subscriptions
        SET endpoint = $1, p256dh = $2, auth = $3, user_agent = $4,
            consecutive_failure_count = 0,
            invalidated_at = NULL,
            invalidation_reason = NULL,
            last_seen_at = NOW(), updated_at = NOW()
      WHERE id = $5
      RETURNING ${ROW_COLUMNS}`,
    [endpoint, p256dh, auth, userAgent, id],
  );
  return updated.rows[0];
}

/**
 * Registers (or rotates) a browser push subscription for the authenticated
 * user. Returns the ACTIVE registration.
 */
export async function registerBrowserPushSubscription(
  userId: string,
  input: RegisterBrowserPushSubscriptionInput,
): Promise<PublicBrowserPushSubscription> {
  validateRegisterBrowserPushSubscriptionInput(input);

  const deviceId = input.deviceId.trim();
  const endpoint = input.endpoint.trim();
  const p256dh = input.p256dh.trim();
  const auth = input.auth.trim();
  const userAgent =
    typeof input.userAgent === 'string' && input.userAgent.trim().length > 0
      ? input.userAgent.trim().slice(0, MAX_USER_AGENT_LENGTH)
      : null;

  // The endpoint reappeared on another browser — or under another account →
  // retire the previous ACTIVE row. Last valid registration wins; the
  // retired row is kept as INACTIVE history, never deleted.
  const existingEndpoint = await findActiveByEndpoint(endpoint);
  if (
    existingEndpoint &&
    (existingEndpoint.userId !== userId || existingEndpoint.deviceId !== deviceId)
  ) {
    await retireActiveRow(existingEndpoint.id);
  }

  // Same browser re-registers → ROTATE the endpoint and the key pair.
  const existingDevice = await findActiveByDevice(userId, deviceId);
  if (existingDevice) {
    return toPublicBrowserPushSubscription(
      await rotateActiveRow(
        existingDevice.id,
        endpoint,
        p256dh,
        auth,
        userAgent,
      ),
    );
  }

  try {
    const inserted = await getPool().query<BrowserPushSubscriptionRecord>(
      `INSERT INTO browser_push_subscriptions (
         id, user_id, device_id, endpoint, p256dh, auth, user_agent, status
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE')
       RETURNING ${ROW_COLUMNS}`,
      [randomUUID(), userId, deviceId, endpoint, p256dh, auth, userAgent],
    );
    return toPublicBrowserPushSubscription(inserted.rows[0]);
  } catch (error) {
    // Race guard: a concurrent registration of the same endpoint (any owner)
    // or of the same device retires the loser and retries via rotation.
    if (error instanceof Error && (error as { code?: string }).code === '23505') {
      const concurrent = await findActiveByEndpoint(endpoint);
      if (
        concurrent &&
        (concurrent.userId !== userId || concurrent.deviceId !== deviceId)
      ) {
        await retireActiveRow(concurrent.id);
      }
      const retry = await findActiveByDevice(userId, deviceId);
      if (retry) {
        return toPublicBrowserPushSubscription(
          await rotateActiveRow(retry.id, endpoint, p256dh, auth, userAgent),
        );
      }
    }
    throw error;
  }
}

/**
 * Revokes a browser subscription. Only the subscription's owner can revoke
 * it (authorization happens in the controller through the authenticated
 * user). The row is retained as INACTIVE history.
 */
export async function revokeBrowserPushSubscription(
  userId: string,
  subscriptionId: string,
): Promise<PublicBrowserPushSubscription | null> {
  const result = await getPool().query<BrowserPushSubscriptionRecord>(
    `UPDATE browser_push_subscriptions
        SET status = 'INACTIVE', updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND status = 'ACTIVE'
      RETURNING ${ROW_COLUMNS}`,
    [subscriptionId, userId],
  );
  return result.rows[0] ? toPublicBrowserPushSubscription(result.rows[0]) : null;
}

/**
 * Lists the authenticated user's browser subscriptions (newest first).
 * Scoped to the user's own registrations — no cross-user data is reachable.
 */
export async function listBrowserPushSubscriptions(
  userId: string,
): Promise<PublicBrowserPushSubscription[]> {
  const result = await getPool().query<BrowserPushSubscriptionRecord>(
    `SELECT ${ROW_COLUMNS}
       FROM browser_push_subscriptions
      WHERE user_id = $1
      ORDER BY registered_at DESC, id`,
    [userId],
  );
  return result.rows.map(toPublicBrowserPushSubscription);
}

/**
 * INTERNAL accessor — reads one subscription by id, whatever its status.
 * Used by the reconciliation seam to attach outcome evidence to the exact
 * row the attempt used.
 */
export async function findBrowserPushSubscriptionById(
  subscriptionId: string,
): Promise<BrowserPushSubscriptionRecord | null> {
  const result = await getPool().query<BrowserPushSubscriptionRecord>(
    `SELECT ${ROW_COLUMNS}
       FROM browser_push_subscriptions
      WHERE id = $1`,
    [subscriptionId],
  );
  return result.rows[0] ?? null;
}

/**
 * INTERNAL accessor — the ACTIVE browser subscriptions of one user.
 *
 * Returns full records (including the credential-grade endpoint and key
 * material) and is not reachable from any route. It is the seam the
 * send-time fan-out reads when it needs the subscriptions of a recipient it
 * has ALREADY authorized through the existing user/session and recipient
 * authorities. It performs no authorization of its own.
 */
export async function listActiveBrowserPushSubscriptionsForUser(
  userId: string,
): Promise<BrowserPushSubscriptionRecord[]> {
  const result = await getPool().query<BrowserPushSubscriptionRecord>(
    `SELECT ${ROW_COLUMNS}
       FROM browser_push_subscriptions
      WHERE user_id = $1 AND status = 'ACTIVE'
      ORDER BY registered_at DESC, id`,
    [userId],
  );
  return result.rows;
}

/**
 * INTERNAL transition — records that the push service ACCEPTED a message
 * for this subscription. Acceptance by a push service is not proof that a
 * browser displayed anything.
 */
export async function recordBrowserPushSubscriptionSuccess(
  subscriptionId: string,
  provider?: string | null,
): Promise<BrowserPushSubscriptionRecord | null> {
  const normalizedProvider =
    typeof provider === 'string' && provider.trim().length > 0
      ? provider.trim().slice(0, MAX_PROVIDER_LENGTH)
      : null;
  const result = await getPool().query<BrowserPushSubscriptionRecord>(
    `UPDATE browser_push_subscriptions
        SET last_success_at = NOW(),
            consecutive_failure_count = 0,
            provider = COALESCE($2, provider),
            updated_at = NOW()
      WHERE id = $1
      RETURNING ${ROW_COLUMNS}`,
    [subscriptionId, normalizedProvider],
  );
  return result.rows[0] ?? null;
}

/**
 * INTERNAL transition — records a FAILED attempt against this subscription.
 * A failure never changes the row's status: only an explicit, push-service-
 * proven invalidation retires a subscription.
 */
export async function recordBrowserPushSubscriptionFailure(
  subscriptionId: string,
  provider?: string | null,
): Promise<BrowserPushSubscriptionRecord | null> {
  const normalizedProvider =
    typeof provider === 'string' && provider.trim().length > 0
      ? provider.trim().slice(0, MAX_PROVIDER_LENGTH)
      : null;
  const result = await getPool().query<BrowserPushSubscriptionRecord>(
    `UPDATE browser_push_subscriptions
        SET last_failure_at = NOW(),
            consecutive_failure_count = consecutive_failure_count + 1,
            provider = COALESCE($2, provider),
            updated_at = NOW()
      WHERE id = $1
      RETURNING ${ROW_COLUMNS}`,
    [subscriptionId, normalizedProvider],
  );
  return result.rows[0] ?? null;
}

/**
 * INTERNAL transition — the push service proved this subscription is
 * permanently unusable (the endpoint expired or the user unsubscribed).
 *
 * The row becomes INVALID and keeps its provenance; it is NEVER deleted, so
 * "why did this browser stop receiving notifications" remains answerable.
 * The user may register again immediately; that later registration creates a
 * fresh ACTIVE row (or rotates the device's row) and leaves this evidence
 * untouched.
 */
export async function invalidateBrowserPushSubscription(
  subscriptionId: string,
  reason: string,
): Promise<BrowserPushSubscriptionRecord | null> {
  const sanitized = reason
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_INVALIDATION_REASON_LENGTH);
  if (sanitized.length === 0) {
    throw AppError.validation('Request validation failed.', [
      { field: 'reason', message: 'an invalidation reason is required.' },
    ]);
  }
  const result = await getPool().query<BrowserPushSubscriptionRecord>(
    `UPDATE browser_push_subscriptions
        SET status = 'INVALID',
            invalidated_at = NOW(),
            invalidation_reason = $2,
            last_failure_at = NOW(),
            consecutive_failure_count = consecutive_failure_count + 1,
            updated_at = NOW()
      WHERE id = $1 AND status = 'ACTIVE'
      RETURNING ${ROW_COLUMNS}`,
    [subscriptionId, sanitized],
  );
  return result.rows[0] ?? null;
}

/**
 * Revokes EVERY active subscription of a user (the "revoke all my browsers"
 * action). The rows are retained as INACTIVE history.
 */
export async function revokeAllBrowserPushSubscriptions(
  userId: string,
): Promise<number> {
  const result = await getPool().query(
    `UPDATE browser_push_subscriptions
        SET status = 'INACTIVE', updated_at = NOW()
      WHERE user_id = $1 AND status = 'ACTIVE'`,
    [userId],
  );
  return result.rowCount ?? 0;
}

export const browserPushSubscriptionService = {
  findBrowserPushSubscriptionById,
  invalidateBrowserPushSubscription,
  listActiveBrowserPushSubscriptionsForUser,
  listBrowserPushSubscriptions,
  recordBrowserPushSubscriptionFailure,
  recordBrowserPushSubscriptionSuccess,
  registerBrowserPushSubscription,
  revokeAllBrowserPushSubscriptions,
  revokeBrowserPushSubscription,
  toPublicBrowserPushSubscription,
  validateRegisterBrowserPushSubscriptionInput,
};

/** The 404 the controller raises when a subscription is not the caller's. */
export function browserPushSubscriptionNotFoundError(
  subscriptionId: string,
): AppError {
  return new AppError({
    code: ERROR_CODES.NOT_FOUND,
    message: 'Active browser push subscription not found.',
    statusCode: 404,
    resource: { type: 'BROWSER_PUSH_SUBSCRIPTION', id: subscriptionId },
  });
}
