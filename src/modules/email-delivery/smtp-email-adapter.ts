import * as nodemailer from 'nodemailer';
import { ConfigError } from '../../config';
import { classifyProviderResult } from '../../shared/provider-result';
import type { EmailAdapter, EmailSendInput, EmailSendResult } from './email-adapter';

/**
 * CR-BE-NOTIFY-PROV-01 PART 05 — real SMTP email adapter (gated provider).
 *
 * Provider decision: `EMAIL_PROVIDER=smtp`. This is the first real provider
 * adapter; it implements the PART 01 `EmailAdapter` contract and plugs into
 * the PART 04 execution engine unchanged (claim/send/attempt/retry/event
 * machinery is provider-agnostic).
 *
 * SECRETS BOUNDARY (governance §8)
 * --------------------------------
 * All SMTP configuration — including `EMAIL_SMTP_USERNAME` /
 * `EMAIL_SMTP_PASSWORD` — is read INSIDE this module at adapter construction
 * (`readSmtpConfig`). Nothing reaches `AppConfig` (env.ts still reads only
 * the `EMAIL_PROVIDER` discriminator), and credentials are never logged,
 * returned by any seam, written to a delivery/event row, or embedded in
 * error messages (credential-like fragments are redacted before they leave
 * this module).
 *
 * TRANSPORT SEAM
 * --------------
 * The wire transport is an injectable `SmtpTransport` (`sendMail`). The
 * production default wraps nodemailer (the PART 05 dependency decision,
 * governance §4.1); tests inject a mock transport, so no external network
 * dependency exists in validation.
 *
 * TAXONOMY MAPPING (governance §3.3)
 * ----------------------------------
 * SMTP outcomes are normalized into the PART 01 result contract:
 *   - transport acceptance              → SENT (+ provider message id),
 *   - 4xx SMTP responses / transient
 *     network errors (ECONNREFUSED,
 *     ETIMEDOUT, …)                     → FAILED, retryable: true,
 *   - 5xx SMTP responses / auth
 *     failures (EAUTH) / envelope
 *     rejects                           → FAILED, retryable: false,
 *   - unclassified errors               → FAILED, retryable: true (bounded
 *     by the ledger attempt budget — a misclassified transient failure must
 *     not silently become a permanent loss).
 */

// ---------------------------------------------------------------------------
// Configuration (read at the adapter boundary only)
// ---------------------------------------------------------------------------

export type SmtpEmailConfig = {
  host: string;
  port: number;
  secure: boolean;
  /** Empty string = no SMTP AUTH (e.g. a trusted local relay). */
  username: string;
  password: string;
  fromAddress: string;
  fromName: string | null;
  replyTo: string | null;
  /** Bounded send timings (governance §3.2 adapter runtime contract). */
  connectionTimeoutMs: number;
  greetingTimeoutMs: number;
  socketTimeoutMs: number;
};

export const SMTP_EMAIL_DEFAULTS = {
  port: 587,
  secure: false,
  connectionTimeoutMs: 10_000,
  greetingTimeoutMs: 15_000,
  socketTimeoutMs: 20_000,
} as const;

const TRUTHY = new Set(['true', '1', 'yes', 'on']);
const FALSY = new Set(['false', '0', 'no', 'off', '']);

function parsePort(raw: string | undefined, field: string): number {
  if (raw === undefined || raw.trim() === '') {
    return SMTP_EMAIL_DEFAULTS.port;
  }
  const port = Number(raw.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(
      `Invalid configuration: ${field} must be an integer between 1 and 65535 (received ${JSON.stringify(raw)}).`,
    );
  }
  return port;
}

function parseBool(
  raw: string | undefined,
  field: string,
  fallback: boolean,
): boolean {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (TRUTHY.has(normalized)) return true;
  if (FALSY.has(normalized)) return false;
  throw new ConfigError(
    `Invalid configuration: ${field} must be a boolean (true/false) value (received ${JSON.stringify(raw)}).`,
  );
}

/**
 * Reads the SMTP configuration from the process environment. Called ONLY at
 * adapter construction — never by `env.ts`/`AppConfig`.
 *
 * Required: `EMAIL_SMTP_HOST`, `EMAIL_FROM_ADDRESS`.
 * Optional:  `EMAIL_SMTP_PORT` (587), `EMAIL_SMTP_SECURE` (false),
 *            `EMAIL_SMTP_USERNAME` / `EMAIL_SMTP_PASSWORD` (no AUTH when the
 *            username is empty), `EMAIL_FROM_NAME`, `EMAIL_REPLY_TO`.
 *
 * ConfigError messages mention field NAMES only — never credential values.
 */
