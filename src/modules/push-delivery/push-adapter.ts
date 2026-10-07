import { randomUUID } from 'node:crypto';
import { ConfigError, getAppConfig } from '../../config';
import { FcmPushAdapter } from './fcm-push-adapter';

/**
 * CR-BE-PUSH-01 PART 02 — mobile push delivery adapter abstraction.
 *
 * The adapter interface is provider-agnostic, exactly like the BE-26F
 * `EmailAdapter` and BE-26G `WhatsAppAdapter` seams: a concrete provider
 * implements `PushAdapter` and is selected by the `PUSH_PROVIDER`
 * discriminator. No provider object, SDK type, HTTP response or credential
 * ever leaves this module — callers only ever see `PushSendResult`.
 *
 * Adapters shipped by PART 02 (governance §5.3):
 *   - `noop`    — never contacts anything; returns a synthetic reference,
 *   - `capture` — never contacts anything; additionally records every send
 *     input in memory for deterministic local/test validation,
 *   - `fcm`     — real Firebase Cloud Messaging HTTP v1 delivery (Android
 *     natively, iOS through FCM's APNs relay). Credentials are read inside
 *     the adapter's construction boundary, never here.
 *
 * BOUNDARIES THIS LAYER MUST NOT CROSS (governance §5, §8, §11, §15)
 * ------------------------------------------------------------------
 *   - No database access. The adapter is side-effect free with respect to
 *     `mobile_push_tokens`: it may *classify* a token as invalid, but the
 *     transition to `status = 'INVALID'` (`invalidatePushToken`) belongs to
 *     PART 04.
 *   - No retry scheduling, no attempt counters, no ledger writes, no backoff.
 *     PART 02 classifies; PART 04 decides what to do about it.
 *   - No payload enrichment. The caller passes an already-safe pointer
 *     payload (§9); this layer only enforces defensive bounds on it.
 */

export const PUSH_ADAPTER_PLATFORMS = ['ANDROID', 'IOS'] as const;

export type PushAdapterPlatform = (typeof PUSH_ADAPTER_PLATFORMS)[number];

export type PushSendInput = {
  /** Opaque provider device token. NEVER logged or echoed in full. */
  token: string;
  /** Target platform (FCM relays IOS to APNs server-side). */
  platform: PushAdapterPlatform;
  /** Rendered notification title (pointer text only — see §9). */
  title: string;
  /** Rendered notification body (pointer text only — see §9). */
  body: string | null;
  /**
   * Minimal, non-sensitive routing data (§9): notificationId, entityType,
   * entityId, eventType, deliveryId. Values are strings — FCM's `data` map
   * is string→string.
   */
  data?: Record<string, string>;
  /**
   * Correlation id for the delivery this send belongs to, when the caller
   * has one (PART 03 supplies the ledger row id). Used only to correlate the
   * normalized result; the adapter never persists it.
   */
  deliveryId?: string | null;
};

/**
 * Normalized push failure code vocabulary. Provider-specific codes are mapped
 * into these values so that no caller ever branches on an FCM string.
 */
export const PUSH_ERROR_CODES = [
  /** Defensive payload/input validation rejected the send before any I/O. */
  'PAYLOAD_INVALID',
  /** Provider rejected the request as malformed/invalid (not the token). */
  'INVALID_REQUEST',
  /** The device token is permanently unusable (§8). */
  'INVALID_TOKEN',
  /** Provider credentials/permissions are wrong — a configuration fault. */
  'AUTHENTICATION_FAILED',
  /** Provider throttled the sender or the device. */
  'RATE_LIMITED',
  /** Provider is overloaded/erroring transiently. */
  'PROVIDER_UNAVAILABLE',
  /** No HTTP response at all (DNS, socket, timeout, abort). */
  'NETWORK_ERROR',
  /** A response arrived but could not be classified. */
  'UNKNOWN_ERROR',
] as const;

export type PushErrorCode = (typeof PUSH_ERROR_CODES)[number];

export function isPushErrorCode(value: unknown): value is PushErrorCode {
  return (
    typeof value === 'string' && (PUSH_ERROR_CODES as readonly string[]).includes(value)
  );
}

export type PushSendResult = {
  status: 'SENT' | 'FAILED';
  /** The adapter that produced this result (`noop` / `capture` / `fcm`). */
  provider: string;
  /** Normalized provider message id where available. */
  providerMessageId?: string | null;
  /** Sanitized failure message — MUST never contain a credential or token. */
  error?: string | null;
  /** Normalized failure code (absent for SENT). */
  errorCode?: PushErrorCode | null;
  /**
   * Classification hint for a FAILED outcome: `true` marks a transient
   * failure a later attempt may resolve; absent/false is the conservative
   * default (permanent). PART 02 only classifies — it never retries.
   */
  retryable?: boolean;
  /**
   * TRUE only for provider codes that PROVE the device token is dead (§8).
   * PART 02 reports it; PART 04 performs the `mobile_push_tokens` transition.
   * The adapter itself never touches the database.
   */
  tokenInvalid?: boolean;
  /** Echo of the caller's correlation id, when one was supplied. */
  deliveryId?: string | null;
  /** When the provider accepted (or rejected) the send. */
  sentAt: Date;
};

