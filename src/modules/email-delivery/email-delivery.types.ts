/**
 * BE-26F — Email delivery types.
 *
 * The email delivery attempt record: recipient email, rendered subject/body
 * (from a BE-26B template), delivery status, sent_at, provider reference,
 * and failure/error status. Adapter-ready; no provider-specific logic.
 */

export const EMAIL_DELIVERY_STATUSES = ['SENT', 'FAILED'] as const;
export type EmailDeliveryStatus = (typeof EMAIL_DELIVERY_STATUSES)[number];

export function isEmailDeliveryStatus(value: unknown): value is EmailDeliveryStatus {
  return (
    typeof value === 'string' &&
    (EMAIL_DELIVERY_STATUSES as readonly string[]).includes(value)
  );
}

/** The raw persisted shape of an email delivery attempt row. */
export type EmailDeliveryRecord = {
  id: string;
  clientId: string;
  recipientUserId: string;
  recipientEmail: string;
  templateKey: string | null;
  subject: string;
  body: string | null;
  status: EmailDeliveryStatus;
  provider: string;
  providerReference: string | null;
  errorMessage: string | null;
  sentAt: Date | null;
  /**
   * CR-BE-NOTIFY-PROV-01 PART 02/04 — the outbound delivery ledger row this
   * attempt belongs to (migration 0299). NULL for attempts recorded outside
   * the ledger (the pre-PART-02 noop era and adapter-injected sends).
   */
  deliveryId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicEmailDelivery = Omit<
  EmailDeliveryRecord,
  'sentAt' | 'createdAt' | 'updatedAt'
> & {
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Fully-resolved data ready for persistence. */
export type NewEmailDelivery = {
  clientId: string;
  recipientUserId: string;
  recipientEmail: string;
  templateKey: string | null;
  subject: string;
  body: string | null;
  status: EmailDeliveryStatus;
  provider: string;
  providerReference: string | null;
  errorMessage: string | null;
  sentAt: Date | null;
  /** Optional ledger linkage (CR-BE-NOTIFY-PROV-01 PART 04). */
  deliveryId?: string | null;
};

/**
 * Input for sending a templated email to a resolved recipient user.
 * `clientId` carries the event/subscription context for Client isolation.
 */
export type SendTemplateEmailInput = {
  clientId: string;
  recipientUserId: string;
  templateKey: string;
  variables?: Record<string, string | number>;
};
