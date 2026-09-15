import { ConfigError } from '../../config';
import type { WhatsAppAdapter, WhatsAppSendInput, WhatsAppSendResult } from './whatsapp-adapter';

/**
 * CR-BE-NOTIFY-PROV-01 PART 06 — Meta WhatsApp Business Cloud API adapter.
 *
 * Provider decision: `WHATSAPP_PROVIDER=meta`. Implements the PART 01
 * `WhatsAppAdapter` contract and plugs into the PART 04 execution engine
 * unchanged (the engine passes the ledger's `templateKey` through the
 * PART 06 additive input field).
 *
 * SECRETS BOUNDARY (governance §8)
 * --------------------------------
 * All Meta configuration — including `WHATSAPP_META_ACCESS_TOKEN` — is read
 * INSIDE this module at adapter construction (`readMetaWhatsAppConfig`).
 * Nothing reaches `AppConfig` (env.ts still reads only the
 * `WHATSAPP_PROVIDER` discriminator), and credentials are never logged,
 * returned by any seam, written to a delivery/event row, or embedded in
 * error messages (credential-like fragments are redacted before they leave
 * this module).
 *
 * MESSAGE CLASSES (governance §5.2)
 * ---------------------------------
 *   - templateKey present  → business-initiated TEMPLATE message. The key
 *     must have an approved-template mapping (`WHATSAPP_META_TEMPLATE_MAP`);
 *     a missing mapping is REJECTED_PERMANENT without contacting the API.
 *     The rendered message is passed as the template's single body-text
 *     parameter.
 *   - templateKey absent   → free-form session TEXT message (valid only
 *     inside the provider's 24-hour user-initiated window — the provider
 *     enforces this; a window violation surfaces as a permanent reject).
 *
 * TAXONOMY MAPPING (governance §3.3)
 * ----------------------------------
 *   2xx                       → SENT (+ provider `wamid`),
 *   HTTP 429 / 5xx, network
 *   timeouts, Meta 130xxx     → FAILED, retryable: true,
 *   HTTP 401/403, Meta 4xx
 *   policy codes (131026,
 *   131047, 131051, …)        → FAILED, retryable: false,
 *   unclassified              → FAILED, retryable: true (bounded by the
 *                               ledger attempt budget).
 */

// ---------------------------------------------------------------------------
// Configuration (read at the adapter boundary only)
// ---------------------------------------------------------------------------

/** Approved-template mapping for one internal BE-26B template key. */
export type MetaWhatsAppTemplateMapping = {
  /** Provider-approved template name. */
  name: string;
  /** Template language code (default `en_US`). */
  language: string;
};

export type MetaWhatsAppConfig = {
  accessToken: string;
  phoneNumberId: string;
  apiBaseUrl: string;
  apiVersion: string;
  timeoutMs: number;
  templateMap: Record<string, MetaWhatsAppTemplateMapping>;
};

export const META_WHATSAPP_DEFAULTS = {
  apiBaseUrl: 'https://graph.facebook.com',
  apiVersion: 'v21.0',
  timeoutMs: 20_000,
  templateLanguage: 'en_US',
} as const;

/**
 * Parses `WHATSAPP_META_TEMPLATE_MAP` — a JSON object mapping internal
 * template keys to approved Meta templates, either a string shorthand
 * (`"approved_name"`) or an object (`{ "name": ..., "language": ... }`).
 * Malformed JSON or entries throw ConfigError (field names only).
 */
export function parseMetaWhatsAppTemplateMap(
  raw: string | undefined,
): Record<string, MetaWhatsAppTemplateMapping> {
  if (raw === undefined || raw.trim() === '') {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(
      'Invalid configuration: WHATSAPP_META_TEMPLATE_MAP must be valid JSON (e.g. {"TEMPLATE_KEY":{"name":"approved_name","language":"en_US"}}).',
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(
      'Invalid configuration: WHATSAPP_META_TEMPLATE_MAP must be a JSON object keyed by template key.',
    );
  }
  const map: Record<string, MetaWhatsAppTemplateMapping> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string' && value.trim().length > 0) {
      map[key] = { name: value.trim(), language: META_WHATSAPP_DEFAULTS.templateLanguage };
      continue;
    }
    if (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as { name?: unknown }).name === 'string' &&
      ((value as { name: string }).name as string).trim().length > 0
    ) {
      const object = value as { name: string; language?: unknown };
      map[key] = {
        name: object.name.trim(),
        language:
          typeof object.language === 'string' && object.language.trim().length > 0
            ? object.language.trim()
            : META_WHATSAPP_DEFAULTS.templateLanguage,
      };
      continue;
    }
    throw new ConfigError(
      `Invalid configuration: WHATSAPP_META_TEMPLATE_MAP entry '${key}' must be an approved template name string or { name, language? } object.`,
    );
  }
  return map;
}

