import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  CreateIntegrationWebhookEndpointInput,
  IntegrationWebhookEndpointFilters,
  IntegrationWebhookEndpointRecord,
  UpdateIntegrationWebhookEndpointInput,
} from './integration-webhook-endpoint.types';
import { INTEGRATION_WEBHOOK_TIMEOUT_DEFAULT_MS } from './integration-webhook-endpoint.types';

/**
 * CR-BE-INTEG-01 PART 02 — webhook endpoint repository.
 *
 * SECRET READ BOUNDARY (governance §3.2): the standard projection
 * (`PUBLIC_COLUMNS`) NEVER selects `signing_secret`. The secret is written at
 * create/rotate (each returning it exactly once through a dedicated seam) and
 * is otherwise only readable through `findSigningSecretById` — the signing
 * path seam reserved for the PART 04 HMAC adapter. No list/detail/update seam
 * can leak it.
 */

/** Any executor: the pool, or the caller's open transaction client. */
type Q = Pick<Pool | PoolClient, 'query'>;

const PUBLIC_COLUMNS = `id,
  client_id AS "clientId",
  building_id AS "buildingId",
  name,
  url,
  event_types AS "eventTypes",
  status,
  secret_rotated_at AS "secretRotatedAt",
  timeout_ms AS "timeoutMs",
  created_at AS "createdAt",
  updated_at AS "updatedAt"`;

