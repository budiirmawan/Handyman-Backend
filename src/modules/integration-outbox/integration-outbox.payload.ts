import type { OperationalEventRecord } from '../operational-events';

/**
 * CR-BE-INTEG-01 PART 01 — canonical outbox payload envelope.
 *
 * The envelope (governance §2.4) is built from the AUTHORITATIVE
 * `operational_events` row returned by `recordOperationalEvent` — whose
 * metadata has already passed the BE-07 sensitive-key scrub — and is
 * serialized EXACTLY ONCE at enqueue time. The resulting string is stored as
 * TEXT and is the byte-stable body every future delivery attempt will send
 * and sign (governance §5): key order is fixed by construction here and
 * `JSON.stringify` preserves insertion order, so the same envelope always
 * produces the same bytes.
 *
 * Deliberately small: identity + summary + already-scrubbed metadata. No
 * aggregate bodies, no attachments, no credentials.
 */

/** The canonical envelope shape (fixed field order — do not reorder). */
export type IntegrationOutboxPayload = {
  id: string;
  type: string;
  occurredAt: string;
  clientId: string;
  buildingId: string | null;
  entity: { type: string; id: string };
  summary: string;
  metadata: Record<string, unknown>;
};

/** Builds the envelope from the authoritative operational event row. */
export function buildIntegrationOutboxPayload(
  event: OperationalEventRecord,
): IntegrationOutboxPayload {
  return {
    id: event.id,
    type: event.event_type,
    occurredAt: new Date(event.occurred_at).toISOString(),
    clientId: event.client_id,
    buildingId: event.building_id,
    entity: { type: event.entity_type, id: event.entity_id },
    summary: event.summary,
    metadata: event.metadata ?? {},
  };
}

/**
 * Serializes the envelope to its canonical byte-stable string. This is the
 * ONLY serialization point for outbox payloads — later PARTs must send and
 * sign the stored TEXT verbatim, never re-serialize.
 */
export function serializeIntegrationOutboxPayload(
  payload: IntegrationOutboxPayload,
): string {
  return JSON.stringify(payload);
}