/**
 * Reads the Meta WhatsApp configuration from the process environment. Called
 * ONLY at adapter construction — never by `env.ts`/`AppConfig`.
 *
 * Required: `WHATSAPP_META_ACCESS_TOKEN`, `WHATSAPP_META_PHONE_NUMBER_ID`.
 * Optional: `WHATSAPP_META_API_BASE_URL` (https://graph.facebook.com),
 *           `WHATSAPP_META_API_VERSION` (v21.0),
 *           `WHATSAPP_META_TEMPLATE_MAP` (approved-template JSON, §5.2).
 *
 * ConfigError messages mention field NAMES only — never the token value.
 */
export function readMetaWhatsAppConfig(
  env: NodeJS.ProcessEnv = process.env,
): MetaWhatsAppConfig {
  const accessToken = env.WHATSAPP_META_ACCESS_TOKEN?.trim();
  if (!accessToken) {
    throw new ConfigError(
      'Invalid configuration: WHATSAPP_META_ACCESS_TOKEN is required when WHATSAPP_PROVIDER=meta.',
    );
  }
  const phoneNumberId = env.WHATSAPP_META_PHONE_NUMBER_ID?.trim();
  if (!phoneNumberId) {
    throw new ConfigError(
      'Invalid configuration: WHATSAPP_META_PHONE_NUMBER_ID is required when WHATSAPP_PROVIDER=meta.',
    );
  }

  const apiBaseUrl = (env.WHATSAPP_META_API_BASE_URL?.trim() || META_WHATSAPP_DEFAULTS.apiBaseUrl)
    .replace(/\/+$/, '');
  const apiVersion = (env.WHATSAPP_META_API_VERSION?.trim() || META_WHATSAPP_DEFAULTS.apiVersion)
    .replace(/^\/+|\/+$/g, '');

  return {
    accessToken,
    phoneNumberId,
    apiBaseUrl,
    apiVersion,
    timeoutMs: META_WHATSAPP_DEFAULTS.timeoutMs,
    templateMap: parseMetaWhatsAppTemplateMap(env.WHATSAPP_META_TEMPLATE_MAP),
  };
}

// ---------------------------------------------------------------------------
// HTTP transport seam (injectable for mocked tests — no external network)
// ---------------------------------------------------------------------------

export type MetaWhatsAppHttpRequest = {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
};

export type MetaWhatsAppHttpResponse = {
  status: number;
  body: string;
};

export type MetaWhatsAppHttpTransport = (
  request: MetaWhatsAppHttpRequest,
) => Promise<MetaWhatsAppHttpResponse>;

