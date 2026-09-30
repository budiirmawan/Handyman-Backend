import type { Pool, PoolClient } from 'pg';
import { AppError } from '../../shared/errors';
import {
  recordOperationalEvent,
  type OperationalEventCorrelationOverride,
  type OperationalEventRecord,
} from '../operational-events';
import {
  handymanAuditContractFor,
  isHandymanEntityType,
} from './handyman-audit-contract';

/**
 * CR-HM-16 PART 03 — Handyman event recording seam (governance
 * `docs/handyman/CR-HM-16_START_GOVERNANCE.md` §7 seam 3, §9 PART 03 row).
 *
 * WHAT THIS OWNS
 * --------------
 * The single admission point that binds an admitted Handyman event to the
 * EXISTING audit/event seam. It validates the event against the frozen audit
 * contract (fail-closed: anything not admitted is rejected and records
 * nothing), enforces the Handyman entity firewall, then delegates to
 * `recordOperationalEvent` — the single business-event/audit authority — on
 * the caller's executor so the event commits (or rolls back) atomically with
 * the business write. Correlation follows the audit context law: an active
 * HTTP request context is authoritative; trusted non-HTTP execution may pass
 * the SCHEDULER/SYSTEM override.
 *
 * WHAT THIS NEVER OWNS
 * --------------------
 * No second event log or audit store, no history rewrite (the append-only
 * authority rejects updates by construction), no manual injection surface
 * (this is a service seam, not an endpoint), no integration outbox logic —
 * the reused enqueue gate inside `recordOperationalEvent` decides fan-out
 * prospectively at record time. REACTIVE: recording an event never writes
 * Handyman lifecycle state.
 */

/** Any executor: the pool, or the caller's open transaction client. */
type Q = Pick<Pool | PoolClient, 'query'>;

/** An admitted Handyman event being recorded as an audit fact. */
export type HandymanOperationalEventInput = {
  eventType: string;
  /** Handyman subject or domain object identity (the `HANDYMAN_` namespace). */
  entityType: string;
  entityId: string;
  clientId: string;
  buildingId?: string | null;
  actorUserId?: string | null;
  summary: string;
  metadata?: Record<string, unknown>;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(details: { field: string; message: string }[]): never {
  throw AppError.validation('Request validation failed.', details);
}

/**
 * Records one admitted Handyman event through the reused audit seam.
 *
 * Fail-closed admission: an unknown event type, a non-Handyman entity
 * identity (FM/SaaS firewall), or a malformed subject records NOTHING.
 */
export async function recordHandymanEvent(
  input: HandymanOperationalEventInput,
  executor: Q,
  correlation?: OperationalEventCorrelationOverride,
): Promise<OperationalEventRecord> {
  const details: { field: string; message: string }[] = [];

  if (typeof input.eventType !== 'string' || !handymanAuditContractFor(input.eventType)) {
    details.push({
      field: 'eventType',
      message: 'eventType must be admitted by the Handyman audit contract.',
    });
  }
  if (typeof input.entityType !== 'string' || !isHandymanEntityType(input.entityType)) {
    details.push({
      field: 'entityType',
      message: 'entityType must be a Handyman entity (HANDYMAN_ namespace).',
    });
  }
  if (typeof input.entityId !== 'string' || !UUID_PATTERN.test(input.entityId)) {
    details.push({ field: 'entityId', message: 'entityId must be a valid UUID.' });
  }
  if (typeof input.clientId !== 'string' || !UUID_PATTERN.test(input.clientId)) {
    details.push({ field: 'clientId', message: 'clientId must be a valid UUID.' });
  }
  if (typeof input.summary !== 'string' || input.summary.trim().length === 0) {
    details.push({ field: 'summary', message: 'summary must be a non-empty string.' });
  }
  if (details.length > 0) {
    fail(details);
  }

  return recordOperationalEvent(
    {
      clientId: input.clientId,
      eventType: input.eventType,
      entityType: input.entityType,
      entityId: input.entityId,
      actorUserId: input.actorUserId ?? null,
      buildingId: input.buildingId ?? null,
      summary: input.summary,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    },
    executor,
    correlation,
  );
}
