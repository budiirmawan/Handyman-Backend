import { randomUUID } from 'node:crypto';
import { ConfigError, getAppConfig } from '../../config';
import { SmtpEmailAdapter } from './smtp-email-adapter';

/**
 * BE-26F — Email delivery adapter abstraction.
 * CR-BE-NOTIFY-PROV-01 PART 01 — provider result taxonomy + capture adapter.
 *
 * The adapter interface is provider-agnostic: a concrete provider adapter
 * (SMTP, SES, SendGrid, …) implements `EmailAdapter` and is selected by the
 * `EMAIL_PROVIDER` discriminator. No provider is hardcoded here, and no
 * credentials are read, returned, or logged by this layer.
 *
 * Only credential-less adapters ship today (adapter-ready, testable/mockable):
 *   - `noop`   — never sends real email; returns a synthetic reference,
 *   - `capture` — never contacts anything; additionally records every send
 *     input in memory for deterministic local/test validation.
 *
 * PART 01 result extension (additive, governance §3.2): `retryable` (the
 * adapter's classification hint for a FAILED outcome) and `providerMessageId`
 * (the normalized provider message id; supersedes the free-text
 * `providerReference`, which stays for compatibility). The shared taxonomy in
 * `src/shared/provider-result.ts` normalizes results into lifecycle outcomes.
 */

export type EmailSendInput = {
  /** Recipient email address. */
  to: string;
  /** Subject (already rendered from the notification template). */
  subject: string;
  /** Body (already rendered from the notification template). */
  body: string | null;
};

export type EmailSendResult = {
  status: 'SENT' | 'FAILED';
  /** Provider response id/reference where available (free-text, legacy). */
  providerReference?: string | null;
  /**
   * Normalized provider message id where available (CR-BE-NOTIFY-PROV-01
   * PART 01). Supersedes `providerReference`; the delivery service persists
   * it in the existing `provider_reference` column (no schema change).
   */
  providerMessageId?: string | null;
  /** Sanitized failure message (must never contain credentials). */
  error?: string | null;
  /**
   * Adapter classification hint for a FAILED outcome (PART 01 taxonomy):
   * `true` marks a transient failure the retry engine may attempt again;
   * absent/false is the conservative default (permanent). Ignored for SENT.
   */
  retryable?: boolean;
  /** When the provider accepted (or rejected) the send. */
  sentAt: Date;
};

export interface EmailAdapter {
  /** Stable provider discriminator (recorded on the delivery). */
  readonly provider: string;
  send(input: EmailSendInput): Promise<EmailSendResult>;
}

/**
 * Credential-less no-op adapter. Never sends real email. Its constructor
 * outcome lets tests (and future wiring) simulate SENT or FAILED responses.
 */
export class NoopEmailAdapter implements EmailAdapter {
  readonly provider = 'noop';

  constructor(private readonly outcome: 'sent' | 'fail' = 'sent') {}

  async send(_input: EmailSendInput): Promise<EmailSendResult> {
    if (this.outcome === 'fail') {
      return {
        status: 'FAILED',
        error: 'Simulated email provider failure (noop adapter).',
        sentAt: new Date(),
      };
    }
    return {
      status: 'SENT',
      providerReference: `noop-${randomUUID()}`,
      sentAt: new Date(),
    };
  }
}

/** Simulated capture outcomes: success, permanent failure, retryable failure. */
export type CaptureEmailAdapterOutcome =
  | 'sent'
  | 'fail'
  | 'fail-permanent'
  | 'fail-retryable';

/** One captured send (payload + synthetic provider reference), in send order. */
export type CapturedEmailSend = EmailSendInput & {
  providerMessageId: string;
  sentAt: Date;
};

/**
 * Credential-less capture adapter (CR-BE-NOTIFY-PROV-01 PART 01). Never
 * contacts any external system: it records every successful send input in an
 * in-memory capture list for deterministic local/test validation and returns
 * a synthetic `providerMessageId`. The durable record of the send remains the
 * delivery attempt row written by the delivery service.
 *
 * Constructor outcome simulates the PART 01 taxonomy deterministically:
 *   - `sent` (default)      → SENT with a captured payload,
 *   - `fail` / `fail-permanent` → FAILED, `retryable: false`,
 *   - `fail-retryable`      → FAILED, `retryable: true`.
 */
export class CaptureEmailAdapter implements EmailAdapter {
  readonly provider = 'capture';

  private readonly sent: CapturedEmailSend[] = [];

  constructor(private readonly outcome: CaptureEmailAdapterOutcome = 'sent') {}

  /** Snapshot of the payloads captured so far (successful sends only). */
  get captures(): readonly CapturedEmailSend[] {
    return [...this.sent];
  }

  async send(input: EmailSendInput): Promise<EmailSendResult> {
    const sentAt = new Date();
    if (this.outcome !== 'sent') {
      return {
        status: 'FAILED',
        error: 'Simulated email provider failure (capture adapter).',
        retryable: this.outcome === 'fail-retryable',
        sentAt,
      };
    }
    const providerMessageId = `capture-${randomUUID()}`;
    this.sent.push({ ...input, providerMessageId, sentAt });
    return {
      status: 'SENT',
      providerReference: providerMessageId,
      providerMessageId,
      sentAt,
    };
  }
}

/**
 * Provider discriminators that never read credentials and are always allowed,
 * including under `NODE_ENV=test` (the test-environment guard below).
 */
export const CREDENTIAL_LESS_EMAIL_PROVIDERS = ['noop', 'capture'] as const;

/** All implemented email provider discriminators (for fail-fast messages). */
export const AVAILABLE_EMAIL_PROVIDERS = ['noop', 'capture', 'smtp'] as const;

/**
 * Selects the configured email adapter. Implemented providers: the
 * credential-less `noop` / `capture` adapters and the real `smtp` adapter
 * (CR-BE-NOTIFY-PROV-01 PART 05; its credentials are read at the adapter
 * construction boundary, never here). Any other provider fails fast with a
 * ConfigError (no silent fallback to a different provider). In the test
 * environment only credential-less providers may resolve, so a real provider
 * can never be contacted by tests.
 */
export function resolveEmailAdapter(): EmailAdapter {
  const config = getAppConfig();
  const { provider } = config.email;
  if (provider === 'noop') {
    return new NoopEmailAdapter();
  }
  if (provider === 'capture') {
    return new CaptureEmailAdapter();
  }
  if (config.isTest) {
    throw new ConfigError(
      `Invalid configuration: EMAIL_PROVIDER '${provider}' cannot be resolved in the test environment (credential-less providers only: ${CREDENTIAL_LESS_EMAIL_PROVIDERS.join(', ')}).`,
    );
  }
  if (provider === 'smtp') {
    return new SmtpEmailAdapter();
  }
  throw new ConfigError(
    `Invalid configuration: no email adapter is implemented for EMAIL_PROVIDER '${provider}' (available: ${AVAILABLE_EMAIL_PROVIDERS.join(', ')}).`,
  );
}
