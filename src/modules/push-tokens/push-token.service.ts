import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import type {
  PublicPushToken,
  PushPlatform,
  PushTokenRecord,
  RegisterPushTokenInput,
} from './push-token.types';

/**
 * BE-25L — Push token registration service.
 * CR-BE-PUSH-01 PART 01 — device registration foundation.
 *
 * Rules:
 *   - a token always belongs to an authenticated user (user_id is never
 *     client-supplied), and possession of a push token is NEVER
 *     authentication or authorization for anything,
 *   - one ACTIVE registration per (user, deviceId): re-registering the same
 *     device ROTATES the token (UPDATE, not a duplicate row),
 *   - one ACTIVE registration per push token GLOBALLY: a provider token that
 *     reappears on another device — or under another account — replaces the
 *     previous ACTIVE row, which becomes INACTIVE history. A single token
 *     must never route to two active users (migration 0334),
 *   - unregister sets the row INACTIVE (kept as history),
 *   - provider rejection sets the row INVALID with provenance (kept as
 *     history); a later registration of that device supersedes it with a
 *     fresh ACTIVE row and never mutates or removes the evidence,
 *   - rows are NEVER deleted — not on unregister, not on invalidation,
 *   - last_seen_at refreshes on every touch.
 *
 * Registration is NOT delivery. This module only stores/rotates/retires
 * tokens and records the outcome evidence that a future provider integration
 * (CR-BE-PUSH-01 PART 02+) will hand back to it: it never sends anything,
 * holds no provider integration, no credentials and no payload. Delivery,
 * when it exists, lives in its own module — never here.
 */

const MAX_DEVICE_ID_LENGTH = 128;
const MAX_PUSH_TOKEN_LENGTH = 512;
const MAX_APP_VERSION_LENGTH = 64;
const MAX_DEVICE_MODEL_LENGTH = 128;
const MAX_DEVICE_OS_VERSION_LENGTH = 64;
const MAX_INVALIDATION_REASON_LENGTH = 200;
const MAX_PROVIDER_LENGTH = 32;

const PUSH_TOKEN_PATTERN = /^[A-Za-z0-9:_\-=./]{8,512}$/;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Every column of the row, including the PART 01 internal evidence fields.
 * The evidence fields stay inside the backend: `toPublicPushToken` does not
 * copy them into the API shape.
 */
const ROW_COLUMNS = `id, user_id AS "userId", device_id AS "deviceId",
            push_token AS "pushToken", platform, app_version AS "appVersion",
            device_model AS "deviceModel", device_os_version AS "deviceOsVersion",
            status, registered_at AS "registeredAt", last_seen_at AS "lastSeenAt",
            created_at AS "createdAt", updated_at AS "updatedAt",
            provider, last_success_at AS "lastSuccessAt",
            last_failure_at AS "lastFailureAt",
            consecutive_failure_count AS "consecutiveFailureCount",
            invalidated_at AS "invalidatedAt",
            invalidation_reason AS "invalidationReason"`;

/**
 * Maps the persisted row to the PUBLIC registration shape.
 *
 * The shape is intentionally identical to the BE-25L contract: provider
 * identity, success/failure timestamps, failure counters and invalidation
 * reasons are internal routing/diagnostic metadata and are never returned to
 * a client.
 */
export function toPublicPushToken(row: PushTokenRecord): PublicPushToken {
  return {
    id: row.id,
    userId: row.userId,
    deviceId: row.deviceId,
    pushToken: row.pushToken,
    platform: row.platform,
    appVersion: row.appVersion,
    deviceModel: row.deviceModel,
    deviceOsVersion: row.deviceOsVersion,
    status: row.status,
    registeredAt: row.registeredAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function normalizeOptional(
  value: unknown,
  maxLength: number,
  field: string,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} must be a non-empty string.` },
    ]);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} must be at most ${maxLength} characters.` },
    ]);
  }
  return trimmed;
}

