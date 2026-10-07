import { createSign } from 'node:crypto';
import { ConfigError } from '../../config';
import {
  pushTokenFingerprint,
  validatePushPayload,
  type PushAdapter,
  type PushErrorCode,
  type PushSendInput,
  type PushSendResult,
} from './push-adapter';

/**
 * CR-BE-PUSH-01 PART 02 — Firebase Cloud Messaging HTTP v1 adapter.
 *
 * Provider decision (governance §5.2): `PUSH_PROVIDER=fcm` is the single
 * concrete implementation. Android is served natively; **iOS is served
 * through FCM's server-side APNs relay** — no direct APNs adapter, no APNs
 * `.p8` key, no second credential custody model. No OneSignal, no Expo, no
 * Web Push / VAPID.
 *
 * DEPENDENCY DECISION (governance §5.3)
 * -------------------------------------
 * ZERO new dependencies. `package.json` contains no Firebase Admin SDK and no
 * Google auth library, and governance §5.3 authorises the FCM HTTP v1 REST
 * API over the built-in `fetch` unless service-account OAuth2 signing proves
 * impossible with `node:crypto` alone — it does not: the JWT bearer flow is
 * an RS256 signature (`createSign('RSA-SHA256')`) plus one token exchange.
 * This also keeps the B-01j "no push vendor dependency" guard green.
 *
 * SECRETS BOUNDARY (governance §12.2)
 * -----------------------------------
 * All FCM configuration — including `PUSH_FCM_PRIVATE_KEY` — is read INSIDE
 * this module at adapter construction (`readFcmPushConfig`). Nothing reaches
 * `AppConfig` (env.ts reads only the `PUSH_PROVIDER` discriminator), and no
 * credential is ever logged, returned by any seam, written to a business
 * table, or embedded in an error message (credential-like fragments are
 * redacted before any text leaves this module). Escaped `\n` sequences in the
 * PEM are normalized ONLY here, at the config seam.
 *
 * SIDE-EFFECT BOUNDARY (governance §8, §15)
 * -----------------------------------------
 * This adapter performs NO database access. When FCM proves a token is dead
 * it sets `tokenInvalid: true` on the normalized result and stops there — the
 * `mobile_push_tokens` transition to `INVALID` (`invalidatePushToken`) is
 * PART 04's job. It also performs no retry scheduling and no ledger writes.
 */

// ---------------------------------------------------------------------------
// Configuration (read at the adapter boundary only)
// ---------------------------------------------------------------------------

export type FcmPushConfig = {
  projectId: string;
  clientEmail: string;
  /** Service-account PEM private key (newlines already normalized). */
  privateKey: string;
  apiBaseUrl: string;
  tokenUri: string;
  timeoutMs: number;
};

export const FCM_PUSH_DEFAULTS = {
  apiBaseUrl: 'https://fcm.googleapis.com',
  tokenUri: 'https://oauth2.googleapis.com/token',
  scope: 'https://www.googleapis.com/auth/firebase.messaging',
  timeoutMs: 20_000,
  /** Refresh the OAuth2 access token this long before it actually expires. */
  tokenSkewMs: 60_000,
} as const;

/**
 * Normalizes a PEM private key supplied through a single environment
 * variable: escaped `\n` sequences (and CRLF) become real newlines. This is
 * the ONLY place that transformation happens — the value never travels
 * anywhere else in escaped or unescaped form.
 *
 * Throws `ConfigError` (naming the FIELD only, never the value) when the
 * result is not a PEM block.
 */
export function normalizeFcmPrivateKey(raw: string): string {
  const normalized = raw
    .trim()
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\r\n/g, '\n');
  if (
    !normalized.startsWith('-----BEGIN') ||
    !/-----END [A-Z ]*PRIVATE KEY-----$/.test(normalized)
  ) {
    throw new ConfigError(
      'Invalid configuration: PUSH_FCM_PRIVATE_KEY must be a PEM-encoded private key (BEGIN/END PRIVATE KEY block).',
    );
  }
  return `${normalized}\n`;
}

