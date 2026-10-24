import {
  createCipheriv,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from 'node:crypto';
import { ConfigError } from '../../config';
import type { PushErrorCode, PushSendResult } from './push-adapter';

/**
 * CR-HM-MULTICLIENT-NOTIFICATION-01 PART 02 — browser push (Web Push / VAPID)
 * adapter.
 *
 * GOVERNANCE: docs/handyman/CR-HM-MULTICLIENT-NOTIFICATION-01_PART02_MULTI_CLIENT_PUSH_TRANSPORT.md
 * §2 (S-2, S-3) and the explicit supersession of
 * `docs/CR-BE-PUSH-01_START_GOVERNANCE.md` §16.3 (amendment §16.3-A,
 * 2026-10-24).
 *
 * WHAT THIS IS
 * ------------
 * The browser transport for the ONE notification engine. A browser (PWA)
 * cannot use a native provider token: it registers a SUBSCRIPTION (an
 * endpoint URL plus a subscriber key pair) and the push service — not the
 * backend — holds the private counterpart. The backend therefore
 *   - signs every request with its OWN application key pair (VAPID,
 *     RFC 8292), proving to the push service that the request comes from
 *     this application, and
 *   - encrypts the payload to the SUBSCRIBER's key (RFC 8188 `aes128gcm`
 *     content encoding, RFC 8291 key derivation), so the push service never
 *     sees the notification content.
 *
 * DEPENDENCY DECISION (mirrors the native adapter, §5.3)
 * ----------------------------------------------------
 * ZERO new dependencies. `package.json` still contains no push vendor
 * package: the signing is an ES256 JWT (`node:crypto` `sign` with the
 * `ieee-p1363` signature encoding) and the content encryption is RFC 8291's
 * HKDF-SHA256 + AES-128-GCM, both available in `node:crypto`. The boundary
 * guard that bans push vendor dependencies therefore stays green.
 *
 * SECRETS BOUNDARY (§12.2, S-2)
 * -----------------------------
 * Every credential — the application private key, the subscriber's auth
 * secret — is read or used INSIDE this module. Nothing reaches `AppConfig`
 * (`env.ts` reads only a provider discriminator), nothing is logged, nothing
 * is written to a business table, and no credential fragment is embedded in
 * an error message. The subscriber's public key and the endpoint are
 * credential-grade too: the endpoint is a capability URL, so it is never
 * logged or echoed.
 *
 * SIDE-EFFECT BOUNDARY (§8, §15)
 * ------------------------------
 * NO database access. When the push service proves a subscription is gone
 * (404/410) the adapter sets `tokenInvalid: true` on the normalized result
 * and stops there — the `browser_push_subscriptions` transition to INVALID
 * belongs to the notification module, not to the transport. No retry
 * scheduling, no attempt counters, no ledger writes, no backoff.
 */

/** The provider discriminator of this transport. */
export const BROWSER_PUSH_PROVIDER = 'webpush';

// ---------------------------------------------------------------------------
// Endpoint allow-list (the set of legitimate push-service origins)
// ---------------------------------------------------------------------------

/**
 * The push service origins a browser subscription may point at.
 *
 * The endpoint is a CAPABILITY URL: whoever holds it can receive a message.
 * Accepting an arbitrary URL would turn the backend into a relay that POSTs
 * to any host the caller names (server-side request forgery). The list is
 * therefore an allow-list of the known browser push services, overridable
 * through `PUSH_BROWSER_ALLOWED_ENDPOINT_HOSTS` for a private/self-hosted
 * push service.
 *
 * The list lives HERE, in the transport module, because the set of
 * legitimate push-service origins is transport knowledge: the module that
 * contacts them owns the list. The registration module asks this module
 * whether an endpoint is acceptable, and never learns a provider name.
 */
export const BROWSER_PUSH_DEFAULT_ENDPOINT_HOSTS = [
  'fcm.googleapis.com',
  'push.services.mozilla.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
  'notify.windows.com',
] as const;

/**
 * The allowed endpoint hosts, read from the environment with the default
 * list as the fallback. Read at CALL time (not at module load) so a test can
 * point the allow-list at a local stub.
 */
export function allowedBrowserPushEndpointHosts(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const raw = env.PUSH_BROWSER_ALLOWED_ENDPOINT_HOSTS?.trim();
  if (!raw) {
    return [...BROWSER_PUSH_DEFAULT_ENDPOINT_HOSTS];
  }
  const hosts = raw
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host.length > 0);
  return hosts.length > 0 ? hosts : [...BROWSER_PUSH_DEFAULT_ENDPOINT_HOSTS];
}