export function validateRegisterInput(
  input: RegisterPushTokenInput,
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
    typeof input.pushToken !== 'string' ||
    !PUSH_TOKEN_PATTERN.test(input.pushToken)
  ) {
    details.push({
      field: 'pushToken',
      message: 'pushToken must be 8-512 characters of letters, digits, colons, underscores, hyphens, dots, slashes, and equals signs.',
    });
  }
  if (input.platform !== 'ANDROID' && input.platform !== 'IOS') {
    details.push({
      field: 'platform',
      message: 'platform must be ANDROID or IOS.',
    });
  }
  for (const [key, max] of [
    ['appVersion', MAX_APP_VERSION_LENGTH],
    ['deviceModel', MAX_DEVICE_MODEL_LENGTH],
    ['deviceOsVersion', MAX_DEVICE_OS_VERSION_LENGTH],
  ] as const) {
    const value = input[key];
    if (value !== undefined && value !== null) {
      if (typeof value !== 'string' || value.trim().length === 0) {
        details.push({
          field: key,
          message: `${key} must be a non-empty string.`,
        });
      } else if (value.trim().length > max) {
        details.push({
          field: key,
          message: `${key} must be at most ${max} characters.`,
        });
      }
    }
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }
}

async function findActiveByDevice(
  userId: string,
  deviceId: string,
): Promise<PushTokenRecord | null> {
  const result = await getPool().query<PushTokenRecord>(
    `SELECT ${ROW_COLUMNS}
       FROM mobile_push_tokens
      WHERE user_id = $1 AND device_id = $2 AND status = 'ACTIVE'`,
    [userId, deviceId],
  );
  return result.rows[0] ?? null;
}

/**
 * Finds the single ACTIVE row holding this provider token, across ALL users.
 *
 * The lookup is deliberately not user-scoped: a provider token identifies an
 * app installation, and the same installation re-registering under a
 * different account must not leave the previous account still routed to that
 * handset. This is the only cross-user read in the module, it returns nothing
 * to any caller-facing surface, and it exists solely to retire the stale
 * registration (§7 #11).
 */
async function findActiveByToken(
  pushToken: string,
): Promise<PushTokenRecord | null> {
  const result = await getPool().query<PushTokenRecord>(
    `SELECT ${ROW_COLUMNS}
       FROM mobile_push_tokens
      WHERE push_token = $1 AND status = 'ACTIVE'`,
    [pushToken],
  );
  return result.rows[0] ?? null;
}

async function retireActiveRow(id: string): Promise<void> {
  await getPool().query(
    `UPDATE mobile_push_tokens
        SET status = 'INACTIVE', updated_at = NOW()
      WHERE id = $1 AND status = 'ACTIVE'`,
    [id],
  );
}

async function rotateActiveRow(
  id: string,
  pushToken: string,
  platform: PushPlatform,
  appVersion: string | null,
  deviceModel: string | null,
  deviceOsVersion: string | null,
): Promise<PushTokenRecord> {
  // A refreshed registration is a healthy device again: the failure evidence
  // of the previous token value is reset and any invalidation provenance is
  // cleared, because it described a token that no longer exists on this row.
  const updated = await getPool().query<PushTokenRecord>(
    `UPDATE mobile_push_tokens
        SET push_token = $1, platform = $2, app_version = $3,
            device_model = $4, device_os_version = $5,
            consecutive_failure_count = 0,
            invalidated_at = NULL,
            invalidation_reason = NULL,
            last_seen_at = NOW(), updated_at = NOW()
      WHERE id = $6
      RETURNING ${ROW_COLUMNS}`,
    [pushToken, platform, appVersion, deviceModel, deviceOsVersion, id],
  );
  return updated.rows[0];
}

/**
 * Registers (or rotates) a push token for the authenticated user's device.
 * Returns the ACTIVE registration row.
 */
