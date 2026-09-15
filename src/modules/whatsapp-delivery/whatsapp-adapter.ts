import { randomUUID } from 'node:crypto';
import { ConfigError, getAppConfig } from '../../config';
import { MetaWhatsAppAdapter } from './meta-whatsapp-adapter';

/**
 * BE-26G — WhatsApp delivery adapter abstraction.
 * CR-BE-NOTIFY-PROV-01 PART 01 — provider result taxonomy + capture adapter.
 *
 * The adapter interface is provider-agnostic: a concrete provider adapter
 * (Twilio, Meta WhatsApp Business, …) implements `WhatsAppAdapter` and is
 * selected by the `WHATSAPP_PROVIDER` discriminator. No provider is hardcoded
 * here, and no credentials/tokens are read, returned, or logged by this layer.
 *
 * Only credential-less adapters ship today (adapter-ready, testable/mockable):
 *   - `noop`   — never sends a real message; returns a synthetic reference,
 *   - `capture` — never contacts anything; additionally records every send
 *     input in memory for deterministic local/test validation.
 *
 * PART 01 result extension (additive, governance §3.2): `retryable` (the
 * adapter's classification hint for a FAILED outcome) and `providerMessageId`
 * (the normalized provider message id; supersedes the free-text
 * `providerReference`, which stays for compatibility). The shared taxonomy in
 * `src/shared/provider-result.ts` normalizes results into lifecycle outcomes.
 */

export type WhatsAppSendInput = {
  /** Recipient phone number (E.164-ish, already validated). */
  to: string;
  /** Rendered message body (WhatsApp has no separate subject line). */
  message: string;
  /**
   * CR-BE-NOTIFY-PROV-01 PART 06 (additive) — the BE-26B template that
   * rendered the message, when known. Provider adapters that require
   * pre-approved templates (e.g. the Meta WhatsApp Business Cloud API for
   * business-initiated sends) map this key to the approved provider
   * template; adapters without that requirement (noop/capture) ignore it.
   */
  templateKey?: string | null;
};

export type WhatsAppSendResult = {
  status: 'SENT' | 'FAILED';
  /** Provider response id/reference where available (free-text, legacy). */
  providerReference?: string | null;
  /**
   * Normalized provider message id where available (CR-BE-NOTIFY-PROV-01
   * PART 01). Supersedes `providerReference`; the delivery service persists
   * it in the existing `provider_reference` column (no schema change).
   */
  providerMessageId?: string | null;
  /** Sanitized failure message (must never contain credentials/tokens). */
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

export interface WhatsAppAdapter {
  /** Stable provider discriminator (recorded on the delivery). */
  readonly provider: string;
  send(input: WhatsAppSendInput): Promise<WhatsAppSendResult>;
}

/**
 * Credential-less no-op adapter. Never sends a real message. Its constructor
 * outcome lets tests (and future wiring) simulate SENT or FAILED responses.
 */
export class NoopWhatsAppAdapter implements WhatsAppAdapter {
  readonly provider = 'noop';

  constructor(private readonly outcome: 'sent' | 'fail' = 'sent') {}

  async send(_input: WhatsAppSendInput): Promise<WhatsAppSendResult> {
    if (this.outcome === 'fail') {
      return {
        status: 'FAILED',
        error: 'Simulated WhatsApp provider failure (noop adapter).',
        sentAt: new Date(),
      };
    }
    return {
      status: 'SENT',
      providerReference: `wa-noop-${randomUUID()}`,
      sentAt: new Date(),
    };
  }
}

/** Simulated capture outcomes: success, permanent failure, retryable failure. */
export type CaptureWhatsAppAdapterOutcome =
  | 'sent'
  | 'fail'
  | 'fail-permanent'
  | 'fail-retryable';

/** One captured send (payload + synthetic provider reference), in send order. */
export type CapturedWhatsAppSend = WhatsAppSendInput & {
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
export class CaptureWhatsAppAdapter implements WhatsAppAdapter {
  readonly provider = 'capture';

  private readonly sent: CapturedWhatsAppSend[] = [];

  constructor(private readonly outcome: CaptureWhatsAppAdapterOutcome = 'sent') {}

  /** Snapshot of the payloads captured so far (successful sends only). */
  get captures(): readonly CapturedWhatsAppSend[] {
    return [...this.sent];
  }

  async send(input: WhatsAppSendInput): Promise<WhatsAppSendResult> {
    const sentAt = new Date();
    if (this.outcome !== 'sent') {
      return {
        status: 'FAILED',
        error: 'Simulated WhatsApp provider failure (capture adapter).',
        retryable: this.outcome === 'fail-retryable',
        sentAt,
      };
    }
    const providerMessageId = `wa-capture-${randomUUID()}`;
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
export const CREDENTIAL_LESS_WHATSAPP_PROVIDERS = ['noop', 'capture'] as const;

/** All implemented WhatsApp provider discriminators (fail-fast messages). */
export const AVAILABLE_WHATSAPP_PROVIDERS = ['noop', 'capture', 'meta'] as const;

/**
 * Selects the configured WhatsApp adapter. Implemented providers: the
 * credential-less `noop` / `capture` adapters and the real `meta` adapter
 * (CR-BE-NOTIFY-PROV-01 PART 06; its credentials are read at the adapter
 * construction boundary, never here). Any other provider fails fast with a
 * ConfigError (no silent fallback to a different provider). In the test
 * environment only credential-less providers may resolve, so a real provider
 * can never be contacted by tests.
 */
export function resolveWhatsAppAdapter(): WhatsAppAdapter {
  const config = getAppConfig();
  const { provider } = config.whatsapp;
  if (provider === 'noop') {
    return new NoopWhatsAppAdapter();
  }
  if (provider === 'capture') {
    return new CaptureWhatsAppAdapter();
  }
  if (config.isTest) {
    throw new ConfigError(
      `Invalid configuration: WHATSAPP_PROVIDER '${provider}' cannot be resolved in the test environment (credential-less providers only: ${CREDENTIAL_LESS_WHATSAPP_PROVIDERS.join(', ')}).`,
    );
  }
  if (provider === 'meta') {
    return new MetaWhatsAppAdapter();
  }
  throw new ConfigError(
    `Invalid configuration: no WhatsApp adapter is implemented for WHATSAPP_PROVIDER '${provider}' (available: ${AVAILABLE_WHATSAPP_PROVIDERS.join(', ')}).`,
  );
}