/**
 * Whether an endpoint URL is an acceptable push service endpoint: HTTPS, a
 * known push service host, and no embedded credentials.
 */
export function isAllowedBrowserPushEndpoint(
  endpoint: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') {
    return false;
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return allowedBrowserPushEndpointHosts(env).some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`),
  );
}

// ---------------------------------------------------------------------------
// Configuration (read at the adapter boundary only)
// ---------------------------------------------------------------------------

export type BrowserPushConfig = {
  /** The application key pair: the private key signs, the public key is published. */
  privateKey: KeyObject;
  /** The application public key, base64url (the uncompressed P-256 point). */
  publicKeyBase64Url: string;
  /** The contact the push service may use to reach the application owner. */
  subject: string;
  /** How long a delivered message may be kept by the push service. */
  ttlSeconds: number;
  timeoutMs: number;
};

export const BROWSER_PUSH_DEFAULTS = {
  ttlSeconds: 24 * 60 * 60,
  timeoutMs: 20_000,
  /**
   * The "user agent" used for the RFC 8291 key separation. It MUST be the
   * same value in the key derivation and in the `User-Agent` header, because
   * the browser derives the content key from the header it received.
   */
  userAgent: 'Mozilla/5.0',
} as const;

/**
 * Normalizes a PEM private key supplied through a single environment
 * variable: escaped `\n` sequences (and CRLF) become real newlines. This is
 * the ONLY place that transformation happens.
 */
export function normalizeBrowserPushPrivateKey(raw: string): string {
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
      'Invalid configuration: PUSH_BROWSER_VAPID_PRIVATE_KEY must be a PEM-encoded EC private key (BEGIN/END PRIVATE KEY block).',
    );
  }
  return `${normalized}\n`;
}

/**
 * Extracts the uncompressed P-256 public point (65 bytes) from a key pair.
 * The SPKI DER of a P-256 public key is a fixed 26-byte header followed by
 * the point, so the point is the tail of the encoding.
 */
export function extractUncompressedPublicPoint(publicKey: KeyObject): Buffer {
  const der = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const point = der.subarray(der.length - 65);
  if (point.length !== 65 || point[0] !== 0x04) {
    throw new ConfigError(
      'Invalid configuration: the application key pair is not an uncompressed P-256 key.',
    );
  }
  return Buffer.from(point);
}

/** Imports a PEM EC private key. */
function createPrivateKeyFromPem(pem: string): KeyObject {
  return createPrivateKey(pem);
}

/** Derives the public key of a private key. */
function createPublicKeyFromPrivate(privateKey: KeyObject): KeyObject {
  return createPublicKey(privateKey);
}

/** base64url without padding. */
export function base64Url(value: Buffer | string): string {
  return (typeof value === 'string' ? Buffer.from(value, 'utf8') : value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Decodes a base64url value; returns null when it is not valid base64url. */
function decodeBase64Url(value: string): Buffer | null {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    '=',
  );
  try {
    const decoded = Buffer.from(padded, 'base64');
    return decoded.toString('base64').replace(/=+$/, '') ===
      normalized.replace(/=+$/, '')
      ? decoded
      : null;
  } catch {
    return null;
  }
}

/**
 * Imports a subscriber's uncompressed P-256 public point (65 bytes) as a
 * KeyObject, so the ephemeral ECDH exchange can use it.
 */
export function importUncompressedPublicPoint(point: Buffer): KeyObject {
  if (point.length !== 65 || point[0] !== 0x04) {
    throw new Error('invalid P-256 public point');
  }
  // SPKI prefix of an id-ecPublicKey / prime256v1 SubjectPublicKeyInfo.
  const spkiPrefix = Buffer.from(
    '3059301306072a8648ce3d020106082a8648ce3d030107034200',
    'hex',
  );
  return createPublicKey({
    key: Buffer.concat([spkiPrefix, point]),
    format: 'der',
    type: 'spki',
  });
}

/**
 * Reads the browser push configuration from the process environment. Called
 * ONLY at adapter construction — never by `env.ts`/`AppConfig`.
 *
 * Required: `PUSH_BROWSER_VAPID_PRIVATE_KEY` (PEM EC private key) and
 *           `PUSH_BROWSER_VAPID_SUBJECT` (a `mailto:` contact).
 * Optional: `PUSH_BROWSER_VAPID_PUBLIC_KEY` (base64url — derived from the
 *           private key when absent), `PUSH_BROWSER_TTL_SECONDS`.
 *
 * ConfigError messages mention field NAMES only — never a credential value.
 */
export function readBrowserPushConfig(
  env: NodeJS.ProcessEnv = process.env,
): BrowserPushConfig {
  const rawKey = env.PUSH_BROWSER_VAPID_PRIVATE_KEY;
  if (rawKey === undefined || rawKey.trim() === '') {
    throw new ConfigError(
      'Invalid configuration: PUSH_BROWSER_VAPID_PRIVATE_KEY is required when PUSH_BROWSER_PROVIDER=webpush.',
    );
  }
  const subject = env.PUSH_BROWSER_VAPID_SUBJECT?.trim();
  if (!subject || !/^(mailto:|https:)/i.test(subject)) {
    throw new ConfigError(
      'Invalid configuration: PUSH_BROWSER_VAPID_SUBJECT must be a mailto: or https: contact.',
    );
  }

  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKeyFromPem(normalizeBrowserPushPrivateKey(rawKey));
  } catch {
    throw new ConfigError(
      'Invalid configuration: PUSH_BROWSER_VAPID_PRIVATE_KEY must be a PEM-encoded EC private key.',
    );
  }

  const derivedPublicKey = extractUncompressedPublicPoint(
    createPublicKeyFromPrivate(privateKey),
  );
  const configuredPublicKey = env.PUSH_BROWSER_VAPID_PUBLIC_KEY?.trim();
  let publicKeyBase64Url: string;
  if (configuredPublicKey) {
    const decoded = decodeBase64Url(configuredPublicKey);
    if (!decoded || decoded.length !== 65 || decoded[0] !== 0x04) {
      throw new ConfigError(
        'Invalid configuration: PUSH_BROWSER_VAPID_PUBLIC_KEY must be the base64url encoded uncompressed P-256 public key.',
      );
    }
    publicKeyBase64Url = configuredPublicKey;
  } else {
    publicKeyBase64Url = base64Url(derivedPublicKey);
  }

  const ttlRaw = Number(env.PUSH_BROWSER_TTL_SECONDS ?? '');
  const ttlSeconds =
    Number.isFinite(ttlRaw) && ttlRaw > 0 && ttlRaw <= 30 * 24 * 60 * 60
      ? Math.trunc(ttlRaw)
      : BROWSER_PUSH_DEFAULTS.ttlSeconds;

  return {
    privateKey,
    publicKeyBase64Url,
    subject,
    ttlSeconds,
    timeoutMs: BROWSER_PUSH_DEFAULTS.timeoutMs,
  };
}

// ---------------------------------------------------------------------------
// VAPID (RFC 8292)
// ---------------------------------------------------------------------------

/**
 * Builds the VAPID authorization token: an ES256 JWT whose audience is the
 * ORIGIN of the push endpoint, whose subject is the application contact and
 * whose lifetime is at most 24 hours.
 *
 * The signature is the raw `r || s` form ES256 requires, which `node:crypto`
 * produces with the `ieee-p1363` encoding.
 */
export function buildVapidToken(
  config: BrowserPushConfig,
  audience: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const header = base64Url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = base64Url(
    JSON.stringify({
      aud: audience,
      exp: nowSeconds + 12 * 60 * 60,
      sub: config.subject,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = sign('sha256', Buffer.from(signingInput, 'utf8'), {
    key: config.privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${base64Url(signature)}`;
}