export interface PushAdapter {
  /** Stable provider discriminator (recorded on the delivery). */
  readonly provider: string;
  send(input: PushSendInput): Promise<PushSendResult>;
}

// ---------------------------------------------------------------------------
// Normalized outcome taxonomy
// ---------------------------------------------------------------------------

/**
 * The four outcomes the future delivery lifecycle (PART 03/04) reasons about.
 * `INVALID_TOKEN` is the push-only outcome: it is permanent *for that device*
 * and additionally proves the address itself is dead — push is the only
 * channel whose address is issued and revoked by the provider.
 */
export const PUSH_DELIVERY_OUTCOMES = [
  'ACCEPTED',
  'REJECTED_RETRYABLE',
  'REJECTED_PERMANENT',
  'INVALID_TOKEN',
] as const;

export type PushDeliveryOutcome = (typeof PUSH_DELIVERY_OUTCOMES)[number];

export function isPushDeliveryOutcome(value: unknown): value is PushDeliveryOutcome {
  return (
    typeof value === 'string' &&
    (PUSH_DELIVERY_OUTCOMES as readonly string[]).includes(value)
  );
}

/**
 * Normalizes an adapter result into a delivery outcome.
 *
 * `SENT` → `ACCEPTED` (provider acceptance, NOT handset display — governance
 * §3). A failure is `INVALID_TOKEN` when the provider proved the token is
 * dead, `REJECTED_RETRYABLE` when the adapter explicitly classified it as
 * transient, and `REJECTED_PERMANENT` otherwise (conservative default).
 */
export function classifyPushResult(result: PushSendResult): PushDeliveryOutcome {
  if (result.status === 'SENT') {
    return 'ACCEPTED';
  }
  if (result.tokenInvalid === true) {
    return 'INVALID_TOKEN';
  }
  return result.retryable === true ? 'REJECTED_RETRYABLE' : 'REJECTED_PERMANENT';
}

/**
 * Whether an outcome permits another attempt to the SAME device. An invalid
 * token is never retried for that device (§8/§13.2).
 */
export function isRetryablePushOutcome(outcome: PushDeliveryOutcome): boolean {
  return outcome === 'REJECTED_RETRYABLE';
}

// ---------------------------------------------------------------------------
// Defensive payload validation (governance §9 — bounds, not policy)
// ---------------------------------------------------------------------------

/**
 * Defensive bounds enforced by EVERY adapter. The caller (PART 03) owns the
 * payload allow-list; this layer is the last line of defence so that a coding
 * mistake cannot ship an oversized or reserved-key payload to a provider.
 */
export const PUSH_PAYLOAD_LIMITS = {
  /** Provider tokens are bounded by the BE-25L column (VARCHAR(512)). */
  tokenMaxLength: 512,
  /** §9 title bound. */
  titleMaxLength: 100,
  /** §9 body bound. */
  bodyMaxLength: 240,
  /** Routing pointers only — a payload needing more keys is a design error. */
  dataMaxKeys: 12,
  dataKeyMaxLength: 64,
  dataValueMaxLength: 256,
  /** Conservative ceiling well below FCM's 4096-byte message limit. */
  dataMaxTotalBytes: 2048,
} as const;

/**
 * Data keys FCM reserves internally; sending them is an INVALID_ARGUMENT.
 * Rejected locally so the failure is deterministic and costs no request.
 */
const RESERVED_DATA_KEY = /^(from|gcm|notification|message_type|collapse_key)$|^google/i;

/** Validation failure: a human-readable reason, never containing the token. */
export type PushPayloadViolation = string;

/**
 * Validates a send input against the defensive bounds. Returns the list of
 * violations (empty when the payload is acceptable). Pure — no I/O, no
 * database, no provider contact.
 */
