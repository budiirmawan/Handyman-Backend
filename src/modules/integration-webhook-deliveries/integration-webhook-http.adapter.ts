/**
 * CR-BE-INTEG-01 PART 04 — outbound webhook HTTP adapter.
 *
 * HTTP POST with a bounded per-endpoint timeout (the meta-whatsapp-adapter
 * transport pattern: built-in fetch + AbortController, injectable transport
 * for tests — no external network in any test path) and the governance §6.4
 * response classification:
 *
 *   2xx                          → DELIVERED   (the ONLY success signal),
 *   408 / 425 / 429 / 5xx        → RETRYABLE,
 *   network error / timeout      → RETRYABLE   (no responseStatus),
 *   3xx (redirects NOT followed) → PERMANENT,
 *   other 4xx                    → PERMANENT.
 *
 * SANITIZATION: error strings are built from controlled parts only (status
 * codes, timeout values, error names) — never response bodies, request
 * headers, or secret material — then passed through a credential-redacting
 * truncation as defense in depth.
 */

export type IntegrationWebhookHttpRequest = {
  url: string;
  headers: Record<string, string>;
  /** The EXACT signed body bytes (the stored outbox payload TEXT verbatim). */
  body: string;
  timeoutMs: number;
};

export type IntegrationWebhookHttpResponse = {
  status: number;
};

/** Injectable transport seam (tests use mocks; production uses fetch). */
export type IntegrationWebhookTransport = (
  request: IntegrationWebhookHttpRequest,
) => Promise<IntegrationWebhookHttpResponse>;

/**
 * Production transport: built-in fetch, bounded timeout, redirects DISABLED
 * (`redirect: 'manual'` — a 3xx is returned as-is and classifies PERMANENT;
 * following redirects would reopen the §13 R6 SSRF surface). The response
 * body is intentionally not read: only the status code matters.
 */
export function createFetchIntegrationWebhookTransport(): IntegrationWebhookTransport {
  return async (
    request: IntegrationWebhookHttpRequest,
  ): Promise<IntegrationWebhookHttpResponse> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      const response = await fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        redirect: 'manual',
        signal: controller.signal,
      });
      return { status: response.status };
    } finally {
      clearTimeout(timer);
    }
  };
}

// ---------------------------------------------------------------------------
// Sanitization (defense in depth — inputs are already controlled parts)
// ---------------------------------------------------------------------------

const MAX_ERROR_LENGTH = 300;
const SECRET_PATTERN =
  /(whsec_[A-Za-z0-9_-]+|bearer\s+[A-Za-z0-9._~+/-]+=*|(password|passwd|pwd|secret|api[_-]?key|token|authorization|auth[_-]?token)\s*[:=]\s*[^,;"']+)/gi;

/** Redacts credential-like fragments and bounds length. */
export function sanitizeIntegrationWebhookError(message: string): string {
  const redacted = message.replace(SECRET_PATTERN, '[REDACTED]');
  return redacted.length > MAX_ERROR_LENGTH
    ? `${redacted.slice(0, MAX_ERROR_LENGTH)}…`
    : redacted;
}

// ---------------------------------------------------------------------------
// Send + classification
// ---------------------------------------------------------------------------

export const INTEGRATION_WEBHOOK_SEND_OUTCOMES = [
  'DELIVERED',
  'RETRYABLE',
  'PERMANENT',
] as const;
export type IntegrationWebhookSendOutcome =
  (typeof INTEGRATION_WEBHOOK_SEND_OUTCOMES)[number];

export type IntegrationWebhookSendResult = {
  outcome: IntegrationWebhookSendOutcome;
  /** HTTP status when a response was received; null for network/timeout. */
  responseStatus: number | null;
  /** Sanitized failure description; null on success. */
  error: string | null;
};

/** Governance §6.4: receiver 2xx is the only success signal. */
export function classifyIntegrationWebhookResponseStatus(
  status: number,
): IntegrationWebhookSendOutcome {
  if (status >= 200 && status < 300) {
    return 'DELIVERED';
  }
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return 'RETRYABLE';
  }
  // 3xx (not followed) and all other 4xx: retrying cannot help.
  return 'PERMANENT';
}

/**
 * Executes one POST attempt and classifies the result. Transport throws
 * (network error, abort/timeout) are RETRYABLE — never a silent loss, never
 * an unsanitized escape.
 */
export async function sendIntegrationWebhook(
  request: IntegrationWebhookHttpRequest,
  transport: IntegrationWebhookTransport,
): Promise<IntegrationWebhookSendResult> {
  try {
    const response = await transport(request);
    const outcome = classifyIntegrationWebhookResponseStatus(response.status);
    return {
      outcome,
      responseStatus: response.status,
      error:
        outcome === 'DELIVERED'
          ? null
          : sanitizeIntegrationWebhookError(`HTTP ${response.status}`),
    };
  } catch (error) {
    const isAbort = error instanceof Error && error.name === 'AbortError';
    const description = isAbort
      ? `Request timeout after ${request.timeoutMs}ms`
      : `Network error: ${error instanceof Error ? error.name : 'unknown'}`;
    return {
      outcome: 'RETRYABLE',
      responseStatus: null,
      error: sanitizeIntegrationWebhookError(description),
    };
  }
}