/**
 * The `Authorization` header value of a VAPID-authenticated request.
 */
export function buildVapidAuthorizationHeader(
  config: BrowserPushConfig,
  audience: string,
  nowSeconds?: number,
): string {
  return `vapid t=${buildVapidToken(config, audience, nowSeconds)}, k=${config.publicKeyBase64Url}`;
}

// ---------------------------------------------------------------------------
// Content encryption (RFC 8188 aes128gcm + RFC 8291 key derivation)
// ---------------------------------------------------------------------------

/** The plaintext record size advertised in the encrypted record header. */
export const WEB_PUSH_RECORD_SIZE = 4096;

/** HKDF-Extract (RFC 5869) with SHA-256. */
function hkdfExtract(salt: Buffer, ikm: Buffer): Buffer {
  return createHmac('sha256', salt).update(ikm).digest();
}

/** HKDF-Expand (RFC 5869) with SHA-256. */
export function hkdfExpand(prk: Buffer, info: Buffer, length: number): Buffer {
  const blocks: Buffer[] = [];
  let previous = Buffer.alloc(0);
  let counter = 1;
  let produced = 0;
  while (produced < length) {
    const block = createHmac('sha256', prk)
      .update(previous)
      .update(info)
      .update(Buffer.from([counter]))
      .digest();
    blocks.push(block);
    produced += block.length;
    previous = block;
    counter += 1;
  }
  return Buffer.concat(blocks).subarray(0, length);
}