/** Inserts one endpoint; the (already generated) secret is write-only here. */
async function create(
  input: CreateIntegrationWebhookEndpointInput & { signingSecret: string },
  q: Q = getPool(),
): Promise<IntegrationWebhookEndpointRecord> {
  const result = await q.query<IntegrationWebhookEndpointRecord>(
    `INSERT INTO integration_webhook_endpoints (
       id, client_id, building_id, name, url, event_types,
       status, signing_secret, timeout_ms
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${PUBLIC_COLUMNS}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId ?? null,
      input.name,
      input.url,
      input.eventTypes,
      input.status ?? 'ACTIVE',
      input.signingSecret,
      input.timeoutMs ?? INTEGRATION_WEBHOOK_TIMEOUT_DEFAULT_MS,
    ],
  );
  return result.rows[0];
}

/** Secret-free read by id. */
async function findById(
  id: string,
  q: Q = getPool(),
): Promise<IntegrationWebhookEndpointRecord | null> {
  const result = await q.query<IntegrationWebhookEndpointRecord>(
    `SELECT ${PUBLIC_COLUMNS} FROM integration_webhook_endpoints WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/**
 * Secret-free list, ALWAYS bounded to an explicit accessible-Client set —
 * an empty set returns nothing (isolation is structural, never optional).
 */
async function listForClients(
  accessibleClientIds: readonly string[],
  filters: IntegrationWebhookEndpointFilters,
  q: Q = getPool(),
): Promise<IntegrationWebhookEndpointRecord[]> {
  const result = await q.query<IntegrationWebhookEndpointRecord>(
    `SELECT ${PUBLIC_COLUMNS}
       FROM integration_webhook_endpoints
      WHERE client_id = ANY($1::uuid[])
        AND ($2::uuid IS NULL OR client_id = $2)
        AND ($3::text IS NULL OR status = $3)
        AND ($4::text IS NULL OR $4 = ANY(event_types))
      ORDER BY created_at ASC, id ASC`,
    [
      accessibleClientIds,
      filters.clientId ?? null,
      filters.status ?? null,
      filters.eventType ?? null,
    ],
  );
  return result.rows;
}

/** Partial config update (never the secret — unrepresentable in the input). */
async function update(
  id: string,
  input: UpdateIntegrationWebhookEndpointInput,
  q: Q = getPool(),
): Promise<IntegrationWebhookEndpointRecord | null> {
  const result = await q.query<IntegrationWebhookEndpointRecord>(
    `UPDATE integration_webhook_endpoints
        SET name = COALESCE($2, name),
            url = COALESCE($3, url),
            event_types = COALESCE($4, event_types),
            status = COALESCE($5, status),
            timeout_ms = COALESCE($6, timeout_ms),
            updated_at = NOW()
      WHERE id = $1
      RETURNING ${PUBLIC_COLUMNS}`,
    [
      id,
      input.name ?? null,
      input.url ?? null,
      input.eventTypes ?? null,
      input.status ?? null,
      input.timeoutMs ?? null,
    ],
  );
  return result.rows[0] ?? null;
}

/** Replaces the signing secret (rotation). Secret-free row returned. */
async function rotateSecret(
  id: string,
  signingSecret: string,
  q: Q = getPool(),
): Promise<IntegrationWebhookEndpointRecord | null> {
  const result = await q.query<IntegrationWebhookEndpointRecord>(
    `UPDATE integration_webhook_endpoints
        SET signing_secret = $2, secret_rotated_at = NOW(), updated_at = NOW()
      WHERE id = $1
      RETURNING ${PUBLIC_COLUMNS}`,
    [id, signingSecret],
  );
  return result.rows[0] ?? null;
}

/**
 * SIGNING-PATH-ONLY secret read (PART 04 HMAC adapter). Never composed into
 * any API response, log, audit metadata, or list projection.
 */
async function findSigningSecretById(
  id: string,
  q: Q = getPool(),
): Promise<string | null> {
  const result = await q.query<{ signingSecret: string }>(
    `SELECT signing_secret AS "signingSecret"
       FROM integration_webhook_endpoints
      WHERE id = $1`,
    [id],
  );
  return result.rows[0]?.signingSecret ?? null;
}

/**
 * The PART 01 enqueue-gate probe (governance §2.3 stage 3): does at least one
 * ACTIVE endpoint of this Client subscribe to this event type? Runs on the
 * caller's executor so it participates in the surrounding domain transaction.
 */
async function hasActiveSubscription(
  clientId: string,
  eventType: string,
  q: Q = getPool(),
): Promise<boolean> {
  const result = await q.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM integration_webhook_endpoints
        WHERE client_id = $1
          AND status = 'ACTIVE'
          AND UPPER($2) = ANY(event_types)
     ) AS exists`,
    [clientId, eventType],
  );
  return result.rows[0]?.exists === true;
}

/**
 * The PART 03 fan-out matching seam (governance §7): the SECRET-FREE minimal
 * shape of every endpoint one outbox event must be delivered to. ALL five
 * predicate rules are structural, in SQL:
 *
 *   1. same Client (cross-Client delivery impossible — no wildcard endpoints),
 *   2. Building narrowing: NULL endpoint scope matches everything of the
 *      Client; a Building-scoped endpoint matches only that Building (and
 *      never a Client-level event with no Building),
 *   3. subscribed event type,
 *   4. ACTIVE only,
 *   5. `created_at <= notAfter` (the outbox row's created_at) — an endpoint
 *      created AFTER an event never receives it (prospective boundary, §12).
 */
async function findMatchingForFanOut(
  clientId: string,
  buildingId: string | null,
  eventType: string,
  notAfter: Date,
  q: Q = getPool(),
): Promise<{ id: string }[]> {
  const result = await q.query<{ id: string }>(
    `SELECT id
       FROM integration_webhook_endpoints
      WHERE client_id = $1
        AND (building_id IS NULL OR building_id = $2)
        AND UPPER($3) = ANY(event_types)
        AND status = 'ACTIVE'
        AND created_at <= $4
      ORDER BY created_at ASC, id ASC`,
    [clientId, buildingId, eventType, notAfter],
  );
  return result.rows;
}

export const integrationWebhookEndpointRepository = {
  create,
  findById,
  listForClients,
  update,
  rotateSecret,
  findSigningSecretById,
  hasActiveSubscription,
  findMatchingForFanOut,
};