export async function registerPushToken(
  userId: string,
  input: RegisterPushTokenInput,
): Promise<PublicPushToken> {
  validateRegisterInput(input);

  const deviceId = input.deviceId.trim();
  const pushToken = input.pushToken.trim();
  const appVersion = normalizeOptional(input.appVersion, MAX_APP_VERSION_LENGTH, 'appVersion');
  const deviceModel = normalizeOptional(input.deviceModel, MAX_DEVICE_MODEL_LENGTH, 'deviceModel');
  const deviceOsVersion = normalizeOptional(
    input.deviceOsVersion,
    MAX_DEVICE_OS_VERSION_LENGTH,
    'deviceOsVersion',
  );

  // The token reappeared on another device — or under another account →
  // retire the previous ACTIVE row. Last valid registration wins; the retired
  // row is kept as INACTIVE history, never deleted. The global partial unique
  // index forbids two ACTIVE rows with the same token.
  const existingToken = await findActiveByToken(pushToken);
  if (
    existingToken &&
    (existingToken.userId !== userId || existingToken.deviceId !== deviceId)
  ) {
    await retireActiveRow(existingToken.id);
  }

  // Same device re-registers → ROTATE the token on the ACTIVE row.
  const existingDevice = await findActiveByDevice(userId, deviceId);
  if (existingDevice) {
    return toPublicPushToken(
      await rotateActiveRow(
        existingDevice.id,
        pushToken,
        input.platform,
        appVersion,
        deviceModel,
        deviceOsVersion,
      ),
    );
  }

  // No ACTIVE row for this device: a first registration, or a registration
  // that supersedes retired (INACTIVE) or provider-rejected (INVALID)
  // history. The historical rows stay exactly as they are.
  try {
    const inserted = await getPool().query<PushTokenRecord>(
      `INSERT INTO mobile_push_tokens (
         id, user_id, device_id, push_token, platform, app_version,
         device_model, device_os_version, status
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ACTIVE')
       RETURNING ${ROW_COLUMNS}`,
      [
        randomUUID(),
        userId,
        deviceId,
        pushToken,
        input.platform,
        appVersion,
        deviceModel,
        deviceOsVersion,
      ],
    );
    return toPublicPushToken(inserted.rows[0]);
  } catch (error) {
    // Race guard: a concurrent registration of the same token (any owner) or
    // of the same device retires the loser and retries via rotation.
    if (error instanceof Error && (error as { code?: string }).code === '23505') {
      const concurrent = await findActiveByToken(pushToken);
      if (
        concurrent &&
        (concurrent.userId !== userId || concurrent.deviceId !== deviceId)
      ) {
        await retireActiveRow(concurrent.id);
      }
      const retry = await findActiveByDevice(userId, deviceId);
      if (retry) {
        return toPublicPushToken(
          await rotateActiveRow(
            retry.id,
            pushToken,
            input.platform,
            appVersion,
            deviceModel,
            deviceOsVersion,
          ),
        );
      }
    }
    throw error;
  }
}

/**
 * Deactivates/unregisters a push token. Only the token's owner can
 * deactivate it (authorization happens in the controller via the
 * authenticated user). The row is retained as INACTIVE history.
 */
export async function deactivatePushToken(
  userId: string,
  pushTokenId: string,
): Promise<PublicPushToken | null> {
  const result = await getPool().query<PushTokenRecord>(
    `UPDATE mobile_push_tokens
        SET status = 'INACTIVE', updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND status = 'ACTIVE'
      RETURNING ${ROW_COLUMNS}`,
    [pushTokenId, userId],
  );
  return result.rows[0] ? toPublicPushToken(result.rows[0]) : null;
}

/**
 * Lists the authenticated user's push token registrations (newest first).
 * Scoped to the user's own registrations — no cross-user data is ever
 * reachable, so Client/Building isolation is trivially preserved.
 */
export async function listPushTokens(userId: string): Promise<PublicPushToken[]> {
  const result = await getPool().query<PushTokenRecord>(
    `SELECT ${ROW_COLUMNS}
       FROM mobile_push_tokens
      WHERE user_id = $1
      ORDER BY registered_at DESC, id`,
    [userId],
  );
  return result.rows.map(toPublicPushToken);
}

/**
 * INTERNAL accessor — the ACTIVE device registrations of one user.
 *
 * Returns full records (including the internal evidence fields) and is not
 * reachable from any route: no controller calls it. It is the seam a later
 * PART reads when it needs the set of usable devices for a recipient it has
 * ALREADY authorized through the existing user/session and recipient
 * authorities. It performs no authorization of its own and must never be
 * used to decide access.
 */
export async function listActivePushTokensForUser(
  userId: string,
): Promise<PushTokenRecord[]> {
  const result = await getPool().query<PushTokenRecord>(
    `SELECT ${ROW_COLUMNS}
       FROM mobile_push_tokens
      WHERE user_id = $1 AND status = 'ACTIVE'
      ORDER BY registered_at DESC, id`,
    [userId],
  );
  return result.rows;
}

