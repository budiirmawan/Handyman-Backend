import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanCareActorRecord,
  HandymanCareActorStatus,
  HandymanHandoffIntegrationActorCapability,
  HandymanHandoffIntegrationActorScope,
} from './handyman-care-actor.types';

/** Default to the shared pool; transactional callers pass a PoolClient. */
function executor(client?: PoolClient): Pool | PoolClient {
  return client ?? getPool();
}

/**
 * CR-HM-01 AMENDMENT 01 PART 07 — Customer Care actor repository.
 *
 * Persistence for the registry plus the integration actor-capability scope.
 * Lifecycle is ACTIVE/INACTIVE only: there is deliberately NO delete function
 * and no status transition other than activate/deactivate.
 */

const CARE_ACTOR_SELECT = `id, integration_id AS "integrationId",
  actor_reference AS "actorReference", display_name AS "displayName",
  status, created_at AS "createdAt", updated_at AS "updatedAt"`;

async function create(input: {
  integrationId: string;
  actorReference: string;
  displayName: string;
}): Promise<HandymanCareActorRecord> {
  const result = await executor().query<HandymanCareActorRecord>(
    `INSERT INTO handyman_handoff_care_actors
       (id, integration_id, actor_reference, display_name)
     VALUES ($1,$2,$3,$4) RETURNING ${CARE_ACTOR_SELECT}`,
    [randomUUID(), input.integrationId, input.actorReference, input.displayName],
  );
  return result.rows[0];
}

async function findById(
  id: string,
  client?: PoolClient,
): Promise<HandymanCareActorRecord | null> {
  const result = await executor(client).query<HandymanCareActorRecord>(
    `SELECT ${CARE_ACTOR_SELECT} FROM handyman_handoff_care_actors
     WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** Any-status lookup, used for conflict detection before register. */
async function findByIntegrationAndReference(
  integrationId: string,
  actorReference: string,
  client?: PoolClient,
): Promise<HandymanCareActorRecord | null> {
  const result = await executor(client).query<HandymanCareActorRecord>(
    `SELECT ${CARE_ACTOR_SELECT} FROM handyman_handoff_care_actors
     WHERE integration_id = $1 AND actor_reference = $2`,
    [integrationId, actorReference],
  );
  return result.rows[0] ?? null;
}

/**
 * ACTIVE-only read primitive. Consumed by the future attested actor resolver
 * (PART 08) — it performs no validation and grants nothing by itself.
 */
async function findActiveByIntegrationAndReference(
  integrationId: string,
  actorReference: string,
  client?: PoolClient,
): Promise<HandymanCareActorRecord | null> {
  const result = await executor(client).query<HandymanCareActorRecord>(
    `SELECT ${CARE_ACTOR_SELECT} FROM handyman_handoff_care_actors
     WHERE integration_id = $1 AND actor_reference = $2 AND status = 'ACTIVE'`,
    [integrationId, actorReference],
  );
  return result.rows[0] ?? null;
}

/** Governed lifecycle transition: ACTIVE <-> INACTIVE only. */
async function updateStatus(
  id: string,
  status: HandymanCareActorStatus,
  client?: PoolClient,
): Promise<HandymanCareActorRecord | null> {
  const result = await executor(client).query<HandymanCareActorRecord>(
    `UPDATE handyman_handoff_care_actors
        SET status = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING ${CARE_ACTOR_SELECT}`,
    [id, status],
  );
  return result.rows[0] ?? null;
}

const INTEGRATION_SCOPE_SELECT = `id AS "integrationId",
  integration_code AS "integrationCode", display_name AS "displayName",
  status, actor_capability AS "actorCapability"`;

async function findIntegrationActorScopeById(
  integrationId: string,
  client?: PoolClient,
): Promise<HandymanHandoffIntegrationActorScope | null> {
  const result = await executor(client).query<HandymanHandoffIntegrationActorScope>(
    `SELECT ${INTEGRATION_SCOPE_SELECT} FROM handyman_handoff_integrations
     WHERE id = $1`,
    [integrationId],
  );
  return result.rows[0] ?? null;
}

async function findIntegrationActorScopeByCode(
  integrationCode: string,
  client?: PoolClient,
): Promise<HandymanHandoffIntegrationActorScope | null> {
  const result = await executor(client).query<HandymanHandoffIntegrationActorScope>(
    `SELECT ${INTEGRATION_SCOPE_SELECT} FROM handyman_handoff_integrations
     WHERE integration_code = $1`,
    [integrationCode],
  );
  return result.rows[0] ?? null;
}

/** Operational provisioning of the actor-capability scope (never a request). */
async function setIntegrationActorCapability(
  integrationId: string,
  capability: HandymanHandoffIntegrationActorCapability,
  client?: PoolClient,
): Promise<HandymanHandoffIntegrationActorScope | null> {
  const result = await executor(client).query<HandymanHandoffIntegrationActorScope>(
    `UPDATE handyman_handoff_integrations
        SET actor_capability = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING ${INTEGRATION_SCOPE_SELECT}`,
    [integrationId, capability],
  );
  return result.rows[0] ?? null;
}

export const handymanCareActorRepository = {
  create,
  findById,
  findByIntegrationAndReference,
  findActiveByIntegrationAndReference,
  updateStatus,
  findIntegrationActorScopeById,
  findIntegrationActorScopeByCode,
  setIntegrationActorCapability,
};