/**
 * Reads the FCM configuration from the process environment. Called ONLY at
 * adapter construction — never by `env.ts`/`AppConfig`.
 *
 * Required: `PUSH_FCM_PROJECT_ID`, `PUSH_FCM_CLIENT_EMAIL`,
 *           `PUSH_FCM_PRIVATE_KEY`.
 * Optional: `PUSH_FCM_API_BASE_URL` (https://fcm.googleapis.com),
 *           `PUSH_FCM_TOKEN_URI` (https://oauth2.googleapis.com/token).
 *
 * ConfigError messages mention field NAMES only — never a credential value.
 */
export function readFcmPushConfig(env: NodeJS.ProcessEnv = process.env): FcmPushConfig {
  const projectId = env.PUSH_FCM_PROJECT_ID?.trim();
  if (!projectId) {
    throw new ConfigError(
      'Invalid configuration: PUSH_FCM_PROJECT_ID is required when PUSH_PROVIDER=fcm.',
    );
  }
  const clientEmail = env.PUSH_FCM_CLIENT_EMAIL?.trim();
  if (!clientEmail) {
    throw new ConfigError(
      'Invalid configuration: PUSH_FCM_CLIENT_EMAIL is required when PUSH_PROVIDER=fcm.',
    );
  }
  const rawKey = env.PUSH_FCM_PRIVATE_KEY;
  if (rawKey === undefined || rawKey.trim() === '') {
    throw new ConfigError(
      'Invalid configuration: PUSH_FCM_PRIVATE_KEY is required when PUSH_PROVIDER=fcm.',
    );
  }

  const apiBaseUrl = (
    env.PUSH_FCM_API_BASE_URL?.trim() || FCM_PUSH_DEFAULTS.apiBaseUrl
  ).replace(/\/+$/, '');
  const tokenUri = env.PUSH_FCM_TOKEN_URI?.trim() || FCM_PUSH_DEFAULTS.tokenUri;

  return {
    projectId,
    clientEmail,
    privateKey: normalizeFcmPrivateKey(rawKey),
    apiBaseUrl,
    tokenUri,
    timeoutMs: FCM_PUSH_DEFAULTS.timeoutMs,
  };
}

// ---------------------------------------------------------------------------
// HTTP transport seam (injectable for mocked tests — no external network)
// ---------------------------------------------------------------------------

export type FcmHttpRequest = {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
};

export type FcmHttpResponse = {
  status: number;
  body: string;
};

export type FcmHttpTransport = (request: FcmHttpRequest) => Promise<FcmHttpResponse>;

/** Production transport: built-in fetch with a bounded timeout. */
export function createFetchFcmTransport(): FcmHttpTransport {
  return async (request: FcmHttpRequest): Promise<FcmHttpResponse> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
      });
      return { status: response.status, body: await response.text() };
    } finally {
      clearTimeout(timer);
    }
  };
}

// ---------------------------------------------------------------------------
// Service-account OAuth2 (JWT bearer) — node:crypto only, no SDK
// ---------------------------------------------------------------------------

