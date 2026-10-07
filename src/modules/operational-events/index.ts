import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import { getRequestContext } from '../../shared/request-context';
import { maybeEnqueueIntegrationOutboxEvent } from '../integration-outbox';

export const OPERATIONAL_EVENT_SOURCES = [
  'HTTP',
  'SCHEDULER',
  'SYSTEM',
] as const;

export type OperationalEventSource =
  (typeof OPERATIONAL_EVENT_SOURCES)[number];

/**
 * Explicit correlation is intentionally limited to non-HTTP execution. PART
 * 03 uses this internal seam for trusted scheduler/system work; an active HTTP
 * context always wins and cannot be replaced by this argument.
 */
export type OperationalEventCorrelationOverride = Readonly<{
  requestId: string;
  source: Exclude<OperationalEventSource, 'HTTP'>;
}>;

export type OperationalEventInput = {
  /**
   * Customer scope of the event. Required for business-plane events.
   *
   * CR-BE-SAAS-01 PART 01 (frozen decision D1): optional for platform-scope
   * SaaS Control Plane events (product catalog, pricebook, platform
   * configuration, support sessions) which have no customer. Platform-scope
   * events skip integration-outbox fan-out (the outbox is customer-scoped).
   */
  clientId?: string | null;
  eventType: string;
  entityType: string;
  entityId: string;
  actorUserId?: string | null;
  buildingId?: string | null;
  /** Optional BE-15K link: the Vendor Work this event belongs to (if any). */
  vendorWorkId?: string | null;
  summary: string;
  metadata?: Record<string, unknown>;
};

/** Keys never persisted — credentials, tokens, and sensitive payloads. */
const SENSITIVE_KEYS = [
  'password',
  'passwordHash',
  'credentials',
  'token',
  'accessToken',
  'refreshToken',
  'authorization',
  'sessionToken',
  'rawEvidence',
  'secret',
  'apiKey',
];

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The raw persisted shape of an operational event row. */
export type OperationalEventRecord = {
  id: string;
  client_id: string;
  event_type: string;
  entity_type: string;
  entity_id: string;
  actor_user_id: string | null;
  building_id: string | null;
  vendor_work_id: string | null;
  request_id: string | null;
  source: OperationalEventSource | null;
  summary: string;
  metadata: Record<string, unknown>;
  occurred_at: Date;
  created_at: Date;
};

type OperationalEventCorrelation = {
  requestId: string | null;
  source: OperationalEventSource | null;
};

function resolveCorrelation(
  override?: OperationalEventCorrelationOverride,
): OperationalEventCorrelation {
  const requestContext = getRequestContext();

  // The HTTP context is authoritative. This also means a normal HTTP caller
  // cannot replace the request ID by passing an internal override argument.
  if (requestContext) {
    return {
      requestId: requestContext.requestId,
      source: requestContext.source,
    };
  }

  // No context is a valid legacy/standalone execution and remains nullable.
  if (!override) {
    return { requestId: null, source: null };
  }

  if (!UUID_PATTERN.test(override.requestId)) {
    throw new TypeError('Operational event correlation requestId must be a UUID.');
  }
  const overrideSource = override.source as string;
  if (
    !(OPERATIONAL_EVENT_SOURCES as readonly string[]).includes(overrideSource) ||
    overrideSource === 'HTTP'
  ) {
    throw new TypeError(
      'Operational event correlation override must use SCHEDULER or SYSTEM.',
    );
  }

  return {
    requestId: override.requestId,
    source: override.source,
  };
}

/**
 * Records an append-only operational event on the shared BE-07
 * `operational_events` table. Metadata is scrubbed of sensitive keys before
 * persistence; events are never updated or deleted through this helper.
 *
 * CR-BE-AUDIT-01 PART 02: correlation is resolved centrally. HTTP events read
 * the authoritative PART 01 AsyncLocalStorage context. An explicit override
 * is accepted only outside HTTP for the governed PART 03 scheduler/system
 * seam; standalone events remain valid with nullable correlation fields.
 *
 * CR-BE-INTEG-01 PART 01: after the authoritative insert, the gated
 * integration-outbox enqueue seam runs on the SAME executor — inside a
 * caller's transaction, event + outbox commit or roll back atomically.
 * Dark by default (`INTEGRATION_WEBHOOKS_ENABLED=false`) the seam is a
 * no-op; `operational_events` remains the only business-event authority.
 */
export async function recordOperationalEvent(
  input: OperationalEventInput,
  executor: Pick<PoolClient, 'query'> = getPool(),
  correlation?: OperationalEventCorrelationOverride,
): Promise<OperationalEventRecord> {
  const safe = { ...(input.metadata ?? {}) };
  for (const key of SENSITIVE_KEYS) {
    delete safe[key];
  }

  const { requestId, source } = resolveCorrelation(correlation);
  const result = await executor.query<OperationalEventRecord>(
    `INSERT INTO operational_events
       (id, client_id, event_type, entity_type, entity_id, actor_user_id,
        building_id, vendor_work_id, request_id, source, summary, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      randomUUID(),
      input.clientId ?? null,
      input.eventType,
      input.entityType,
      input.entityId,
      input.actorUserId ?? null,
      input.buildingId ?? null,
      input.vendorWorkId ?? null,
      requestId,
      source,
      input.summary,
      safe,
    ],
  );

  const record = result.rows[0];
  // CR-BE-SAAS-01 PART 01 — the integration outbox is customer-scoped
  // (NOT NULL customer FK). Platform-scope events (NULL client) are recorded
  // in the canonical store only and never fan out.
  if (record.client_id) {
    await maybeEnqueueIntegrationOutboxEvent(record, executor);
  }
  return record;
}