export function readSmtpEmailConfig(
  env: NodeJS.ProcessEnv = process.env,
): SmtpEmailConfig {
  const host = env.EMAIL_SMTP_HOST?.trim();
  if (!host) {
    throw new ConfigError(
      'Invalid configuration: EMAIL_SMTP_HOST is required when EMAIL_PROVIDER=smtp.',
    );
  }

  const fromAddress = env.EMAIL_FROM_ADDRESS?.trim();
  if (!fromAddress || !fromAddress.includes('@')) {
    throw new ConfigError(
      'Invalid configuration: EMAIL_FROM_ADDRESS is required (and must look like an email address) when EMAIL_PROVIDER=smtp.',
    );
  }

  const username = env.EMAIL_SMTP_USERNAME?.trim() ?? '';
  const fromName = env.EMAIL_FROM_NAME?.trim();
  const replyTo = env.EMAIL_REPLY_TO?.trim();

  return {
    host,
    port: parsePort(env.EMAIL_SMTP_PORT, 'EMAIL_SMTP_PORT'),
    secure: parseBool(env.EMAIL_SMTP_SECURE, 'EMAIL_SMTP_SECURE', SMTP_EMAIL_DEFAULTS.secure),
    username,
    password: username ? (env.EMAIL_SMTP_PASSWORD ?? '') : '',
    fromAddress,
    fromName: fromName && fromName.length > 0 ? fromName : null,
    replyTo: replyTo && replyTo.length > 0 ? replyTo : null,
    connectionTimeoutMs: SMTP_EMAIL_DEFAULTS.connectionTimeoutMs,
    greetingTimeoutMs: SMTP_EMAIL_DEFAULTS.greetingTimeoutMs,
    socketTimeoutMs: SMTP_EMAIL_DEFAULTS.socketTimeoutMs,
  };
}

// ---------------------------------------------------------------------------
// Transport seam
// ---------------------------------------------------------------------------

/** The wire-level message handed to the transport (no credentials inside). */
export type SmtpEmailMessage = {
  from: { name: string | null; address: string };
  replyTo: string | null;
  to: string;
  subject: string;
  text: string;
};

/** Transport acceptance result (nodemailer-shaped). */
export type SmtpEmailTransportResult = {
  messageId?: string | null;
  accepted?: string[];
  rejected?: string[];
  response?: string;
};

/** Injectable wire transport; production wraps nodemailer, tests mock it. */
export interface SmtpTransport {
  sendMail(message: SmtpEmailMessage): Promise<SmtpEmailTransportResult>;
}

