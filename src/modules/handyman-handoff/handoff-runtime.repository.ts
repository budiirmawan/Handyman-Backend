import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { getPool } from '../../database';
import type { ResolvedCareActorProvenance } from '../handyman-care-actors/handyman-care-actor.types';
import type {
  HandoffAssertionRecord,
  HandoffExchangeContextInput,
  HandoffExchangeRecord,
  HandoffIntegrationRecord,
} from './handoff-runtime.types';

/** Default to the shared pool; transactional callers pass a PoolClient. */
function executor(client?: PoolClient): Pool | PoolClient {
  return client ?? getPool();
}

/**
 * CR-HM-01 PART 03 — handoff runtime repositories.
 *
 * Trust metadata, append-only replay records (no update/delete functions),
 * and single-use exchanges. Exchange tokens are persisted hash-only.
 */

const INTEGRATION_SELECT = `id, integration_code AS "integrationCode",
  display_name AS "displayName", status,
  created_at AS "createdAt", updated_at AS "updatedAt"`;

async function createIntegration(input: {
  integrationCode: string;
  displayName: string;
  status?: 'ACTIVE' | 'INACTIVE';
}): Promise<HandoffIntegrationRecord> {
  const result = await executor().query<HandoffIntegrationRecord>(
    `INSERT INTO handyman_handoff_integrations
       (id, integration_code, display_name, status)
     VALUES ($1,$2,$3,$4) RETURNING ${INTEGRATION_SELECT}`,
    [randomUUID(), input.integrationCode, input.displayName, input.status ?? 'ACTIVE'],
  );
  return result.rows[0];
}

async function findIntegrationByCode(
  integrationCode: string,
  client?: PoolClient,
): Promise<HandoffIntegrationRecord | null> {
  const result = await executor(client).query<HandoffIntegrationRecord>(
    `SELECT ${INTEGRATION_SELECT} FROM handyman_handoff_integrations
     WHERE integration_code = $1`,
    [integrationCode],
  );
  return result.rows[0] ?? null;
}

async function findIntegrationById(
  id: string,
  client?: PoolClient,
): Promise<HandoffIntegrationRecord | null> {
  const result = await executor(client).query<HandoffIntegrationRecord>(
    `SELECT ${INTEGRATION_SELECT} FROM handyman_handoff_integrations
     WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

const ASSERTION_SELECT = `id, integration_id AS "integrationId",
  assertion_id AS "assertionId", assertion_hash AS "assertionHash",
  expires_at AS "expiresAt", created_at AS "createdAt"`;

async function insertAssertion(input: {
  integrationId: string;
  assertionId: string;
  assertionHash: string;
  expiresAt: Date;
}, client?: PoolClient): Promise<HandoffAssertionRecord> {
  const result = await executor(client).query<HandoffAssertionRecord>(
    `INSERT INTO handyman_handoff_assertions
       (id, integration_id, assertion_id, assertion_hash, expires_at)
     VALUES ($1,$2,$3,$4,$5) RETURNING ${ASSERTION_SELECT}`,
    [randomUUID(), input.integrationId, input.assertionId, input.assertionHash, input.expiresAt],
  );
  return result.rows[0];
}

async function findAssertionById(
  id: string,
  client?: PoolClient,
): Promise<HandoffAssertionRecord | null> {
  const result = await executor(client).query<HandoffAssertionRecord>(
    `SELECT ${ASSERTION_SELECT} FROM handyman_handoff_assertions
     WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

const EXCHANGE_SELECT = `id, integration_id AS "integrationId",
  handoff_assertion_id AS "handoffAssertionId", token_hash AS "tokenHash",
  client_id AS "clientId", tenant_company_id AS "tenantCompanyId",
  tenant_pic_id AS "tenantPicId", building_id AS "buildingId",
  space_id AS "spaceId",
  tenant_building_context_id AS "tenantBuildingContextId",
  tenant_space_relationship_id AS "tenantSpaceRelationshipId",
  resolved_user_id AS "resolvedUserId",
  actor_type AS "actorType", care_actor_id AS "careActorId",
  actor_reference AS "actorReference", status,
  expires_at AS "expiresAt", used_at AS "usedAt",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

/**
 * PART 09 — `actor` carries the PART 08 provenance when (and only when) the
 * assertion carried an attested actor block; it is written into the exchange
 * snapshot. Legacy handoffs pass null and every actor column stays NULL.
 */
async function createExchange(input: {
  integrationId: string;
  handoffAssertionId: string;
  tokenHash: string;
  context: HandoffExchangeContextInput;
  actor: ResolvedCareActorProvenance | null;
  expiresAt: Date;
}): Promise<HandoffExchangeRecord> {
  const result = await executor().query<HandoffExchangeRecord>(
    `INSERT INTO handyman_handoff_exchanges
       (id, integration_id, handoff_assertion_id, token_hash, client_id,
        tenant_company_id, tenant_pic_id, building_id, space_id,
        tenant_building_context_id, tenant_space_relationship_id,
        resolved_user_id, actor_type, care_actor_id, actor_reference,
        expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING ${EXCHANGE_SELECT}`,
    [
      randomUUID(),
      input.integrationId,
      input.handoffAssertionId,
      input.tokenHash,
      input.context.clientId,
      input.context.tenantCompanyId,
      input.context.tenantPicId,
      input.context.buildingId,
      input.context.spaceId,
      input.context.tenantBuildingContextId,
      input.context.tenantSpaceRelationshipId,
      input.context.resolvedUserId,
      input.actor?.actorType ?? null,
      input.actor?.careActorId ?? null,
      input.actor?.actorReference ?? null,
      input.expiresAt,
    ],
  );
  return result.rows[0];
}

async function findExchangeByTokenHash(
  tokenHash: string,
  client?: PoolClient,
): Promise<HandoffExchangeRecord | null> {
  const result = await executor(client).query<HandoffExchangeRecord>(
    `SELECT ${EXCHANGE_SELECT} FROM handyman_handoff_exchanges
     WHERE token_hash = $1`,
    [tokenHash],
  );
  return result.rows[0] ?? null;
}

/**
 * Atomic single-use transition: at most one concurrent consumer can move an
 * exchange ACTIVE → USED; everyone else gets no row.
 */
async function consumeExchange(
  id: string,
  client?: PoolClient,
): Promise<HandoffExchangeRecord | null> {
  const result = await executor(client).query<HandoffExchangeRecord>(
    `UPDATE handyman_handoff_exchanges
        SET status = 'USED', used_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status = 'ACTIVE'
      RETURNING ${EXCHANGE_SELECT}`,
    [id],
  );
  return result.rows[0] ?? null;
}

export const handoffRuntimeRepository = {
  createIntegration,
  findIntegrationByCode,
  findIntegrationById,
  insertAssertion,
  findAssertionById,
  createExchange,
  findExchangeByTokenHash,
  consumeExchange,
};