export function validatePushPayload(input: PushSendInput): PushPayloadViolation[] {
  const violations: PushPayloadViolation[] = [];

  const token = typeof input.token === 'string' ? input.token.trim() : '';
  if (token.length === 0) {
    violations.push('push token is required');
  } else if (token.length > PUSH_PAYLOAD_LIMITS.tokenMaxLength) {
    violations.push(
      `push token exceeds ${PUSH_PAYLOAD_LIMITS.tokenMaxLength} characters`,
    );
  }

  if (!(PUSH_ADAPTER_PLATFORMS as readonly string[]).includes(input.platform)) {
    violations.push(
      `platform must be one of: ${PUSH_ADAPTER_PLATFORMS.join(', ')}`,
    );
  }

  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (title.length === 0) {
    violations.push('title is required');
  } else if (title.length > PUSH_PAYLOAD_LIMITS.titleMaxLength) {
    violations.push(`title exceeds ${PUSH_PAYLOAD_LIMITS.titleMaxLength} characters`);
  }

  if (
    input.body !== null &&
    input.body !== undefined &&
    input.body.length > PUSH_PAYLOAD_LIMITS.bodyMaxLength
  ) {
    violations.push(`body exceeds ${PUSH_PAYLOAD_LIMITS.bodyMaxLength} characters`);
  }

  const data = input.data ?? {};
  const entries = Object.entries(data);
  if (entries.length > PUSH_PAYLOAD_LIMITS.dataMaxKeys) {
    violations.push(`data exceeds ${PUSH_PAYLOAD_LIMITS.dataMaxKeys} keys`);
  }
  let totalBytes = 0;
  for (const [key, value] of entries) {
    if (key.length === 0 || key.length > PUSH_PAYLOAD_LIMITS.dataKeyMaxLength) {
      violations.push(
        `data key must be 1..${PUSH_PAYLOAD_LIMITS.dataKeyMaxLength} characters`,
      );
      continue;
    }
    if (RESERVED_DATA_KEY.test(key)) {
      violations.push(`data key '${key}' is reserved by the push provider`);
      continue;
    }
    if (typeof value !== 'string') {
      violations.push(`data key '${key}' must map to a string value`);
      continue;
    }
    if (value.length > PUSH_PAYLOAD_LIMITS.dataValueMaxLength) {
      violations.push(
        `data key '${key}' exceeds ${PUSH_PAYLOAD_LIMITS.dataValueMaxLength} characters`,
      );
      continue;
    }
    totalBytes += Buffer.byteLength(key, 'utf8') + Buffer.byteLength(value, 'utf8');
  }
  if (totalBytes > PUSH_PAYLOAD_LIMITS.dataMaxTotalBytes) {
    violations.push(
      `data payload exceeds ${PUSH_PAYLOAD_LIMITS.dataMaxTotalBytes} bytes`,
    );
  }

  return violations;
}

/**
 * A deterministic, non-reversing fingerprint of a device token, safe for logs
 * and diagnostics. NEVER log or return the token itself.
 */
export function pushTokenFingerprint(token: string): string {
  const value = typeof token === 'string' ? token : '';
  if (value.length <= 6) {
    return `len:${value.length}`;
  }
  return `${value.slice(0, 4)}…${value.slice(-2)}(len:${value.length})`;
}

