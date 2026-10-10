import { getPool } from '../../database';
import type { HandymanServiceRequestStatus } from './handyman-service-request.types';

/**
 * W02 PART 02 — Operations queue read projection (repository).
 *
 * Separate from the C6 Customer Care wall (`customerRequestReadScope` in
 * handyman-service-request.repository.ts), which stays unchanged. Operations
 * authority is the User's explicit ACTIVE Building assignment under the
 * request's own Client, with the Building/Property/Client/User chain ACTIVE.
 * There is no PIC shortcut and no PLATFORM_ADMIN bypass here. The route guard
 * (`tenant_company.read`) is applied before this query runs.
 */

export type OperationsQueueSelection = {
  actorUserId: string;
  status: HandymanServiceRequestStatus | null;
  buildingId: string | null;
  afterId: string | null;
  afterCreatedAt: string | null;
  limit: number;
};

export type OperationsQueueRow = {
  id: string;
  clientId: string;
  tenantCompanyId: string;
  tenantCode: string;
  tenantName: string;
  tenantPicId: string | null;
  propertyId: string;
  propertyName: string;
  buildingId: string;
  buildingCode: string;
  buildingName: string;
  spaceId: string | null;
  spaceCode: string | null;
  spaceName: string | null;
  serviceCatalogId: string;
  serviceCatalogName: string;
  serviceVariantId: string | null;
  description: string;
  status: HandymanServiceRequestStatus;
  createdAt: Date;
  updatedAt: Date;
  cursorCreatedAt: string;
  originChannel: string;
  actorType: string;
  careActorId: string | null;
  attributionCreatedAt: Date;
};

const OPERATIONS_SELECT = `
  r.id,
  r.client_id AS "clientId",
  r.tenant_company_id AS "tenantCompanyId",
  tc.tenant_code AS "tenantCode",
  tc.tenant_name AS "tenantName",
  r.tenant_pic_id AS "tenantPicId",
  p.id AS "propertyId",
  p.name AS "propertyName",
  r.building_id AS "buildingId",
  b.code AS "buildingCode",
  b.name AS "buildingName",
  r.space_id AS "spaceId",
  s.code AS "spaceCode",
  s.name AS "spaceName",
  r.service_catalog_id AS "serviceCatalogId",
  sc.name AS "serviceCatalogName",
  r.service_variant_id AS "serviceVariantId",
  r.description,
  r.status,
  r.created_at AS "createdAt",
  r.updated_at AS "updatedAt",
  to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorCreatedAt",
  ca.origin_channel AS "originChannel",
  ca.actor_type AS "actorType",
  ca.care_actor_id AS "careActorId",
  ca.created_at AS "attributionCreatedAt"
`;

/** Explicit Building assignment + full active chain. $1 = actor user id. */
const OPERATIONS_SCOPE = `EXISTS (
    SELECT 1 FROM user_building_assignments uba
      JOIN users u ON u.id = uba.user_id AND u.status = 'ACTIVE'
    WHERE uba.user_id = $1 AND uba.status = 'ACTIVE'
      AND uba.building_id = r.building_id
  )
  -- Fail-closed for tenant-side identities: C6 requires PIC accounts to hold
  -- a Building assignment, so an ACTIVE tenant PIC link must never unlock the
  -- building-wide Operations queue (it would expose other tenants' requests).
  AND NOT EXISTS (
    SELECT 1 FROM tenant_pics tpic
    WHERE tpic.user_id = $1 AND tpic.status = 'ACTIVE'
  )`;

const OPERATIONS_FROM = `
  FROM handyman_service_requests r
  JOIN handyman_channel_attributions ca
    ON ca.id = r.channel_attribution_id AND ca.client_id = r.client_id
  JOIN buildings b
    ON b.id = r.building_id AND b.status = 'ACTIVE'
  JOIN properties p
    ON p.id = b.property_id AND p.client_id = r.client_id AND p.status = 'ACTIVE'
  JOIN clients c
    ON c.id = r.client_id AND c.status = 'ACTIVE'
  JOIN tenant_companies tc
    ON tc.id = r.tenant_company_id AND tc.client_id = r.client_id
  JOIN service_catalog sc
    ON sc.id = r.service_catalog_id AND sc.client_id = r.client_id
  LEFT JOIN spaces s
    ON s.id = r.space_id
`;

async function listOperationsQueue(
  selection: OperationsQueueSelection,
): Promise<OperationsQueueRow[]> {
  const result = await getPool().query<OperationsQueueRow>(
    `SELECT ${OPERATIONS_SELECT}
       ${OPERATIONS_FROM}
      WHERE ${OPERATIONS_SCOPE}
        AND ($2::text IS NULL OR r.status = $2)
        AND ($3::uuid IS NULL OR r.building_id = $3)
        AND ($4::uuid IS NULL OR (r.created_at, r.id) > ($5::timestamptz, $4::uuid))
      ORDER BY r.created_at ASC, r.id ASC
      LIMIT $6`,
    [
      selection.actorUserId,
      selection.status,
      selection.buildingId,
      selection.afterId,
      selection.afterCreatedAt,
      selection.limit + 1,
    ],
  );
  return result.rows;
}

async function findOperationsRequestById(
  actorUserId: string,
  id: string,
): Promise<OperationsQueueRow | null> {
  const result = await getPool().query<OperationsQueueRow>(
    `SELECT ${OPERATIONS_SELECT}
       ${OPERATIONS_FROM}
      WHERE r.id = $2 AND ${OPERATIONS_SCOPE}`,
    [actorUserId, id],
  );
  return result.rows[0] ?? null;
}

export const handymanOperationsQueueRepository = {
  listOperationsQueue,
  findOperationsRequestById,
};
