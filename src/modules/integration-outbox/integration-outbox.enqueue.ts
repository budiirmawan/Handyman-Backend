import type { Pool, PoolClient } from 'pg';
import type { OperationalEventRecord } from '../operational-events';
import { readIntegrationOutboxConfig } from './integration-outbox.config';
import {
  buildIntegrationOutboxPayload,
  serializeIntegrationOutboxPayload,
} from './integration-outbox.payload';
import { integrationOutboxRepository } from './integration-outbox.repository';
import {
  isIntegrationOutboxBlockedEventType,
  type IntegrationOutboxEventRecord,
} from './integration-outbox.types';

/**
 * CR-BE-INTEG-01 PART 01 — prospective outbox enqueue seam.
 *
 * Called by `recordOperationalEvent` AFTER the authoritative event insert, on
 * the SAME executor the domain passed in — when the domain runs inside
 * `withTransaction`, event + outbox commit or roll back atomically (the
 * transactional-outbox guarantee, governance §2.3). Enqueue failures
 * propagate: atomicity is the point.
 *
 * The gate (ALL must hold, in order — each stage cheaper than the next):
 *
 *   1. `INTEGRATION_WEBHOOKS_ENABLED` is true (dark by default),
 *   2. the event type is NOT recursion-blocked (`INTEGRATION_*`,
 *      `NOTIFICATION_OUTBOUND_*`),
 *   3. the registered subscription probe confirms at least one ACTIVE
 *      endpoint of this Client subscribed to this event type.
 *
 * PART 01 ships a CONSERVATIVE default probe that always answers false — the
 * webhook endpoint authority does not exist yet (PART 02), so no production
 * enqueue can happen even with the flag on. PART 02/03 registers the real
 * `SELECT EXISTS` probe. This gate is also what makes rollout prospective
 * (governance §12): outbox rows are only ever created at event-record time,
 * never by scanning history — historical events can never fan out.
 */

/** Any executor: the pool, or the caller's open transaction client. */
type Q = Pick<Pool | PoolClient, 'query'>;

/**
 * Answers whether at least one ACTIVE webhook endpoint of `clientId` is
 * subscribed to `eventType`. Runs on the caller's executor so PART 02's
 * `SELECT EXISTS` probe participates in the surrounding transaction.
 */
export type IntegrationOutboxSubscriptionProbe = (
  event: { clientId: string; eventType: string },
  executor: Q,
) => Promise<boolean>;

/** PART 01 default: no endpoint authority exists yet — never enqueue. */
const NO_SUBSCRIBERS_PROBE: IntegrationOutboxSubscriptionProbe = async () => false;

let activeProbe: IntegrationOutboxSubscriptionProbe = NO_SUBSCRIBERS_PROBE;

/** Registers the real subscription probe (PART 02/03 wiring; tests). */
export function registerIntegrationOutboxSubscriptionProbe(
  probe: IntegrationOutboxSubscriptionProbe,
): void {
  activeProbe = probe;
}

/** Restores the conservative default probe (test isolation). */
export function resetIntegrationOutboxSubscriptionProbe(): void {
  activeProbe = NO_SUBSCRIBERS_PROBE;
}

/**
 * Enqueues one outbox row for a just-recorded operational event when the
 * full gate passes; returns the row, or null when any gate stage declined.
 * Creation is idempotent on the unique `operational_event_id` reference.
 */
export async function maybeEnqueueIntegrationOutboxEvent(
  event: OperationalEventRecord,
  executor: Q,
): Promise<IntegrationOutboxEventRecord | null> {
  if (!readIntegrationOutboxConfig().enabled) {
    return null;
  }
  if (isIntegrationOutboxBlockedEventType(event.event_type)) {
    return null;
  }
  if (
    !(await activeProbe(
      { clientId: event.client_id, eventType: event.event_type },
      executor,
    ))
  ) {
    return null;
  }

  const payload = serializeIntegrationOutboxPayload(
    buildIntegrationOutboxPayload(event),
  );

  const { record } = await integrationOutboxRepository.createOnConflictReturn(
    {
      operationalEventId: event.id,
      clientId: event.client_id,
      buildingId: event.building_id,
      eventType: event.event_type,
      entityType: event.entity_type,
      entityId: event.entity_id,
      payload,
      occurredAt: new Date(event.occurred_at),
    },
    executor,
  );
  return record;
}