/** The RFC 8291 key-info prefix. */
const WEB_PUSH_INFO_PREFIX = Buffer.from('WebPush: info\0', 'utf8');
/** The RFC 8188 content-encoding label used for the content key. */
const WEB_PUSH_CEK_INFO = Buffer.from('Content-Encoding: aes128gcm\0', 'utf8');
/** The RFC 8188 content-encoding label used for the nonce. */
const WEB_PUSH_NONCE_INFO = Buffer.from('Content-Encoding: nonce\0', 'utf8');

/**
 * The deterministic overrides of the content encryption.
 *
 * The salt and the ephemeral key pair are RANDOM per message by design
 * (RFC 8188 / RFC 8291). They can be pinned only to reproduce a known-answer
 * vector — an interoperability test against an independent implementation of
 * the same standards. The transport never passes them.
 */
export type BrowserPushEncryptionOverrides = {
  salt?: Buffer;
  ephemeralKeyPair?: { privateKey: KeyObject; publicPoint: Buffer };
};

/**
 * Encrypts a payload to a subscriber's key pair (RFC 8291 / RFC 8188).
 *
 * The wire format is the one every deployed Web Push service accepts:
 *
 *   record := salt(16) || record size(4) || id length(1) || id(65)
 *             || AES-128-GCM ciphertext || tag(16)
 *
 * The key id is the EPHEMERAL public key of the per-message ECDH exchange
 * (never the long-lived application key), the key material is derived with
 * HKDF-SHA256 over the ECDH secret and the subscriber's authentication
 * secret, and the plaintext carries the RFC 8188 delimiter byte.
 */
export function encryptBrowserPushPayload(
  plaintext: Buffer,
  subscriberPublicPoint: Buffer,
  subscriberAuthSecret: Buffer,
  overrides: BrowserPushEncryptionOverrides = {},
): Buffer {
  const salt = overrides.salt ?? randomBytes(16);

  const ephemeral = overrides.ephemeralKeyPair
    ? { privateKey: overrides.ephemeralKeyPair.privateKey }
    : generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ephemeralPublicPoint = overrides.ephemeralKeyPair
    ? overrides.ephemeralKeyPair.publicPoint
    : extractUncompressedPublicPoint(createPublicKey(ephemeral.privateKey));
  const receiverKey = importUncompressedPublicPoint(subscriberPublicPoint);
  const sharedSecret = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: receiverKey,
  });

  // RFC 8291 §3.3 — the "WebPush: info" key derivation.
  const authPrk = hkdfExtract(subscriberAuthSecret, sharedSecret);
  const secret = hkdfExpand(
    authPrk,
    Buffer.concat([
      WEB_PUSH_INFO_PREFIX,
      subscriberPublicPoint,
      ephemeralPublicPoint,
    ]),
    32,
  );

  // RFC 8188 §2.1 — the content key and the nonce are derived from the salt.
  const contentPrk = hkdfExtract(salt, secret);
  const contentKey = hkdfExpand(contentPrk, WEB_PUSH_CEK_INFO, 16);
  const nonce = hkdfExpand(contentPrk, WEB_PUSH_NONCE_INFO, 12);

  const cipher = createCipheriv('aes-128-gcm', contentKey, nonce);
  // The RFC 8188 delimiter byte marks the last record of the body.
  const body = Buffer.concat([plaintext, Buffer.from([0x02])]);
  const ciphertext = Buffer.concat([cipher.update(body), cipher.final()]);
  const tag = cipher.getAuthTag();

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(WEB_PUSH_RECORD_SIZE, 0);

  return Buffer.concat([
    salt,
    recordSize,
    Buffer.from([ephemeralPublicPoint.length]),
    ephemeralPublicPoint,
    ciphertext,
    tag,
  ]);
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export type BrowserPushHttpRequest = {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: Buffer;
  timeoutMs: number;
};

