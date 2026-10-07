import { PUSH_PAYLOAD_LIMITS } from '../push-delivery';
import type { OutboundDeliveryRecord } from '../notification-outbound-deliveries';

/**
 * CR-BE-PUSH-01 PART 03B — the safe, pointer-only push payload builder.
 *
 * GOVERNANCE: docs/CR-BE-PUSH-01_START_GOVERNANCE.md §9.
 *
 * A push payload is a NOTIFICATION POINTER, NOT A DATA CHANNEL. Push payloads
 * traverse Google/Apple infrastructure, are cached on-device outside app
 * control, and are rendered on lock screens. The app is expected to fetch
 * authoritative content over the authenticated API using `data.entityId`; the
 * push only says *what changed*.
 *
 * THE ALLOW-LIST IS CONSTRUCTED, NEVER FILTERED
 * ---------------------------------------------
 * §9 requires "an explicit whitelist builder, not a spread of the intent
 * metadata". This module therefore assigns every key by name from a named
 * source field. There is no spread, no `Object.assign`, no loop over record
 * keys, and no pass-through of caller-supplied maps. A field that is not
 * written here cannot reach a provider, so adding a sensitive column to the
 * ledger tomorrow cannot silently leak into a payload.
 *
 * FORBIDDEN WITHOUT EXCEPTION (§9): monetary amounts, invoice/PO/quotation
 * figures, salary or payroll data, tenant financial data, credentials, tokens,
 * secure-link tokens, session identifiers, personal contact details (email or
 * phone), evidence file contents or signed URLs, any FX/finance figure, and
 * any free-text not produced by an approved template.
 *
 * NO DEEP-LINK INVENTION
 * ----------------------
 * No `url`, `link`, `click_action`, `deeplink` or route string is emitted.
 * No such value exists in the ledger, and synthesising one here would be the
 * backend inventing a client-side navigation contract it does not own. The
 * app routes from `entityType` + `entityId`, which it already understands.
 *
 * NOTE ON `recipient_address`: it is deliberately NEVER copied into a payload.
 * For PUSH it is `user:<userId>` — an internal recipient reference, not
 * content — and for the other channels it is a personal email address or
 * phone number, exactly the class §9 forbids.
 */

/**
 * The ONLY `data` keys a push payload may carry (§9). Exported so the
 * boundary guards can assert the emitted key set against it exactly.
 */
export const PUSH_PAYLOAD_DATA_KEYS = [
  'notificationId',
  'eventType',
  'entityType',
  'entityId',
  'deliveryId',
] as const;

export type PushPayloadDataKey = (typeof PUSH_PAYLOAD_DATA_KEYS)[number];

/** §9 bound for `data.entityType`. */
const ENTITY_TYPE_MAX_LENGTH = 64;

/** §9 bound for `data.eventType`. */
const EVENT_TYPE_MAX_LENGTH = 128;

/**
 * The rendered pointer. `body` is nullable because a template may render a
 * title-only notification; it is never padded with invented text.
 */
export type PushPointerPayload = {
  title: string;
  body: string | null;
  data: Partial<Record<PushPayloadDataKey, string>>;
};

export type BuildPushPointerPayloadOptions = {
  /**
   * The BE-26A in-app notification id, when the caller has one. §9 lists it
   * as conditional ("if one exists"). The PUSH ledger row carries no linkage
   * to a BE-26A notification today, so the key is OMITTED rather than
   * fabricated — a payload must never assert an id the backend cannot honour.
   */
  notificationId?: string | null;
};

/**
 * Collapses whitespace and truncates to `max` characters, appending a single
 * ellipsis when content was actually removed. The result is ALWAYS `<= max`
 * (the ellipsis is counted, not added on top of the bound).
 */
function clampText(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) {
    return collapsed;
  }
  // Reserve one character for the ellipsis so the bound is never exceeded.
  return `${collapsed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * Derives the notification title from the rendered content snapshot.
 *
 * EMAIL rows carry a rendered subject. PUSH rows do not (PART 03A sets
 * `subject = null`: a push title is a presentation concern derived at send
 * time). The title therefore falls back to the FIRST SENTENCE of the rendered
 * body — still template-produced text, never invented copy and never a
 * hardcoded string like "New notification".
 */
function deriveTitle(record: OutboundDeliveryRecord): string {
  const subject = record.subject?.trim();
  if (subject && subject.length > 0) {
    return clampText(subject, PUSH_PAYLOAD_LIMITS.titleMaxLength);
  }

  const message = record.message.replace(/\s+/g, ' ').trim();
  // First sentence boundary, when one falls inside the title bound.
  const sentenceEnd = message.search(/[.!?](\s|$)/);
  if (sentenceEnd > 0 && sentenceEnd + 1 <= PUSH_PAYLOAD_LIMITS.titleMaxLength) {
    return message.slice(0, sentenceEnd + 1);
  }
  return clampText(message, PUSH_PAYLOAD_LIMITS.titleMaxLength);
}

/**
 * Builds the §9 pointer payload for ONE ledger row.
 *
 * Pure: no I/O, no database, no provider contact, no token access. The same
 * payload is delivered to every one of the recipient's devices — it is a
 * property of the notification, never of the device.
 */
export function buildPushPointerPayload(
  record: OutboundDeliveryRecord,
  options: BuildPushPointerPayloadOptions = {},
): PushPointerPayload {
  const title = deriveTitle(record);
  const body = clampText(record.message, PUSH_PAYLOAD_LIMITS.bodyMaxLength);

  // Explicit, key-by-key construction. Do NOT convert this into a spread or a
  // loop over record fields — that is precisely what §9 forbids.
  const data: Partial<Record<PushPayloadDataKey, string>> = {};

  const notificationId = options.notificationId?.trim();
  if (notificationId) {
    data.notificationId = notificationId;
  }

  data.eventType = clampText(record.sourceEventType, EVENT_TYPE_MAX_LENGTH);
  data.entityType = clampText(record.sourceEntityType, ENTITY_TYPE_MAX_LENGTH);
  data.entityId = record.sourceEntityId;
  // Correlation id: the ledger row this send belongs to. Always available
  // here, and the value that ties a provider result back to the ledger.
  data.deliveryId = record.id;

  return {
    title,
    // A title-only notification keeps a null body rather than repeating the
    // title or inventing filler.
    body: body.length > 0 && body !== title ? body : null,
    data,
  };
}
