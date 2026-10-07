/**
 * BE-26G — WhatsApp delivery types.
 *
 * The WhatsApp delivery attempt record: recipient phone number, rendered
 * message (from a BE-26B template), delivery status, sent_at, provider
 * reference, and failure/error status. Adapter-ready; no provider-specific
 * logic.
 */

export const WHATSAPP_DELIVERY_STATUSES = ['SENT', 'FAILED'] as const;
export type WhatsAppDeliveryStatus = (typeof WHATSAPP_DELIVERY_STATUSES)[number];

export function isWhatsAppDeliveryStatus(
  value: unknown,
): value is WhatsAppDeliveryStatus {
  return (
    typeof value === 'string' &&
    (WHATSAPP_DELIVERY_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * CR-BE-NOTIFY-PROV-01 PART 06 — strict authoritative E.164 WhatsApp number
 * (leading '+', 7–15 digits, no leading zero). Used for the persisted User
 * contact authority (`users.whatsapp_phone`); the delivery service's own
 * input validation stays more permissive.
 */
export const WHATSAPP_E164_PHONE_PATTERN = /^\+[1-9][0-9]{6,14}$/;

export function isWhatsAppE164Phone(value: unknown): value is string {
  return typeof value === 'string' && WHATSAPP_E164_PHONE_PATTERN.test(value);
}

/** The raw persisted shape of a WhatsApp delivery attempt row. */
export type WhatsAppDeliveryRecord = {
  id: string;
  clientId: string;
  recipientUserId: string;
  recipientPhone: string;
  templateKey: string | null;
  messageBody: string;
  status: WhatsAppDeliveryStatus;
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
export type PublicWhatsAppDelivery = Omit<
  WhatsAppDeliveryRecord,
  'sentAt' | 'createdAt' | 'updatedAt'
> & {
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Fully-resolved data ready for persistence. */
export type NewWhatsAppDelivery = {
  clientId: string;
  recipientUserId: string;
  recipientPhone: string;
  templateKey: string | null;
  messageBody: string;
  status: WhatsAppDeliveryStatus;
  provider: string;
  providerReference: string | null;
  errorMessage: string | null;
  sentAt: Date | null;
  /** Optional ledger linkage (CR-BE-NOTIFY-PROV-01 PART 04). */
  deliveryId?: string | null;
};

/**
 * Input for sending a templated WhatsApp message to a resolved recipient
 * user. `recipientPhone` is the already-resolved phone number (BE-26C
 * resolves the user; the caller supplies the phone from the authoritative
 * contact source). `clientId` carries the event/subscription context for
 * Client isolation.
 */
export type SendTemplateWhatsAppInput = {
  clientId: string;
  recipientUserId: string;
  recipientPhone: string;
  templateKey: string;
  variables?: Record<string, string | number>;
};