/**
 * INTERNAL accessor — reads one registration by id, whatever its status.
 * Used by later PARTs to attach outcome evidence to the exact row they used.
 */
export async function findPushTokenById(
  pushTokenId: string,
): Promise<PushTokenRecord | null> {
  const result = await getPool().query<PushTokenRecord>(
    `SELECT ${ROW_COLUMNS}
       FROM mobile_push_tokens
      WHERE id = $1`,
    [pushTokenId],
  );
  return result.rows[0] ?? null;
}

/**
 * INTERNAL transition — records that the provider ACCEPTED a message for this
 * registration. Acceptance by a provider is not proof that a handset showed
 * anything; this only stamps the last accepted attempt and clears the
 * consecutive-failure streak.
 */
export async function recordPushTokenSuccess(
  pushTokenId: string,
  provider?: string | null,
): Promise<PushTokenRecord | null> {
  const normalizedProvider =
    typeof provider === 'string' && provider.trim().length > 0
      ? provider.trim().slice(0, MAX_PROVIDER_LENGTH)
      : null;
  const result = await getPool().query<PushTokenRecord>(
    `UPDATE mobile_push_tokens
        SET last_success_at = NOW(),
            consecutive_failure_count = 0,
            provider = COALESCE($2, provider),
            updated_at = NOW()
      WHERE id = $1
      RETURNING ${ROW_COLUMNS}`,
    [pushTokenId, normalizedProvider],
  );
  return result.rows[0] ?? null;
}

/**
 * INTERNAL transition — records a FAILED attempt against this registration.
 * A failure never changes the row's status: only an explicit, provider-proven
 * invalidation retires a device (see `invalidatePushToken`).
 */
export async function recordPushTokenFailure(
  pushTokenId: string,
  provider?: string | null,
): Promise<PushTokenRecord | null> {
  const normalizedProvider =
    typeof provider === 'string' && provider.trim().length > 0
      ? provider.trim().slice(0, MAX_PROVIDER_LENGTH)
      : null;
  const result = await getPool().query<PushTokenRecord>(
    `UPDATE mobile_push_tokens
        SET last_failure_at = NOW(),
            consecutive_failure_count = consecutive_failure_count + 1,
            provider = COALESCE($2, provider),
            updated_at = NOW()
      WHERE id = $1
      RETURNING ${ROW_COLUMNS}`,
    [pushTokenId, normalizedProvider],
  );
  return result.rows[0] ?? null;
}

/**
 * INTERNAL transition — the provider proved this registration is permanently
 * unusable (uninstalled app, revoked registration).
 *
 *   - the row becomes INVALID and keeps its provenance: token value,
 *     timestamps, device metadata and counters all stay,
 *   - `invalidated_at` is stamped and a SANITIZED, bounded reason is stored
 *     (a provider status code — never a token, credential or payload),
 *   - the row is NEVER deleted, so "why did this device stop receiving
 *     notifications" remains answerable,
 *   - the user may immediately register the device again; that later
 *     registration creates a fresh ACTIVE row and leaves this evidence
 *     untouched.
 *
 * Only an ACTIVE row can be invalidated — an already-retired registration is
 * not re-retired, and an unknown id returns null.
 */
export async function invalidatePushToken(
  pushTokenId: string,
  reason: string,
): Promise<PushTokenRecord | null> {
  const sanitized = reason
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_INVALIDATION_REASON_LENGTH);
  if (sanitized.length === 0) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'reason',
        message: 'an invalidation reason is required.',
      },
    ]);
  }
  const result = await getPool().query<PushTokenRecord>(
    `UPDATE mobile_push_tokens
        SET status = 'INVALID',
            invalidated_at = NOW(),
            invalidation_reason = $2,
            last_failure_at = NOW(),
            consecutive_failure_count = consecutive_failure_count + 1,
            updated_at = NOW()
      WHERE id = $1 AND status = 'ACTIVE'
      RETURNING ${ROW_COLUMNS}`,
    [pushTokenId, sanitized],
  );
  return result.rows[0] ?? null;
}

export const pushTokenService = {
  deactivatePushToken,
  findPushTokenById,
  invalidatePushToken,
  listActivePushTokensForUser,
  listPushTokens,
  recordPushTokenFailure,
  recordPushTokenSuccess,
  registerPushToken,
  toPublicPushToken,
  validateRegisterInput,
};