/** Builds the production nodemailer transport from the boundary config. */
export function createNodemailerSmtpTransport(config: SmtpEmailConfig): SmtpTransport {
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    // AUTH stays inside the transporter construction — never in messages.
    auth: config.username
      ? { user: config.username, pass: config.password }
      : undefined,
    connectionTimeout: config.connectionTimeoutMs,
    greetingTimeout: config.greetingTimeoutMs,
    socketTimeout: config.socketTimeoutMs,
  });

  return {
    async sendMail(message: SmtpEmailMessage): Promise<SmtpEmailTransportResult> {
      const info = await transporter.sendMail({
        from: message.from.name
          ? { name: message.from.name, address: message.from.address }
          : message.from.address,
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        to: message.to,
        subject: message.subject,
        text: message.text,
      });
      const toAddress = (value: string | { address?: string } | undefined): string =>
        typeof value === 'string' ? value : (value?.address ?? '');
      return {
        messageId: info.messageId ?? null,
        accepted: info.accepted?.map(toAddress),
        rejected: info.rejected?.map(toAddress),
        response: typeof info.response === 'string' ? info.response : undefined,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Error classification → PART 01 taxonomy
// ---------------------------------------------------------------------------

const MAX_ERROR_LENGTH = 500;
const SECRET_PATTERN =
  /(password|passwd|pwd|secret|api[_-]?key|token|authorization|bearer)\s*[:=]\s*[^\s,;"']+/gi;

/** Redacts credential-like fragments before any error text leaves this module. */
export function sanitizeSmtpError(message: string): string {
  const redacted = message.replace(SECRET_PATTERN, '$1=[REDACTED]');
  return redacted.length > MAX_ERROR_LENGTH
    ? `${redacted.slice(0, MAX_ERROR_LENGTH)}…`
    : redacted;
}

/** Network/TLS error codes treated as transient (retryable). */
const TRANSIENT_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ETIMEOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPROTO',
]);

type SmtpErrorShape = {
  message?: unknown;
  responseCode?: unknown;
  code?: unknown;
};

/** Extracts a 3-digit SMTP response code from an error/response string. */
function smtpCodeOf(text: string | undefined | null): number | null {
  if (!text) return null;
  const match = /\b([2-5][0-9]{2})\b/.exec(text);
  return match ? Number(match[1]) : null;
}

/**
 * Classifies an SMTP failure into the PART 01 `retryable` contract:
 *   4xx / transient network codes → retryable; 5xx / auth → permanent;
 *   anything unclassified → retryable (bounded by the ledger attempt budget;
 *   a silent permanent loss is worse than a bounded extra attempt).
 */
export function classifySmtpError(error: unknown): {
  retryable: boolean;
  message: string;
} {
  const err = (error ?? {}) as SmtpErrorShape;
  const rawMessage =
    typeof err.message === 'string' && err.message.length > 0
      ? err.message
      : 'SMTP delivery failed.';
  const message = sanitizeSmtpError(rawMessage);

  const responseCode =
    typeof err.responseCode === 'number' ? err.responseCode : null;
  if (responseCode !== null) {
    if (responseCode >= 400 && responseCode < 500) {
      return { retryable: true, message };
    }
    if (responseCode >= 500) {
      return { retryable: false, message };
    }
  }

  const code = typeof err.code === 'string' ? err.code : '';
  if (code === 'EAUTH' || /authentication|invalid login/i.test(rawMessage)) {
    return { retryable: false, message };
  }
  if (TRANSIENT_ERROR_CODES.has(code)) {
    return { retryable: true, message };
  }

  return { retryable: true, message };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export type SmtpEmailAdapterOptions = {
  /** Boundary config; defaults to `readSmtpEmailConfig(process.env)`. */
  config?: SmtpEmailConfig;
  /** Wire transport; defaults to the nodemailer transport for `config`. */
  transport?: SmtpTransport;
};

/**
 * Real SMTP `EmailAdapter` (provider discriminator `smtp`).
 *
 * Construction reads/validates the boundary config and builds the transport;
 * no connection is opened until `send` is called. The PART 01 resolver
 * instantiates it when `EMAIL_PROVIDER=smtp` (outside `NODE_ENV=test`, where
 * only credential-less providers may resolve).
 */
export class SmtpEmailAdapter implements EmailAdapter {
  readonly provider = 'smtp';

  private readonly config: SmtpEmailConfig;
  private readonly transport: SmtpTransport;

  constructor(options: SmtpEmailAdapterOptions = {}) {
    this.config = options.config ?? readSmtpEmailConfig();
    this.transport = options.transport ?? createNodemailerSmtpTransport(this.config);
  }

  async send(input: EmailSendInput): Promise<EmailSendResult> {
    const sentAt = new Date();
    try {
      const result = await this.transport.sendMail({
        from: { name: this.config.fromName, address: this.config.fromAddress },
        replyTo: this.config.replyTo,
        to: input.to,
        subject: input.subject,
        text: input.body ?? input.subject,
      });

      // Envelope reject for our (single) recipient: the transport resolved
      // but the server refused this address.
      if (result.rejected?.includes(input.to)) {
        const responseCode = smtpCodeOf(result.response);
        const retryable = responseCode !== null ? responseCode < 500 : false;
        return {
          status: 'FAILED',
          error: sanitizeSmtpError(
            result.response ?? 'SMTP server rejected the recipient address.',
          ),
          retryable,
          sentAt,
        };
      }

      return {
        status: 'SENT',
        providerMessageId: result.messageId ?? null,
        providerReference: result.messageId ?? null,
        sentAt,
      };
    } catch (error) {
      const { retryable, message } = classifySmtpError(error);
      return { status: 'FAILED', error: message, retryable, sentAt };
    }
  }
}

/** Convenience: classifies a full adapter result through the taxonomy. */
export function classifySmtpEmailResult(result: EmailSendResult) {
  return classifyProviderResult(result);
}
