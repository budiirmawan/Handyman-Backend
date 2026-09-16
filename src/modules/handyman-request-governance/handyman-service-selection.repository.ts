import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanGovernanceRowStatus,
  HandymanRequestServiceRecord,
  HandymanServiceSelectionSource,
} from './handyman-request-governance.types';

/**
 * CR-HM-BE-03 RUN 1 — Governed request↔service selection persistence.
 *
 * Append-only with guarded supersede. One ACTIVE row per
 * (request, service) is structurally enforced by the partial unique index
 * `handyman_request_services_one_active_per_request_service` (migration
 * 0350); same-client scope is proven structurally by the composite
 * `(service_catalog_id, client_id)` FK into `service_catalog`.
 */

const SELECTION_SELECT = `
  id,
  request_id AS "requestId",
  client_id AS "clientId",
  building_id AS "buildingId",
  service_catalog_id AS "serviceCatalogId",
  source,
  status,
  selected_by_user_id AS "selectedByUserId",
  selected_at AS "selectedAt",
  superseded_at AS "supersededAt",
  superseded_by_user_id AS "supersededByUserId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

async function create(
  input: {
    requestId: string;
    clientId: string;
    buildingId: string;
    serviceCatalogId: string;
    source: HandymanServiceSelectionSource;
    selectedByUserId: string;
  },
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanRequestServiceRecord> {
  const result = await executor.query<HandymanRequestServiceRecord>(
    `INSERT INTO handyman_request_services
       (id, request_id, client_id, building_id, service_catalog_id, source,
        selected_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${SELECTION_SELECT}`,
    [
      randomUUID(),
      input.requestId,
      input.clientId,
      input.buildingId,
      input.serviceCatalogId,
      input.source,
      input.selectedByUserId,
    ],
  );
  return result.rows[0];
}

async function findById(
  id: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanRequestServiceRecord | null> {
  const result = await executor.query<HandymanRequestServiceRecord>(
    `SELECT ${SELECTION_SELECT} FROM handyman_request_services WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findActiveByRequestAndService(
  requestId: string,
  serviceCatalogId: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanRequestServiceRecord | null> {
  const result = await executor.query<HandymanRequestServiceRecord>(
    `SELECT ${SELECTION_SELECT}
     FROM handyman_request_services
     WHERE request_id = $1 AND service_catalog_id = $2 AND status = 'ACTIVE'`,
    [requestId, serviceCatalogId],
  );
  return result.rows[0] ?? null;
}

async function listByRequest(
  requestId: string,
  filters: { status?: HandymanGovernanceRowStatus } = {},
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanRequestServiceRecord[]> {
  const clauses: string[] = [];
  const values: unknown[] = [requestId];
  if (filters.status) {
    values.push(filters.status);
    clauses.push(`status = $${values.length}`);
  }
  const whereClause = clauses.length > 0 ? `AND ${clauses.join(' AND ')}` : '';
  const result = await executor.query<HandymanRequestServiceRecord>(
    `SELECT ${SELECTION_SELECT}
     FROM handyman_request_services
     WHERE request_id = $1
     ${whereClause}
     ORDER BY selected_at ASC, id ASC`,
    values,
  );
  return result.rows;
}

/** Guarded ACTIVE → SUPERSEDED for one selection row. */
async function supersedeActive(
  id: string,
  actorUserId: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanRequestServiceRecord | null> {
  const result = await executor.query<HandymanRequestServiceRecord>(
    `UPDATE handyman_request_services
     SET status = 'SUPERSEDED',
         superseded_at = NOW(),
         superseded_by_user_id = $2,
         updated_at = NOW()
     WHERE id = $1 AND status = 'ACTIVE'
     RETURNING ${SELECTION_SELECT}`,
    [id, actorUserId],
  );
  return result.rows[0] ?? null;
}

/**
 * Supersedes every ACTIVE TRIAGE-source selection of a request (re-triage
 * consequence). INSPECTION-source selections belong to the completed
 * inspection history and are deliberately untouched.
 */
async function supersedeActiveTriageSource(
  requestId: string,
  actorUserId: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<string[]> {
  const result = await executor.query<{ id: string }>(
    `UPDATE handyman_request_services
     SET status = 'SUPERSEDED',
         superseded_at = NOW(),
         superseded_by_user_id = $2,
         updated_at = NOW()
     WHERE request_id = $1 AND source = 'TRIAGE' AND status = 'ACTIVE'
     RETURNING id`,
    [requestId, actorUserId],
  );
  return result.rows.map((row) => row.id);
}

export const handymanServiceSelectionRepository = {
  create,
  findActiveByRequestAndService,
  findById,
  listByRequest,
  supersedeActive,
  supersedeActiveTriageSource,
};