function base64Url(value: Buffer | string): string {
  return (typeof value === 'string' ? Buffer.from(value, 'utf8') : value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Builds the signed RS256 service-account assertion for the JWT-bearer grant.
 * The private key is used here and nowhere else; the assertion itself is a
 * credential and is never logged.
 */
export function buildFcmAssertion(
  config: FcmPushConfig,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64Url(
    JSON.stringify({
      iss: config.clientEmail,
      scope: FCM_PUSH_DEFAULTS.scope,
      aud: config.tokenUri,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${base64Url(signer.sign(config.privateKey))}`;
}

/** An OAuth2 access token plus its absolute expiry (epoch ms). */
export type FcmAccessToken = {
  accessToken: string;
  expiresAtMs: number;
};

/** Seam that yields a bearer token; injectable so tests never sign or fetch. */
export type FcmAccessTokenProvider = () => Promise<string>;

// ---------------------------------------------------------------------------
// Error sanitization and classification
// ---------------------------------------------------------------------------

const MAX_ERROR_LENGTH = 500;
const SECRET_PATTERN =
  /(password|passwd|pwd|secret|private[_-]?key|api[_-]?key|token|authorization|bearer|assertion|client[_-]?email)\s*[:=]\s*[^\s,;"']+/gi;
const PEM_PATTERN = /-----BEGIN[\s\S]*?-----END[A-Z ]*-----/g;
/** `Bearer <credential>` / `Basic <credential>` headers echoed back to us. */
const BEARER_PATTERN = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
/** Google OAuth2 access tokens have a stable, recognisable prefix. */
const OAUTH_TOKEN_PATTERN = /\bya29\.[A-Za-z0-9._~+/=-]+/g;
/**
 * CR-BE-PUSH-01 PART 04C §16 — device REGISTRATION tokens echoed back inside
 * provider error prose. These are not credentials, so the patterns above never
 * matched them: FCM commonly replies "Requested entity was not found for token
 * <token>", and that text is persisted verbatim as attempt evidence. The token
 * is the device address, so it is redacted here (the single sanitizer every
 * caller already shares) rather than in a second, divergent redaction path.
 *
 * Only unmistakable device-token shapes are matched, so ordinary provider
 * diagnostics keep their meaning:
 *   - FCM registration tokens: `<instance-id>:APA91b<payload>`
 *   - APNs device tokens: 64 hexadecimal characters
 */
const FCM_DEVICE_TOKEN_PATTERN = /\b[A-Za-z0-9_-]{8,}:APA91b[A-Za-z0-9_-]{20,}/g;
const APNS_DEVICE_TOKEN_PATTERN = /\b[0-9a-f]{64}\b/gi;

/**
 * Redacts credential-like fragments (and any PEM block) before error text
 * leaves this module, then bounds the length.
 */
export function sanitizeFcmError(message: string): string {
  const redacted = message
    .replace(PEM_PATTERN, '[REDACTED_PRIVATE_KEY]')
    .replace(BEARER_PATTERN, '$1 [REDACTED]')
    .replace(OAUTH_TOKEN_PATTERN, '[REDACTED]')
    .replace(SECRET_PATTERN, '$1=[REDACTED]')
    .replace(FCM_DEVICE_TOKEN_PATTERN, '[REDACTED_DEVICE_TOKEN]')
    .replace(APNS_DEVICE_TOKEN_PATTERN, '[REDACTED_DEVICE_TOKEN]');
  return redacted.length > MAX_ERROR_LENGTH
    ? `${redacted.slice(0, MAX_ERROR_LENGTH)}…`
    : redacted;
}

/**
 * The FCM HTTP v1 error envelope, already parsed out of the response body.
 *
 * `errorCode` is the `google.firebase.fcm.v1.FcmError` detail value
 * (`UNREGISTERED`, `INVALID_ARGUMENT`, `SENDER_ID_MISMATCH`, `QUOTA_EXCEEDED`,
 * `UNAVAILABLE`, `INTERNAL`, `THIRD_PARTY_AUTH_ERROR`, …) or, failing that,
 * the canonical `error.status`.
 */
export type FcmFailureInput = {
  /** HTTP status, when a response was received. */
  status?: number;
  /** FCM error code / canonical status, when the body carried one. */
  errorCode?: string | null;
  /** `google.rpc.BadRequest` field paths, when present. */
  fieldViolations?: string[];
  /** Raw error text (sanitized before returning). */
  message: string;
  /** Network-level failure (no HTTP response at all). */
  network?: boolean;
};

export type FcmClassification = {
  code: PushErrorCode;
  retryable: boolean;
  /** TRUE only when FCM PROVED the registration token is dead (§8). */
  tokenInvalid: boolean;
  message: string;
};

/**
 * FCM error codes that prove the registration token is permanently dead.
 * The HTTP v1 spelling is `UNREGISTERED`; `NOT_FOUND` is its canonical
 * status, and the Firebase-Admin client vocabulary spells the same condition
 * `registration-token-not-registered`. All three are accepted so a caller's
 * choice of vocabulary cannot silently break invalidation.
 */
const TOKEN_DEAD_CODES = new Set([
  'UNREGISTERED',
  'NOT_FOUND',
  'REGISTRATION_TOKEN_NOT_REGISTERED',
  'REGISTRATION-TOKEN-NOT-REGISTERED',
]);

/**
 * Codes that mean the registration token itself was malformed/unusable.
 * `INVALID_ARGUMENT` is deliberately NOT in this set: it covers oversized
 * payloads, reserved data keys and bad TTLs just as often as bad tokens, and
 * governance §8 only permits invalidation for an `INVALID_ARGUMENT` raised
 * ON THE TOKEN FIELD (detected through the BadRequest field violations).
 */
const TOKEN_MALFORMED_CODES = new Set([
  'INVALID_REGISTRATION_TOKEN',
  'INVALID-REGISTRATION-TOKEN',
  'INVALID_ARGUMENT_TOKEN',
]);

const AUTH_CODES = new Set([
  'THIRD_PARTY_AUTH_ERROR',
  'SENDER_ID_MISMATCH',
  'PERMISSION_DENIED',
  'UNAUTHENTICATED',
  'MISMATCHED_CREDENTIAL',
  'APNS_AUTH_ERROR',
]);

const TRANSIENT_CODES = new Set([
  'UNAVAILABLE',
  'INTERNAL',
  'DEADLINE_EXCEEDED',
  'ABORTED',
  'SERVER_UNAVAILABLE',
  'INTERNAL_ERROR',
]);

const RATE_LIMIT_CODES = new Set([
  'QUOTA_EXCEEDED',
  'RESOURCE_EXHAUSTED',
  'MESSAGE_RATE_EXCEEDED',
]);

/** Whether a BadRequest field violation points at the registration token. */
function violatesTokenField(fieldViolations: string[] | undefined): boolean {
  return (fieldViolations ?? []).some((field) =>
    /(^|\.)(token|registration_token|registrationToken)$/i.test(field.trim()),
  );
}

/**
 * Maps a real FCM outcome onto the normalized taxonomy (governance §8/§13.2).
 *
 *   UNREGISTERED (404)                 → INVALID_TOKEN, permanent, token dead
 *   INVALID_ARGUMENT (400) on token    → INVALID_TOKEN, permanent, token dead
 *   INVALID_ARGUMENT (400) otherwise   → INVALID_REQUEST, permanent, token OK
 *   SENDER_ID_MISMATCH (403),
 *   THIRD_PARTY_AUTH_ERROR (401),
 *   PERMISSION_DENIED/UNAUTHENTICATED  → AUTHENTICATION_FAILED, permanent
 *                                        (a CONFIGURATION fault — the device
 *                                        token is not blamed or invalidated)
 *   QUOTA_EXCEEDED (429)               → RATE_LIMITED, retryable
 *   UNAVAILABLE (503) / INTERNAL (500) → PROVIDER_UNAVAILABLE, retryable
 *   network / timeout                  → NETWORK_ERROR, retryable
 *   anything unclassified              → UNKNOWN_ERROR, retryable
 *                                        (conservative; bounded by the PART 04
 *                                        attempt budget — never a silent loss)
 *
 * Only the two token-dead paths ever set `tokenInvalid`.
 */
export function classifyFcmError(failure: FcmFailureInput): FcmClassification {
  const message = sanitizeFcmError(failure.message);
  const code = (failure.errorCode ?? '').trim().toUpperCase();

  if (failure.network) {
    return { code: 'NETWORK_ERROR', retryable: true, tokenInvalid: false, message };
  }

  if (TOKEN_DEAD_CODES.has(code) || TOKEN_MALFORMED_CODES.has(code)) {
    return { code: 'INVALID_TOKEN', retryable: false, tokenInvalid: true, message };
  }

  if (code === 'INVALID_ARGUMENT') {
    if (violatesTokenField(failure.fieldViolations)) {
      return { code: 'INVALID_TOKEN', retryable: false, tokenInvalid: true, message };
    }
    return { code: 'INVALID_REQUEST', retryable: false, tokenInvalid: false, message };
  }

  if (AUTH_CODES.has(code)) {
    return {
      code: 'AUTHENTICATION_FAILED',
      retryable: false,
      tokenInvalid: false,
      message,
    };
  }

  if (RATE_LIMIT_CODES.has(code)) {
    return { code: 'RATE_LIMITED', retryable: true, tokenInvalid: false, message };
  }

  if (TRANSIENT_CODES.has(code)) {
    return {
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
      tokenInvalid: false,
      message,
    };
  }

  // No usable code — fall back to the HTTP status.
  const status = failure.status;
  if (status !== undefined) {
    if (status === 404) {
      return { code: 'INVALID_TOKEN', retryable: false, tokenInvalid: true, message };
    }
    if (status === 429) {
      return { code: 'RATE_LIMITED', retryable: true, tokenInvalid: false, message };
    }
    if (status >= 500) {
      return {
        code: 'PROVIDER_UNAVAILABLE',
        retryable: true,
        tokenInvalid: false,
        message,
      };
    }
    if (status === 401 || status === 403) {
      return {
        code: 'AUTHENTICATION_FAILED',
        retryable: false,
        tokenInvalid: false,
        message,
      };
    }
    if (status === 400) {
      return {
        code: 'INVALID_REQUEST',
        retryable: false,
        tokenInvalid: false,
        message,
      };
    }
  }

  return { code: 'UNKNOWN_ERROR', retryable: true, tokenInvalid: false, message };
}

/** Extracts the FCM error envelope from a non-2xx response body. */
export function parseFcmErrorBody(body: string): {
  errorCode: string | null;
  fieldViolations: string[];
  message: string | null;
} {
  try {
    const parsed = JSON.parse(body) as {
      error?: {
        message?: unknown;
        status?: unknown;
        details?: Array<Record<string, unknown>>;
      };
    };
    const error = parsed.error;
    if (!error) {
      return { errorCode: null, fieldViolations: [], message: null };
    }
    let errorCode: string | null =
      typeof error.status === 'string' && error.status.length > 0 ? error.status : null;
    const fieldViolations: string[] = [];
    for (const detail of error.details ?? []) {
      const type = String(detail['@type'] ?? '');
      if (type.includes('FcmError') && typeof detail.errorCode === 'string') {
        errorCode = detail.errorCode;
      }
      if (type.includes('BadRequest') && Array.isArray(detail.fieldViolations)) {
        for (const violation of detail.fieldViolations as Array<Record<string, unknown>>) {
          if (typeof violation.field === 'string') {
            fieldViolations.push(violation.field);
          }
        }
      }
    }
    return {
      errorCode,
      fieldViolations,
      message: typeof error.message === 'string' ? error.message : null,
    };
  } catch {
    return { errorCode: null, fieldViolations: [], message: null };
  }
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export type FcmPushAdapterOptions = {
  /** Boundary config; defaults to `readFcmPushConfig(process.env)`. */
  config?: FcmPushConfig;
  /** HTTP transport; defaults to the bounded-fetch transport. */
  transport?: FcmHttpTransport;
  /**
   * Access-token seam; defaults to the service-account JWT-bearer exchange
   * performed through `transport`. Injectable so tests never sign a real key
   * and never contact Google.
   */
  accessTokenProvider?: FcmAccessTokenProvider;
};

/**
 * Real Firebase Cloud Messaging HTTP v1 adapter (discriminator `fcm`).
 *
 * Construction validates configuration (fail-closed); no HTTP request happens
 * until `send`.
 */
export class FcmPushAdapter implements PushAdapter {
  readonly provider = 'fcm';

  private readonly config: FcmPushConfig;
  private readonly transport: FcmHttpTransport;
  private readonly accessTokenProvider: FcmAccessTokenProvider;
  private cachedToken: FcmAccessToken | null = null;

  constructor(options: FcmPushAdapterOptions = {}) {
    this.config = options.config ?? readFcmPushConfig();
    this.transport = options.transport ?? createFetchFcmTransport();
    this.accessTokenProvider =
      options.accessTokenProvider ?? (() => this.fetchAccessToken());
  }

  /** Service-account JWT-bearer exchange with a small in-memory token cache. */
  private async fetchAccessToken(): Promise<string> {
    const now = Date.now();
    if (
      this.cachedToken !== null &&
      this.cachedToken.expiresAtMs - FCM_PUSH_DEFAULTS.tokenSkewMs > now
    ) {
      return this.cachedToken.accessToken;
    }

    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: buildFcmAssertion(this.config),
    }).toString();

    const response = await this.transport({
      url: this.config.tokenUri,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      timeoutMs: this.config.timeoutMs,
    });

    if (response.status < 200 || response.status >= 300) {
      // The OAuth error body can echo request fields — sanitize, and never
      // include the assertion or the key.
      throw new Error(
        sanitizeFcmError(
          `FCM service-account token exchange failed with HTTP ${response.status}.`,
        ),
      );
    }

    let accessToken: string | null = null;
    let expiresInSeconds = 3600;
    try {
      const parsed = JSON.parse(response.body) as {
        access_token?: unknown;
        expires_in?: unknown;
      };
      if (typeof parsed.access_token === 'string' && parsed.access_token.length > 0) {
        accessToken = parsed.access_token;
      }
      if (typeof parsed.expires_in === 'number' && parsed.expires_in > 0) {
        expiresInSeconds = parsed.expires_in;
      }
    } catch {
      accessToken = null;
    }

    if (accessToken === null) {
      throw new Error('FCM service-account token exchange returned no access token.');
    }

    this.cachedToken = {
      accessToken,
      expiresAtMs: Date.now() + expiresInSeconds * 1000,
    };
    return accessToken;
  }

  /**
   * Builds the HTTP v1 message. The payload is a POINTER (§9): `notification`
   * carries the already-rendered title/body and `data` carries routing keys
   * only. Platform-specific blocks set delivery hints, not content — the iOS
   * block is the FCM→APNs relay configuration, NOT a direct APNs call.
   */
  private buildMessage(input: PushSendInput): Record<string, unknown> {
    const data = input.data ?? {};
    const message: Record<string, unknown> = {
      token: input.token,
      notification: {
        title: input.title,
        ...(input.body === null || input.body === undefined ? {} : { body: input.body }),
      },
      ...(Object.keys(data).length > 0 ? { data } : {}),
    };
    if (input.platform === 'ANDROID') {
      message.android = { priority: 'high' };
    } else {
      message.apns = {
        headers: { 'apns-priority': '10' },
        payload: { aps: { sound: 'default' } },
      };
    }
    return message;
  }

  async send(input: PushSendInput): Promise<PushSendResult> {
    const violations = validatePushPayload(input);
    if (violations.length > 0) {
      return {
        status: 'FAILED',
        provider: this.provider,
        error: `Push payload rejected: ${violations.join('; ')}.`,
        errorCode: 'PAYLOAD_INVALID',
        retryable: false,
        tokenInvalid: false,
        deliveryId: input.deliveryId ?? null,
        sentAt: new Date(),
      };
    }

    const sentAt = new Date();
    const deliveryId = input.deliveryId ?? null;

    let accessToken: string;
    try {
      accessToken = await this.accessTokenProvider();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const classification = classifyFcmError({
        message: `FCM authentication failed: ${reason}`,
        network: true,
      });
      return {
        status: 'FAILED',
        provider: this.provider,
        error: classification.message,
        errorCode: classification.code,
        retryable: classification.retryable,
        tokenInvalid: false,
        deliveryId,
        sentAt,
      };
    }

    let response: FcmHttpResponse;
    try {
      response = await this.transport({
        url: `${this.config.apiBaseUrl}/v1/projects/${this.config.projectId}/messages:send`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ message: this.buildMessage(input) }),
        timeoutMs: this.config.timeoutMs,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const classification = classifyFcmError({
        message: `FCM send request failed: ${reason}`,
        network: true,
      });
      return {
        status: 'FAILED',
        provider: this.provider,
        error: classification.message,
        errorCode: classification.code,
        retryable: classification.retryable,
        tokenInvalid: classification.tokenInvalid,
        deliveryId,
        sentAt,
      };
    }

    if (response.status >= 200 && response.status < 300) {
      let providerMessageId: string | null = null;
      try {
        const parsed = JSON.parse(response.body) as { name?: unknown };
        if (typeof parsed.name === 'string' && parsed.name.length > 0) {
          providerMessageId = parsed.name;
        }
      } catch {
        // A 2xx with an unparsable body is still an acceptance.
      }
      return {
        status: 'SENT',
        provider: this.provider,
        providerMessageId,
        retryable: false,
        tokenInvalid: false,
        deliveryId,
        sentAt,
      };
    }

    const envelope = parseFcmErrorBody(response.body);
    const classification = classifyFcmError({
      status: response.status,
      errorCode: envelope.errorCode,
      fieldViolations: envelope.fieldViolations,
      message:
        envelope.message ??
        `FCM returned HTTP ${response.status} for device ${pushTokenFingerprint(input.token)}.`,
    });

    return {
      status: 'FAILED',
      provider: this.provider,
      error: classification.message,
      errorCode: classification.code,
      retryable: classification.retryable,
      // Reported ONLY — PART 04 owns the mobile_push_tokens transition.
      tokenInvalid: classification.tokenInvalid,
      deliveryId,
      sentAt,
    };
  }
}