export type BrowserPushHttpResponse = {
  status: number;
  body: string;
};

/** The injectable transport seam (mocked in tests — no external network). */
export type BrowserPushHttpTransport = (
  request: BrowserPushHttpRequest,
) => Promise<BrowserPushHttpResponse>;

/** Production transport: built-in fetch with a bounded timeout. */
export function createFetchBrowserPushTransport(): BrowserPushHttpTransport {
  return async (request: BrowserPushHttpRequest): Promise<BrowserPushHttpResponse> => {
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
// The adapter
// ---------------------------------------------------------------------------

/** One browser subscription to deliver to (credential-grade fields). */
export type BrowserPushSubscriptionTarget = {
  endpoint: string;
  /** The subscriber's P-256 public key, base64url. */
  p256dh: string;
  /** The subscriber's auth secret, base64url. */
  auth: string;
};

export type BrowserPushSendInput = {
  subscription: BrowserPushSubscriptionTarget;
  title: string;
  body: string | null;
  /** The pointer payload (client-neutral routing data). */
  data?: Record<string, string>;
  /** Correlation id for the delivery this send belongs to. */
  deliveryId?: string | null;
};

export interface BrowserPushAdapter {
  readonly provider: string;
  send(input: BrowserPushSendInput): Promise<PushSendResult>;
}

/**
 * Sanitizes a push-service error body so it can become attempt evidence.
 * The body may echo the endpoint; the endpoint is a capability URL, so it is
 * redacted before the text leaves this module.
 */
export function sanitizeBrowserPushError(message: string): string {
  return message
    .replace(/https?:\/\/[^\s"']+/gi, '[redacted-endpoint]')
    .replace(/\b[A-Za-z0-9_-]{20,}\b/g, '[redacted]');
}

/**
 * Classifies a push-service response into the normalized failure taxonomy.
 * Pure — no I/O, no database.
 */
export function classifyBrowserPushStatus(
  status: number,
): { errorCode: PushErrorCode; retryable: boolean; tokenInvalid: boolean } {
  if (status === 404 || status === 410) {
    // The push service proved the subscription is gone.
    return { errorCode: 'INVALID_TOKEN', retryable: false, tokenInvalid: true };
  }
  if (status === 401 || status === 403) {
    return { errorCode: 'AUTHENTICATION_FAILED', retryable: false, tokenInvalid: false };
  }
  if (status === 413) {
    return { errorCode: 'PAYLOAD_INVALID', retryable: false, tokenInvalid: false };
  }
  if (status === 429) {
    return { errorCode: 'RATE_LIMITED', retryable: true, tokenInvalid: false };
  }
  if (status >= 500) {
    return { errorCode: 'PROVIDER_UNAVAILABLE', retryable: true, tokenInvalid: false };
  }
  if (status >= 400) {
    return { errorCode: 'INVALID_REQUEST', retryable: false, tokenInvalid: false };
  }
  return { errorCode: 'UNKNOWN_ERROR', retryable: false, tokenInvalid: false };
}

export type BrowserPushAdapterOptions = {
  config?: BrowserPushConfig;
  transport?: BrowserPushHttpTransport;
};

export class BrowserPushWebPushAdapter implements BrowserPushAdapter {
  readonly provider = BROWSER_PUSH_PROVIDER;

  private readonly config: BrowserPushConfig;

  private readonly transport: BrowserPushHttpTransport;

  constructor(options: BrowserPushAdapterOptions = {}) {
    this.config = options.config ?? readBrowserPushConfig();
    this.transport = options.transport ?? createFetchBrowserPushTransport();
  }

  async send(input: BrowserPushSendInput): Promise<PushSendResult> {
    const violations = validateBrowserPushPayload(input);
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

    const subscriberPoint = decodeBase64Url(input.subscription.p256dh);
    const subscriberAuth = decodeBase64Url(input.subscription.auth);
    if (!subscriberPoint || !subscriberAuth) {
      return {
        status: 'FAILED',
        provider: this.provider,
        error: 'Push payload rejected: the subscription key material is unreadable.',
        errorCode: 'PAYLOAD_INVALID',
        retryable: false,
        tokenInvalid: false,
        deliveryId: input.deliveryId ?? null,
        sentAt: new Date(),
      };
    }

    let endpoint: URL;
    try {
      endpoint = new URL(input.subscription.endpoint);
    } catch {
      return {
        status: 'FAILED',
        provider: this.provider,
        error: 'Push payload rejected: the subscription endpoint is not a URL.',
        errorCode: 'PAYLOAD_INVALID',
        retryable: false,
        tokenInvalid: false,
        deliveryId: input.deliveryId ?? null,
        sentAt: new Date(),
      };
    }

    const plaintext = Buffer.from(
      JSON.stringify({
        title: input.title,
        body: input.body,
        data: input.data ?? {},
      }),
      'utf8',
    );
    const body = encryptBrowserPushPayload(
      plaintext,
      subscriberPoint,
      subscriberAuth,
    );

    const headers: Record<string, string> = {
      Authorization: buildVapidAuthorizationHeader(
        this.config,
        endpoint.origin,
      ),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(body.length),
      TTL: String(this.config.ttlSeconds),
      Urgency: 'normal',
      'User-Agent': BROWSER_PUSH_DEFAULTS.userAgent,
    };

    try {
      const response = await this.transport({
        url: endpoint.toString(),
        method: 'POST',
        headers,
        body,
        timeoutMs: this.config.timeoutMs,
      });

      if (response.status >= 200 && response.status < 300) {
        return {
          status: 'SENT',
          provider: this.provider,
          providerMessageId: null,
          retryable: false,
          tokenInvalid: false,
          deliveryId: input.deliveryId ?? null,
          sentAt: new Date(),
        };
      }

      const classification = classifyBrowserPushStatus(response.status);
      return {
        status: 'FAILED',
        provider: this.provider,
        error: sanitizeBrowserPushError(
          `Push service rejected the request with status ${response.status}.`,
        ),
        errorCode: classification.errorCode,
        retryable: classification.retryable,
        tokenInvalid: classification.tokenInvalid,
        deliveryId: input.deliveryId ?? null,
        sentAt: new Date(),
      };
    } catch (error) {
      return {
        status: 'FAILED',
        provider: this.provider,
        error: sanitizeBrowserPushError(
          error instanceof Error ? error.message : String(error),
        ),
        errorCode: 'NETWORK_ERROR',
        retryable: true,
        tokenInvalid: false,
        deliveryId: input.deliveryId ?? null,
        sentAt: new Date(),
      };
    }
  }
}

/**
 * A deterministic, non-reversing fingerprint of a subscription endpoint,
 * safe for diagnostics. NEVER log or return the endpoint itself.
 */
export function browserSubscriptionFingerprint(endpoint: string): string {
  const value = typeof endpoint === 'string' ? endpoint : '';
  if (value.length <= 8) {
    return `len:${value.length}`;
  }
  return `${value.slice(0, 4)}…${value.slice(-2)}(len:${value.length})`;
}

// ---------------------------------------------------------------------------
// Credential-less adapters (test/dev parity with the native transport)
// ---------------------------------------------------------------------------

/** Simulated outcomes of the credential-less browser adapters. */
export type SimulatedBrowserPushOutcome =
  | 'sent'
  | 'fail'
  | 'fail-permanent'
  | 'fail-retryable'
  | 'fail-invalid-subscription';

function simulatedBrowserFailure(
  provider: string,
  outcome: Exclude<SimulatedBrowserPushOutcome, 'sent'>,
  deliveryId: string | null | undefined,
  sentAt: Date,
): PushSendResult {
  if (outcome === 'fail-invalid-subscription') {
    return {
      status: 'FAILED',
      provider,
      error: `Simulated invalid browser subscription (${provider} adapter).`,
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
    error: `Simulated browser push provider failure (${provider} adapter).`,
    errorCode: retryable ? 'PROVIDER_UNAVAILABLE' : 'UNKNOWN_ERROR',
    retryable,
    tokenInvalid: false,
    deliveryId: deliveryId ?? null,
    sentAt,
  };
}

/** Credential-less no-op browser adapter. Contacts nothing. */
export class NoopBrowserPushAdapter implements BrowserPushAdapter {
  readonly provider = 'noop';

  private readonly outcome: SimulatedBrowserPushOutcome;

  constructor(outcome: SimulatedBrowserPushOutcome = 'sent') {
    this.outcome = outcome;
  }

  async send(input: BrowserPushSendInput): Promise<PushSendResult> {
    const violations = validateBrowserPushPayload(input);
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
    if (this.outcome !== 'sent') {
      return simulatedBrowserFailure(this.provider, this.outcome, input.deliveryId, sentAt);
    }
    return {
      status: 'SENT',
      provider: this.provider,
      providerMessageId: `noop-browser-${Date.now()}`,
      retryable: false,
      tokenInvalid: false,
      deliveryId: input.deliveryId ?? null,
      sentAt,
    };
  }
}

/** One captured browser send, in send order. The endpoint is fingerprinted. */
export type CapturedBrowserPushSend = {
  endpointFingerprint: string;
  title: string;
  body: string | null;
  data: Record<string, string>;
  deliveryId: string | null;
  sentAt: Date;
};

/**
 * Credential-less capture browser adapter. Never contacts any external
 * system: it records every successful send in memory for deterministic
 * local/test validation.
 */
export class CaptureBrowserPushAdapter implements BrowserPushAdapter {
  readonly provider = 'capture';

  private readonly sent: CapturedBrowserPushSend[] = [];

  private readonly outcome: SimulatedBrowserPushOutcome;

  constructor(outcome: SimulatedBrowserPushOutcome = 'sent') {
    this.outcome = outcome;
  }

  get captures(): readonly CapturedBrowserPushSend[] {
    return [...this.sent];
  }

  reset(): void {
    this.sent.length = 0;
  }

  async send(input: BrowserPushSendInput): Promise<PushSendResult> {
    const violations = validateBrowserPushPayload(input);
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
    if (this.outcome !== 'sent') {
      return simulatedBrowserFailure(this.provider, this.outcome, input.deliveryId, sentAt);
    }
    this.sent.push({
      endpointFingerprint: browserSubscriptionFingerprint(input.subscription.endpoint),
      title: input.title,
      body: input.body ?? null,
      data: { ...(input.data ?? {}) },
      deliveryId: input.deliveryId ?? null,
      sentAt,
    });
    return {
      status: 'SENT',
      provider: this.provider,
      providerMessageId: `capture-browser-${Date.now()}`,
      retryable: false,
      tokenInvalid: false,
      deliveryId: input.deliveryId ?? null,
      sentAt,
    };
  }
}

// ---------------------------------------------------------------------------
// Payload validation (the browser counterpart of validatePushPayload)
// ---------------------------------------------------------------------------

/** The defensive bounds shared with the native transport. */
export const BROWSER_PUSH_PAYLOAD_LIMITS = {
  titleMaxLength: 100,
  bodyMaxLength: 240,
  dataMaxKeys: 12,
  dataKeyMaxLength: 64,
  dataValueMaxLength: 256,
  dataMaxTotalBytes: 2048,
} as const;

/**
 * Validates a browser send input against the defensive bounds. Returns the
 * list of violations (empty when the payload is acceptable). Pure — no I/O.
 */
export function validateBrowserPushPayload(
  input: BrowserPushSendInput,
): string[] {
  const violations: string[] = [];

  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (title.length === 0) {
    violations.push('title is required');
  } else if (title.length > BROWSER_PUSH_PAYLOAD_LIMITS.titleMaxLength) {
    violations.push(
      `title exceeds ${BROWSER_PUSH_PAYLOAD_LIMITS.titleMaxLength} characters`,
    );
  }

  if (
    input.body !== null &&
    input.body !== undefined &&
    input.body.length > BROWSER_PUSH_PAYLOAD_LIMITS.bodyMaxLength
  ) {
    violations.push(
      `body exceeds ${BROWSER_PUSH_PAYLOAD_LIMITS.bodyMaxLength} characters`,
    );
  }

  const data = input.data ?? {};
  const entries = Object.entries(data);
  if (entries.length > BROWSER_PUSH_PAYLOAD_LIMITS.dataMaxKeys) {
    violations.push(
      `data exceeds ${BROWSER_PUSH_PAYLOAD_LIMITS.dataMaxKeys} keys`,
    );
  }
  let totalBytes = 0;
  for (const [key, value] of entries) {
    if (key.length === 0 || key.length > BROWSER_PUSH_PAYLOAD_LIMITS.dataKeyMaxLength) {
      violations.push(
        `data key must be 1..${BROWSER_PUSH_PAYLOAD_LIMITS.dataKeyMaxLength} characters`,
      );
      continue;
    }
    if (typeof value !== 'string') {
      violations.push(`data key '${key}' must map to a string value`);
      continue;
    }
    if (value.length > BROWSER_PUSH_PAYLOAD_LIMITS.dataValueMaxLength) {
      violations.push(
        `data key '${key}' exceeds ${BROWSER_PUSH_PAYLOAD_LIMITS.dataValueMaxLength} characters`,
      );
      continue;
    }
    totalBytes += Buffer.byteLength(key, 'utf8') + Buffer.byteLength(value, 'utf8');
  }
  if (totalBytes > BROWSER_PUSH_PAYLOAD_LIMITS.dataMaxTotalBytes) {
    violations.push(
      `data payload exceeds ${BROWSER_PUSH_PAYLOAD_LIMITS.dataMaxTotalBytes} bytes`,
    );
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * The provider discriminators that never read credentials and are always
 * allowed, including under `NODE_ENV=test`.
 */
export const CREDENTIAL_LESS_BROWSER_PUSH_PROVIDERS = ['noop', 'capture'] as const;

/** All implemented browser push provider discriminators. */
export const AVAILABLE_BROWSER_PUSH_PROVIDERS = [
  'noop',
  'capture',
  'webpush',
] as const;

/**
 * Selects the configured browser push adapter (`PUSH_BROWSER_PROVIDER`).
 *
 * FAIL-CLOSED CONTRACT (mirrors the native adapter, §12.2):
 *   - in the test environment ONLY credential-less providers resolve — a
 *     real browser push can never be sent by a test,
 *   - an unknown provider throws `ConfigError` — there is NO silent fallback
 *     and no implicit real-delivery path,
 *   - `webpush` with missing/invalid configuration throws `ConfigError` from
 *     the adapter constructor rather than degrading to a no-op.
 */
export function resolveBrowserPushAdapter(): BrowserPushAdapter {
  const provider = (
    process.env.PUSH_BROWSER_PROVIDER?.trim() || 'noop'
  ).toLowerCase();
  if (provider === 'noop') {
    return new NoopBrowserPushAdapter();
  }
  if (provider === 'capture') {
    return new CaptureBrowserPushAdapter();
  }
  if (process.env.NODE_ENV === 'test') {
    throw new ConfigError(
      `Invalid configuration: PUSH_BROWSER_PROVIDER '${provider}' cannot be resolved in the test environment (credential-less providers only: ${CREDENTIAL_LESS_BROWSER_PUSH_PROVIDERS.join(', ')}).`,
    );
  }
  if (provider === 'webpush') {
    return new BrowserPushWebPushAdapter();
  }
  throw new ConfigError(
    `Invalid configuration: no browser push adapter is implemented for PUSH_BROWSER_PROVIDER '${provider}' (available: ${AVAILABLE_BROWSER_PUSH_PROVIDERS.join(', ')}).`,
  );
}
