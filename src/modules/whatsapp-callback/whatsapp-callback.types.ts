/**
 * CR-BE-NOTIFY-PROV-01 PART 07 — Meta WhatsApp callback types.
 *
 * The inbound surface for Meta WhatsApp Business Cloud API delivery
 * feedback (governance §9): provider-signature-authenticated, never
 * user-session/RBAC authenticated, delivery-status-only (no domain state).
 */

/** Boundary configuration, read at router construction only. */
export type WhatsAppCallbackConfig = {
  enabled: boolean;
  /** HMAC-SHA256 key for X-Hub-Signature-256 verification. */
  appSecret: string;
  /** Shared token for Meta's GET subscription handshake. */
  verifyToken: string;
};

/** One Meta status update inside the webhook envelope. */
export type MetaWhatsAppStatusUpdate = {
  /** The provider message id (wamid) this feedback is about. */
  id?: unknown;
  /** Recipient phone (digits only) — secondary consistency data. */
  recipient_id?: unknown;
  /** sent | delivered | read | failed. */
  status?: unknown;
  /** Unix seconds as a string. */
  timestamp?: unknown;
  /** Present on `failed` statuses. */
  errors?: Array<{ code?: unknown; message?: unknown }>;
};

/** The Meta `whatsapp_business_account` webhook envelope (subset we read). */
export type MetaWhatsAppWebhookPayload = {
  object?: unknown;
  entry?: Array<{
    id?: unknown;
    changes?: Array<{
      field?: unknown;
      value?: {
        messaging_product?: unknown;
        statuses?: MetaWhatsAppStatusUpdate[];
      };
    }>;
  }>;
};

/** Aggregate of one callback processing pass. */
export type WhatsAppCallbackProcessingResult = {
  /** Status updates present in the payload. */
  statuses: number;
  /** Feedback transitions actually applied (first accepted feedback only). */
  applied: number;
  /**
   * Safe no-ops: `sent`/unknown statuses, unknown provider message ids,
   * non-SENT rows, and duplicate/out-of-order feedback.
   */
  skipped: number;
};
