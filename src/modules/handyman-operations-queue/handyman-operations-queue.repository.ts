import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanServiceRequestListFilters,
} from '../handyman-requests';

/**
 * CR-HM-OPS-INBOX-BE-01 P0-A — Operations queue discovery repository.
 *
 * The Operations queue previously reused the Customer Care projection list
 * (`listCustomerCareProjectionsScoped`), whose C6 wall admits only a Tenant
 * PIC (with effective occupancy) or a PLATFORM_ADMIN. An authorized
 * Operations user — an ACTIVE Building assignee holding the route's
 * `tenant_company.read` permission — is neither, so the queue discovered
 * nothing outside those two customer personas.
 *
 * This repository implements the genuine Operations discovery wall instead:
 *   - route-level `tenant_company.read` authority is unchanged (RBAC
 *     middleware stays the single permission gate);
 *   - every row must sit in a Building where the actor holds an explicit
 *     ACTIVE `user_building_assignments` row resolving under the row's
 *     Client (the exact BE-02G spine the commercial read services already
 *     enforce via `canAccessBuildingScopedResource`);
 *   - Client isolation, Building assignment, actor authorization and
 *     cross-tenant denial are therefore preserved, and access is never
 *     broadened to unassigned Buildings or foreign Clients.
 *
 * Pagination integrity: `handyman_execution_scopes` is one-per-approved
 * quotation version, so a request may legitimately own several scopes. The
 * previous Customer Care projection LEFT JOIN fanned one request out into
 * one row per scope (duplicated queue items inside a page and across
 * offsets). This query returns exactly one row per request and resolves the
 * execution-scope pointer with the same deterministic rule the per-item
 * status visibility read uses (`ORDER BY created_at DESC, id DESC LIMIT 1`),
 * so the queue pointer can never disagree with the detail projection.
 */

export type OperationsQueueRequestRow = {
  handymanRequestId: string;
  clientId: string;
  tenantCompanyId: string;
  buildingId: string;
  spaceId: string | null;
  channelAttributionId: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  executionScopeId: string | null;
};

/** ACTIVE assignment of the actor to the row's exact Building under the
 * row's Client. No PIC membership, occupancy, or role branch is involved. */
function operationsBuildingReadScope(actorParam: number): string {
  const actor = `$${actorParam}`;
  return `EXISTS (
    SELECT 1 FROM user_building_assignments uba
      JOIN buildings b ON b.id = uba.building_id AND b.status = 'ACTIVE'
      JOIN properties p ON p.id = b.property_id AND p.status = 'ACTIVE'
      JOIN clients c ON c.id = p.client_id AND c.status = 'ACTIVE'
      JOIN users u ON u.id = uba.user_id AND u.status = 'ACTIVE'
    WHERE uba.user_id = ${actor} AND uba.status = 'ACTIVE'
      AND b.id = r.building_id AND c.id = r.client_id
  )`;
}

/**
 * Bounded, offset-paginated discovery of Handyman requests inside the
 * actor's genuine Client/Building scope. Ordering is the established
 * `created_at ASC, id ASC` queue contract; `limit` is the page size and the
 * caller reads `hasMore` to continue with `offset + limit`.
 */
async function listOperationsQueueRequests(
  executor: Pick<PoolClient, 'query'> = getPool(),
  filters: HandymanServiceRequestListFilters,
  actorUserId: string,
  page: { limit: number; offset: number },
): Promise<{ rows: OperationsQueueRequestRow[]; hasMore: boolean }> {
  const conditions: string[] = ['r.client_id = $1'];
  const values: unknown[] = [filters.clientId];
  let idx = 2;

  if (filters.tenantCompanyId !== undefined) {
    conditions.push(`r.tenant_company_id = $${idx++}`);
    values.push(filters.tenantCompanyId);
  }
  if (filters.buildingId !== undefined) {
    conditions.push(`r.building_id = $${idx++}`);
    values.push(filters.buildingId);
  }
  if (filters.spaceId !== undefined) {
    conditions.push(`r.space_id = $${idx++}`);
    values.push(filters.spaceId);
  }
  if (filters.channelAttributionId !== undefined) {
    conditions.push(`r.channel_attribution_id = $${idx++}`);
    values.push(filters.channelAttributionId);
  }
  if (filters.status !== undefined) {
    conditions.push(`r.status = $${idx++}`);
    values.push(filters.status);
  }
  conditions.push(operationsBuildingReadScope(idx));
  values.push(actorUserId);

  const limitParameter = values.length + 1;
  const offsetParameter = values.length + 2;
  values.push(page.limit + 1, page.offset);

  const result = await executor.query<OperationsQueueRequestRow>(
    `SELECT r.id AS "handymanRequestId",
            r.client_id AS "clientId",
            r.tenant_company_id AS "tenantCompanyId",
            r.building_id AS "buildingId",
            r.space_id AS "spaceId",
            r.channel_attribution_id AS "channelAttributionId",
            r.status,
            r.created_at AS "createdAt",
            r.updated_at AS "updatedAt",
            (
              SELECT latest_scope.id
                FROM handyman_execution_scopes latest_scope
               WHERE latest_scope.handyman_request_id = r.id
               ORDER BY latest_scope.created_at DESC, latest_scope.id DESC
               LIMIT 1
            ) AS "executionScopeId"
       FROM handyman_service_requests r
      WHERE ${conditions.join(' AND ')}
      ORDER BY r.created_at ASC, r.id ASC
      LIMIT $${limitParameter} OFFSET $${offsetParameter}`,
    values,
  );

  const hasMore = result.rows.length > page.limit;
  return { rows: result.rows.slice(0, page.limit), hasMore };
}

export const handymanOperationsQueueRepository = {
  listOperationsQueueRequests,
};