/** Builds the shared PAYLOAD_INVALID result (no provider is contacted). */
function payloadRejection(
  provider: string,
  violations: PushPayloadViolation[],
  deliveryId: string | null | undefined,
): PushSendResult {
  return {
    status: 'FAILED',
    provider,
    error: `Push payload rejected: ${violations.join('; ')}.`,
    errorCode: 'PAYLOAD_INVALID',
    retryable: false,
    tokenInvalid: false,
    deliveryId: deliveryId ?? null,
    sentAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// Credential-less adapters
// ---------------------------------------------------------------------------

/** Simulated outcomes shared by the credential-less adapters. */
export type SimulatedPushOutcome =
  | 'sent'
  | 'fail'
  | 'fail-permanent'
  | 'fail-retryable'
  | 'fail-invalid-token';

function simulatedFailure(
  provider: string,
  outcome: Exclude<SimulatedPushOutcome, 'sent'>,
  deliveryId: string | null | undefined,
  sentAt: Date,
): PushSendResult {
  if (outcome === 'fail-invalid-token') {
    return {
      status: 'FAILED',
      provider,
      error: `Simulated invalid device token (${provider} adapter).`,
      errorCode: 'INVALID_TOKEN',
      retryable: false,
      tokenInvalid: true,
      deliveryId: deliveryId ?? null,
      sentAt,
    };
  }
  const retryable = outcome === 'fail-retryable';
  return {
    status: 'FAILED',
    provider,
    error: `Simulated push provider failure (${provider} adapter).`,
    errorCode: retryable ? 'PROVIDER_UNAVAILABLE' : 'UNKNOWN_ERROR',
    retryable,
    tokenInvalid: false,
    deliveryId: deliveryId ?? null,
    sentAt,
  };
}

/**
 * Credential-less no-op adapter. Never contacts a push provider and never
 * reads a credential. Its constructor outcome lets tests (and future wiring)
 * simulate every branch of the taxonomy deterministically.
 */
export class NoopPushAdapter implements PushAdapter {
  readonly provider = 'noop';

  private readonly outcome: SimulatedPushOutcome;

  constructor(outcome: SimulatedPushOutcome = 'sent') {
    this.outcome = outcome;
  }

  async send(input: PushSendInput): Promise<PushSendResult> {
    const violations = validatePushPayload(input);
    if (violations.length > 0) {
      return payloadRejection(this.provider, violations, input.deliveryId);
    }
    const sentAt = new Date();
    if (this.outcome !== 'sent') {
      return simulatedFailure(this.provider, this.outcome, input.deliveryId, sentAt);
    }
    return {
      status: 'SENT',
      provider: this.provider,
      providerMessageId: `noop-${randomUUID()}`,
      retryable: false,
      tokenInvalid: false,
      deliveryId: input.deliveryId ?? null,
      sentAt,
    };
  }
}

/** One captured send, in send order. The token is stored fingerprinted. */
export type CapturedPushSend = {
  tokenFingerprint: string;
  platform: PushAdapterPlatform;
  title: string;
  body: string | null;
  data: Record<string, string>;
  deliveryId: string | null;
  providerMessageId: string;
  sentAt: Date;
};

/**
 * Credential-less capture adapter. Never contacts any external system: it
 * records every successful send in an in-memory list for deterministic
 * local/test validation and returns a synthetic `providerMessageId`.
 *
 * The captured token is a fingerprint, not the token — capture output is
 * routinely printed in test failures, and a real token must never surface
 * there. This adapter is never the production default.
 */
export class CapturePushAdapter implements PushAdapter {
  readonly provider = 'capture';

  private readonly sent: CapturedPushSend[] = [];

  private readonly outcome: SimulatedPushOutcome;

  constructor(outcome: SimulatedPushOutcome = 'sent') {
    this.outcome = outcome;
  }

  /** Snapshot of the payloads captured so far (successful sends only). */
  get captures(): readonly CapturedPushSend[] {
    return [...this.sent];
  }

  /** Clears the capture list (test convenience only). */
  reset(): void {
    this.sent.length = 0;
  }

  async send(input: PushSendInput): Promise<PushSendResult> {
    const violations = validatePushPayload(input);
    if (violations.length > 0) {
      return payloadRejection(this.provider, violations, input.deliveryId);
    }
    const sentAt = new Date();
    if (this.outcome !== 'sent') {
      return simulatedFailure(this.provider, this.outcome, input.deliveryId, sentAt);
    }
    const providerMessageId = `capture-${randomUUID()}`;
    this.sent.push({
      tokenFingerprint: pushTokenFingerprint(input.token),
      platform: input.platform,
      title: input.title,
      body: input.body ?? null,
      data: { ...(input.data ?? {}) },
      deliveryId: input.deliveryId ?? null,
      providerMessageId,
      sentAt,
    });
    return {
      status: 'SENT',
      provider: this.provider,
      providerMessageId,
      retryable: false,
      tokenInvalid: false,
      deliveryId: input.deliveryId ?? null,
      sentAt,
    };
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Provider discriminators that never read credentials and are always allowed,
 * including under `NODE_ENV=test` (the test-environment guard below).
 */
export const CREDENTIAL_LESS_PUSH_PROVIDERS = ['noop', 'capture'] as const;

/** All implemented push provider discriminators (for fail-fast messages). */
export const AVAILABLE_PUSH_PROVIDERS = ['noop', 'capture', 'fcm'] as const;

/**
 * Selects the configured push adapter (`PUSH_PROVIDER`). Implemented
 * providers: the credential-less `noop`/`capture` adapters and the real `fcm`
 * adapter, whose credentials are read at its own construction boundary and
 * never here.
 *
 * FAIL-CLOSED CONTRACT (governance §12.2):
 *   - in the test environment ONLY credential-less providers resolve — a real
 *     push can never be sent by a test,
 *   - an unknown provider throws `ConfigError` — there is NO silent fallback
 *     to a different provider and no implicit real-delivery path,
 *   - `fcm` with missing/invalid credentials throws `ConfigError` from the
 *     adapter constructor rather than degrading to a no-op.
 */
export function resolvePushAdapter(): PushAdapter {
  const config = getAppConfig();
  const { provider } = config.push;
  if (provider === 'noop') {
    return new NoopPushAdapter();
  }
  if (provider === 'capture') {
    return new CapturePushAdapter();
  }
  if (config.isTest) {
    throw new ConfigError(
      `Invalid configuration: PUSH_PROVIDER '${provider}' cannot be resolved in the test environment (credential-less providers only: ${CREDENTIAL_LESS_PUSH_PROVIDERS.join(', ')}).`,
    );
  }
  if (provider === 'fcm') {
    return new FcmPushAdapter();
  }
  throw new ConfigError(
    `Invalid configuration: no push adapter is implemented for PUSH_PROVIDER '${provider}' (available: ${AVAILABLE_PUSH_PROVIDERS.join(', ')}).`,
  );
}