/** Production transport: built-in fetch with a bounded timeout. */
export function createFetchMetaWhatsAppTransport(): MetaWhatsAppHttpTransport {
  return async (request: MetaWhatsAppHttpRequest): Promise<MetaWhatsAppHttpResponse> => {
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
// Error classification → PART 01 taxonomy
// ---------------------------------------------------------------------------

const MAX_ERROR_LENGTH = 500;
const SECRET_PATTERN =
  /(password|passwd|pwd|secret|api[_-]?key|token|authorization|bearer|auth[_-]?token)\s*[:=]\s*[^\s,;"']+/gi;

/** Redacts credential-like fragments before any error text leaves this module. */
export function sanitizeMetaWhatsAppError(message: string): string {
  const redacted = message.replace(SECRET_PATTERN, '$1=[REDACTED]');
  return redacted.length > MAX_ERROR_LENGTH
    ? `${redacted.slice(0, MAX_ERROR_LENGTH)}…`
    : redacted;
}

/**
 * Meta error-code families: 130xxx is throttling/infra (transient); the
 * well-known 131xxx/132xxx/133xxx message-policy rejects are permanent.
 */
function isTransientMetaErrorCode(code: number): boolean {
  return code >= 130_000 && code < 131_000;
}

export type MetaWhatsAppFailureInput = {
  /** HTTP status, when a response was received. */
  status?: number;
  /** Meta `error.code`, when the response body carried one. */
  code?: number | null;
  /** Raw error text (sanitized before returning). */
  message: string;
  /** Network-level failure (no HTTP response at all). */
  network?: boolean;
};

/**
 * Normalizes a Meta failure into the PART 01 `retryable` contract.
 * Network/timeout, HTTP 429/5xx and Meta 130xxx are retryable; auth (401/403)
 * and message-policy rejects are permanent; anything unclassified is
 * retryable (bounded by the ledger attempt budget — never a silent loss).
 */
export function classifyMetaWhatsAppError(
  failure: MetaWhatsAppFailureInput,
): { retryable: boolean; message: string } {
  const message = sanitizeMetaWhatsAppError(failure.message);

  if (failure.network) {
    return { retryable: true, message };
  }

  const status = failure.status;
  if (status === undefined) {
    return { retryable: true, message };
  }
  if (status === 429 || status >= 500) {
    return { retryable: true, message };
  }
  if (status === 401 || status === 403) {
    return { retryable: false, message };
  }
  if (typeof failure.code === 'number' && isTransientMetaErrorCode(failure.code)) {
    return { retryable: true, message };
  }
  return { retryable: false, message };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export type MetaWhatsAppAdapterOptions = {
  /** Boundary config; defaults to `readMetaWhatsAppConfig(process.env)`. */
  config?: MetaWhatsAppConfig;
  /** HTTP transport; defaults to the bounded-fetch transport. */
  transport?: MetaWhatsAppHttpTransport;
};

/**
 * Real Meta WhatsApp Business Cloud API adapter (discriminator `meta`).
 *
 * Construction validates config; no HTTP request happens until `send`.
 */
export class MetaWhatsAppAdapter implements WhatsAppAdapter {
  readonly provider = 'meta';

  private readonly config: MetaWhatsAppConfig;
  private readonly transport: MetaWhatsAppHttpTransport;

  constructor(options: MetaWhatsAppAdapterOptions = {}) {
    this.config = options.config ?? readMetaWhatsAppConfig();
    this.transport = options.transport ?? createFetchMetaWhatsAppTransport();
  }

  async send(input: WhatsAppSendInput): Promise<WhatsAppSendResult> {
    const sentAt = new Date();
    const templateKey = input.templateKey?.trim();

    // Business-initiated sends REQUIRE an approved-template mapping (§5.2);
    // without one the send is permanently rejected BEFORE contacting Meta.
    let payload: Record<string, unknown>;
    if (templateKey) {
      const mapping = this.config.templateMap[templateKey];
      if (!mapping) {
        return {
          status: 'FAILED',
          error: sanitizeMetaWhatsAppError(
            `No approved Meta template mapping for template key '${templateKey}' (WHATSAPP_META_TEMPLATE_MAP).`,
          ),
          retryable: false,
          sentAt,
        };
      }
      payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: input.to,
        type: 'template',
        template: {
          name: mapping.name,
          language: { code: mapping.language },
          components: [
            {
              type: 'body',
              parameters: [{ type: 'text', text: input.message }],
            },
          ],
        },
      };
    } else {
      // Session (user-initiated window) free-form text message.
      payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: input.to,
        type: 'text',
        text: { body: input.message },
      };
    }

    let response: MetaWhatsAppHttpResponse;
    try {
      response = await this.transport({
        url: `${this.config.apiBaseUrl}/${this.config.apiVersion}/${this.config.phoneNumberId}/messages`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.accessToken}`,
        },
        body: JSON.stringify(payload),
        timeoutMs: this.config.timeoutMs,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const { retryable, message } = classifyMetaWhatsAppError({
        message: `Meta WhatsApp API request failed: ${reason}`,
        network: true,
      });
      return { status: 'FAILED', error: message, retryable, sentAt };
    }

    if (response.status >= 200 && response.status < 300) {
      let messageId: string | null = null;
      try {
        const parsed = JSON.parse(response.body) as {
          messages?: Array<{ id?: unknown }>;
        };
        const first = parsed.messages?.[0]?.id;
        messageId = typeof first === 'string' && first.length > 0 ? first : null;
      } catch {
        // A 2xx with an unparsable body is still an acceptance.
      }
      return {
        status: 'SENT',
        providerMessageId: messageId,
        providerReference: messageId,
        sentAt,
      };
    }

    // Non-2xx: extract Meta's error envelope when present.
    let metaCode: number | null = null;
    let metaMessage = `Meta WhatsApp API returned HTTP ${response.status}.`;
    try {
      const parsed = JSON.parse(response.body) as {
        error?: { message?: unknown; code?: unknown };
      };
      if (parsed.error) {
        if (typeof parsed.error.message === 'string' && parsed.error.message.length > 0) {
          metaMessage = parsed.error.message;
        }
        if (typeof parsed.error.code === 'number') {
          metaCode = parsed.error.code;
        }
      }
    } catch {
      // Keep the status-based message.
    }

    const { retryable, message } = classifyMetaWhatsAppError({
      status: response.status,
      code: metaCode,
      message: metaMessage,
    });
    return { status: 'FAILED', error: message, retryable, sentAt };
  }
}
