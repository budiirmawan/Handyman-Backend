import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanUnlistedIntakeCaseRecord,
  HandymanUnlistedIntakeOriginChannel,
  HandymanUnlistedIntakeStatus,
} from './handyman-unlisted-intake.types';

const UNLISTED_INTAKE_SELECT = `
  SELECT
    c.id,
    c.client_id AS "clientId",
    c.building_id AS "buildingId",
    c.space_id AS "spaceId",
    c.tenant_company_id AS "tenantCompanyId",
    c.tenant_pic_id AS "tenantPicId",
    c.approval_tenant_company_id AS "approvalTenantCompanyId",
    c.cost_responsible_tenant_company_id AS "costResponsibleTenantCompanyId",
    c.channel_attribution_id AS "channelAttributionId",
    c.origin_channel AS "originChannel",
    c.origin_reference AS "originReference",
    c.requested_service_name AS "requestedServiceName",
    c.description,
    c.preferred_window_start AS "preferredWindowStart",
    c.preferred_window_end AS "preferredWindowEnd",
    c.preferred_window_timezone AS "preferredWindowTimezone",
    c.status,
    c.created_by_user_id AS "createdByUserId",
    c.created_by_care_actor_id AS "createdByCareActorId",
    COALESCE(u.display_name, ca.display_name, 'Customer Care') AS "createdByDisplayName",
    c.idempotency_key AS "idempotencyKey",
    c.payload_hash AS "payloadHash",
    c.created_at AS "createdAt",
    c.updated_at AS "updatedAt"
  FROM handyman_unlisted_service_intake_cases c
  LEFT JOIN users u ON u.id = c.created_by_user_id
  LEFT JOIN handyman_handoff_care_actors ca ON ca.id = c.created_by_care_actor_id
`;

export type NewHandymanUnlistedIntakeCaseInput = {
  id?: string;
  clientId: string;
  buildingId: string;
  spaceId: string | null;
  tenantCompanyId: string;
  tenantPicId: string | null;
  approvalTenantCompanyId: string;
  costResponsibleTenantCompanyId: string;
  channelAttributionId: string | null;
  originChannel: HandymanUnlistedIntakeOriginChannel;
  originReference: string | null;
  requestedServiceName: string;
  description: string;
  preferredWindowStart: string | null;
  preferredWindowEnd: string | null;
  preferredWindowTimezone: string | null;
  createdByUserId: string | null;
  createdByCareActorId: string | null;
  idempotencyKey: string;
  payloadHash: string;
};

async function findById(
  executor: Pick<PoolClient, 'query'> = getPool(),
  id: string,
): Promise<HandymanUnlistedIntakeCaseRecord | null> {
  const result = await executor.query<HandymanUnlistedIntakeCaseRecord>(
    `${UNLISTED_INTAKE_SELECT}
      WHERE c.id = $1
      LIMIT 1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findByActorAndIdempotencyKey(
  executor: Pick<PoolClient, 'query'> = getPool(),
  actor: { userId?: string; careActorId?: string },
  idempotencyKey: string,
): Promise<HandymanUnlistedIntakeCaseRecord | null> {
  if (actor.userId) {
    const result = await executor.query<HandymanUnlistedIntakeCaseRecord>(
      `${UNLISTED_INTAKE_SELECT}
        WHERE c.created_by_user_id = $1
          AND c.idempotency_key = $2
        LIMIT 1`,
      [actor.userId, idempotencyKey],
    );
    return result.rows[0] ?? null;
  }
  if (actor.careActorId) {
    const result = await executor.query<HandymanUnlistedIntakeCaseRecord>(
      `${UNLISTED_INTAKE_SELECT}
        WHERE c.created_by_care_actor_id = $1
          AND c.idempotency_key = $2
        LIMIT 1`,
      [actor.careActorId, idempotencyKey],
    );
    return result.rows[0] ?? null;
  }
  return null;
}

async function insertUnlistedIntakeCase(
  executor: Pick<PoolClient, 'query'>,
  input: NewHandymanUnlistedIntakeCaseInput,
): Promise<HandymanUnlistedIntakeCaseRecord> {
  const id = input.id ?? randomUUID();
  await executor.query(
    `INSERT INTO handyman_unlisted_service_intake_cases (
       id,
       client_id,
       building_id,
       space_id,
       tenant_company_id,
       tenant_pic_id,
       approval_tenant_company_id,
       cost_responsible_tenant_company_id,
       channel_attribution_id,
       origin_channel,
       origin_reference,
       requested_service_name,
       description,
       preferred_window_start,
       preferred_window_end,
       preferred_window_timezone,
       status,
       created_by_user_id,
       created_by_care_actor_id,
       idempotency_key,
       payload_hash
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
       $12, $13, $14, $15, $16, 'PENDING_TRIAGE', $17, $18, $19, $20
     )`,
    [
      id,
      input.clientId,
      input.buildingId,
      input.spaceId,
      input.tenantCompanyId,
      input.tenantPicId,
      input.approvalTenantCompanyId,
      input.costResponsibleTenantCompanyId,
      input.channelAttributionId,
      input.originChannel,
      input.originReference,
      input.requestedServiceName,
      input.description,
      input.preferredWindowStart,
      input.preferredWindowEnd,
      input.preferredWindowTimezone,
      input.createdByUserId,
      input.createdByCareActorId,
      input.idempotencyKey,
      input.payloadHash,
    ],
  );
  const created = await findById(executor, id);
  if (!created) {
    throw new Error('Failed to load newly inserted unlisted service intake case.');
  }
  return created;
}

async function listByBuildingScoped(
  executor: Pick<PoolClient, 'query'> = getPool(),
  filters: {
    clientId: string;
    buildingId: string;
    tenantCompanyId?: string;
    spaceId?: string;
    status?: HandymanUnlistedIntakeStatus;
    limit: number;
    offset: number;
  },
): Promise<HandymanUnlistedIntakeCaseRecord[]> {
  const params: unknown[] = [filters.clientId, filters.buildingId];
  const conditions: string[] = [
    'c.client_id = $1',
    'c.building_id = $2',
  ];

  if (filters.tenantCompanyId) {
    params.push(filters.tenantCompanyId);
    conditions.push(`c.tenant_company_id = $${params.length}`);
  }
  if (filters.spaceId) {
    params.push(filters.spaceId);
    conditions.push(`c.space_id = $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    conditions.push(`c.status = $${params.length}`);
  }

  params.push(filters.limit, filters.offset);
  const limitIdx = params.length - 1;
  const offsetIdx = params.length;

  const result = await executor.query<HandymanUnlistedIntakeCaseRecord>(
    `${UNLISTED_INTAKE_SELECT}
      WHERE ${conditions.join(' AND ')}
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params,
  );
  return result.rows;
}

async function listForCareWorkspaceScoped(
  executor: Pick<PoolClient, 'query'> = getPool(),
  filters: {
    careActorId: string;
    propertyId?: string;
    buildingId?: string;
    tenantCompanyId?: string;
    spaceId?: string;
    status?: HandymanUnlistedIntakeStatus;
    limit: number;
    offset: number;
  },
): Promise<HandymanUnlistedIntakeCaseRecord[]> {
  const params: unknown[] = [filters.careActorId];
  const conditions: string[] = [
    `EXISTS (
       SELECT 1
         FROM buildings b
         JOIN properties p ON p.id = b.property_id AND p.status = 'ACTIVE'
         JOIN clients cl ON cl.id = p.client_id AND cl.status = 'ACTIVE'
         JOIN handyman_care_property_grants g
           ON g.property_id = p.id
          AND g.care_actor_id = $1
          AND g.revoked_at IS NULL
        WHERE b.id = c.building_id
          AND b.status = 'ACTIVE'
          AND cl.id = c.client_id
     )`,
  ];

  if (filters.propertyId) {
    params.push(filters.propertyId);
    conditions.push(
      `EXISTS (SELECT 1 FROM buildings b2 WHERE b2.id = c.building_id AND b2.property_id = $${params.length})`,
    );
  }
  if (filters.buildingId) {
    params.push(filters.buildingId);
    conditions.push(`c.building_id = $${params.length}`);
  }
  if (filters.tenantCompanyId) {
    params.push(filters.tenantCompanyId);
    conditions.push(`c.tenant_company_id = $${params.length}`);
  }
  if (filters.spaceId) {
    params.push(filters.spaceId);
    conditions.push(`c.space_id = $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    conditions.push(`c.status = $${params.length}`);
  }

  params.push(filters.limit, filters.offset);
  const limitIdx = params.length - 1;
  const offsetIdx = params.length;

  const result = await executor.query<HandymanUnlistedIntakeCaseRecord>(
    `${UNLISTED_INTAKE_SELECT}
      WHERE ${conditions.join(' AND ')}
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params,
  );
  return result.rows;
}

async function listForOperationsTriageScoped(
  executor: Pick<PoolClient, 'query'> = getPool(),
  filters: {
    actorUserId: string;
    clientId?: string;
    buildingId?: string;
    tenantCompanyId?: string;
    spaceId?: string;
    status?: HandymanUnlistedIntakeStatus;
    limit: number;
    offset: number;
  },
): Promise<HandymanUnlistedIntakeCaseRecord[]> {
  const params: unknown[] = [filters.actorUserId];
  const conditions: string[] = [
    `EXISTS (
       SELECT 1
         FROM buildings b
         JOIN properties p ON p.id = b.property_id AND p.status = 'ACTIVE'
         JOIN clients cl ON cl.id = p.client_id AND cl.status = 'ACTIVE'
        WHERE b.id = c.building_id
          AND b.status = 'ACTIVE'
          AND cl.id = c.client_id
     )`,
    `(
       EXISTS (
         SELECT 1
           FROM user_building_assignments uba
          WHERE uba.user_id = $1
            AND uba.building_id = c.building_id
       )
       OR EXISTS (
         SELECT 1
           FROM user_role_assignments ura
           JOIN roles r ON r.id = ura.role_id
          WHERE ura.user_id = $1
            AND r.status = 'ACTIVE'
            AND r.code = 'PLATFORM_ADMIN'
       )
     )`,
  ];

  if (filters.clientId) {
    params.push(filters.clientId);
    conditions.push(`c.client_id = $${params.length}`);
  }
  if (filters.buildingId) {
    params.push(filters.buildingId);
    conditions.push(`c.building_id = $${params.length}`);
  }
  if (filters.tenantCompanyId) {
    params.push(filters.tenantCompanyId);
    conditions.push(`c.tenant_company_id = $${params.length}`);
  }
  if (filters.spaceId) {
    params.push(filters.spaceId);
    conditions.push(`c.space_id = $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    conditions.push(`c.status = $${params.length}`);
  }

  params.push(filters.limit, filters.offset);
  const limitIdx = params.length - 1;
  const offsetIdx = params.length;

  const result = await executor.query<HandymanUnlistedIntakeCaseRecord>(
    `${UNLISTED_INTAKE_SELECT}
      WHERE ${conditions.join(' AND ')}
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params,
  );
  return result.rows;
}

export const handymanUnlistedIntakeRepository = {
  findById,
  findByActorAndIdempotencyKey,
  insertUnlistedIntakeCase,
  listByBuildingScoped,
  listForCareWorkspaceScoped,
  listForOperationsTriageScoped,
};
