import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanUnlistedIntakeCaseRecord,
  HandymanUnlistedIntakeOriginChannel,
  HandymanUnlistedIntakeStatus,
  HandymanUnlistedIntakeTriageDecisionRecord,
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
    st.triage_decision_id AS "triageDecisionId",
    st.triaged_at AS "triagedAt",
    c.created_by_user_id AS "createdByUserId",
    c.created_by_care_actor_id AS "createdByCareActorId",
    COALESCE(u.display_name, ca.display_name, 'Customer Care') AS "createdByDisplayName",
    c.idempotency_key AS "idempotencyKey",
    c.payload_hash AS "payloadHash",
    c.created_at AS "createdAt",
    c.updated_at AS "updatedAt"
  FROM handyman_unlisted_service_intake_cases c
  LEFT JOIN handyman_unlisted_intake_triage_state st
    ON st.intake_case_id = c.id
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

const TRIAGE_DECISION_SELECT = `
  SELECT
    d.id,
    d.client_id AS "clientId",
    d.building_id AS "buildingId",
    d.tenant_company_id AS "tenantCompanyId",
    d.intake_case_id AS "intakeCaseId",
    d.decision,
    d.status_after AS "statusAfter",
    d.justification,
    d.clarification_request AS "clarificationRequest",
    d.catalog_service_id AS "catalogServiceId",
    d.custom_service_name AS "customServiceName",
    d.custom_service_notes AS "customServiceNotes",
    d.manual_quote_summary AS "manualQuoteSummary",
    d.manual_quote_quantity::numeric(18, 4)::text AS "manualQuoteQuantity",
    d.manual_quote_uom_id AS "manualQuoteUomId",
    d.triaged_by_user_id AS "triagedByUserId",
    u.display_name AS "triagedByDisplayName",
    d.triaged_at AS "triagedAt",
    d.idempotency_key AS "idempotencyKey",
    d.payload_hash AS "payloadHash",
    d.created_at AS "createdAt",
    d.updated_at AS "updatedAt"
  FROM handyman_unlisted_intake_triage_decisions d
  LEFT JOIN users u ON u.id = d.triaged_by_user_id
`;

/**
 * The authoritative intake row for a triage write, locked FOR UPDATE so two
 * concurrent Operations decisions on one case serialize (the second one then
 * observes the committed projection and is refused).
 */
async function findCaseForTriageLock(
  executor: Pick<PoolClient, 'query'>,
  id: string,
): Promise<{
  id: string;
  clientId: string;
  buildingId: string;
  tenantCompanyId: string;
  status: HandymanUnlistedIntakeStatus;
  hasEffectiveDecision: boolean;
} | null> {
  const result = await executor.query<{
    id: string;
    client_id: string;
    building_id: string;
    tenant_company_id: string;
    status: HandymanUnlistedIntakeStatus;
    has_effective_decision: boolean;
  }>(
    `SELECT c.id, c.client_id, c.building_id, c.tenant_company_id, c.status,
            EXISTS (
              SELECT 1
                FROM handyman_unlisted_intake_triage_state st
               WHERE st.intake_case_id = c.id
            ) AS has_effective_decision
       FROM handyman_unlisted_service_intake_cases c
      WHERE c.id = $1
      FOR UPDATE`,
    [id],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    tenantCompanyId: row.tenant_company_id,
    status: row.status,
    hasEffectiveDecision: row.has_effective_decision,
  };
}

export type NewHandymanUnlistedIntakeTriageDecisionInput = {
  id?: string;
  clientId: string;
  buildingId: string;
  tenantCompanyId: string;
  intakeCaseId: string;
  decision: HandymanUnlistedIntakeTriageDecisionRecord['decision'];
  statusAfter: HandymanUnlistedIntakeStatus;
  justification: string;
  clarificationRequest: string | null;
  catalogServiceId: string | null;
  customServiceName: string | null;
  customServiceNotes: string | null;
  manualQuoteSummary: string | null;
  manualQuoteQuantity: string | null;
  manualQuoteUomId: string | null;
  triagedByUserId: string;
  idempotencyKey: string;
  payloadHash: string;
};

async function insertTriageDecision(
  executor: Pick<PoolClient, 'query'>,
  input: NewHandymanUnlistedIntakeTriageDecisionInput,
): Promise<HandymanUnlistedIntakeTriageDecisionRecord> {
  const id = input.id ?? randomUUID();
  await executor.query(
    `INSERT INTO handyman_unlisted_intake_triage_decisions (
       id,
       client_id,
       building_id,
       tenant_company_id,
       intake_case_id,
       decision,
       status_after,
       justification,
       clarification_request,
       catalog_service_id,
       custom_service_name,
       custom_service_notes,
       manual_quote_summary,
       manual_quote_quantity,
       manual_quote_uom_id,
       triaged_by_user_id,
       idempotency_key,
       payload_hash
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
       $11, $12, $13, $14::numeric, $15, $16, $17, $18
     )`,
    [
      id,
      input.clientId,
      input.buildingId,
      input.tenantCompanyId,
      input.intakeCaseId,
      input.decision,
      input.statusAfter,
      input.justification,
      input.clarificationRequest,
      input.catalogServiceId,
      input.customServiceName,
      input.customServiceNotes,
      input.manualQuoteSummary,
      input.manualQuoteQuantity,
      input.manualQuoteUomId,
      input.triagedByUserId,
      input.idempotencyKey,
      input.payloadHash,
    ],
  );
  const created = await findTriageDecisionById(executor, id);
  if (!created) {
    throw new Error(
      'Failed to load newly inserted unlisted intake triage decision.',
    );
  }
  return created;
}

async function findTriageDecisionById(
  executor: Pick<PoolClient, 'query'>,
  id: string,
): Promise<HandymanUnlistedIntakeTriageDecisionRecord | null> {
  const result = await executor.query<HandymanUnlistedIntakeTriageDecisionRecord>(
    `${TRIAGE_DECISION_SELECT}
      WHERE d.id = $1
      LIMIT 1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findTriageDecisionByCaseAndIdempotencyKey(
  executor: Pick<PoolClient, 'query'>,
  intakeCaseId: string,
  idempotencyKey: string,
): Promise<HandymanUnlistedIntakeTriageDecisionRecord | null> {
  const result = await executor.query<HandymanUnlistedIntakeTriageDecisionRecord>(
    `${TRIAGE_DECISION_SELECT}
      WHERE d.intake_case_id = $1
        AND d.idempotency_key = $2
      LIMIT 1`,
    [intakeCaseId, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

async function listTriageDecisionsByCase(
  executor: Pick<PoolClient, 'query'> = getPool(),
  filters: {
    clientId: string;
    buildingId: string;
    intakeCaseId: string;
  },
): Promise<HandymanUnlistedIntakeTriageDecisionRecord[]> {
  const result = await executor.query<HandymanUnlistedIntakeTriageDecisionRecord>(
    `${TRIAGE_DECISION_SELECT}
      WHERE d.intake_case_id = $3
        AND d.client_id = $1
        AND d.building_id = $2
      ORDER BY d.triaged_at ASC, d.id ASC`,
    [filters.clientId, filters.buildingId, filters.intakeCaseId],
  );
  return result.rows;
}

/**
 * The only permitted projection: the case's ONE effective decision is anchored
 * in the 1:1 state row (skipped for a clarification round) and the case status
 * is advanced to exactly the status that decision authorizes. The 0487 DB
 * guards refuse anything else, including the ordering these two writes must
 * follow (decision -> state -> status).
 */
async function projectCaseTriageState(
  executor: Pick<PoolClient, 'query'>,
  input: {
    intakeCaseId: string;
    /** null for a clarification round — it is never the effective decision. */
    decisionId: string | null;
    status: HandymanUnlistedIntakeStatus;
  },
): Promise<void> {
  if (input.decisionId !== null) {
    await executor.query(
      `INSERT INTO handyman_unlisted_intake_triage_state (
         intake_case_id, triage_decision_id, triaged_at, created_at, updated_at
       )
       VALUES ($1, $2, NOW(), NOW(), NOW())`,
      [input.intakeCaseId, input.decisionId],
    );
  }
  await executor.query(
    `UPDATE handyman_unlisted_service_intake_cases
        SET status = $2, updated_at = NOW()
      WHERE id = $1`,
    [input.intakeCaseId, input.status],
  );
}

async function findCatalogServiceForTriage(
  executor: Pick<PoolClient, 'query'>,
  clientId: string,
  catalogServiceId: string,
): Promise<{ id: string; code: string; name: string } | null> {
  const result = await executor.query<{
    id: string;
    code: string;
    name: string;
  }>(
    `SELECT sc.id, sc.code, sc.name
       FROM service_catalog sc
      WHERE sc.id = $2
        AND sc.client_id = $1
        AND sc.status = 'ACTIVE'
      LIMIT 1`,
    [clientId, catalogServiceId],
  );
  return result.rows[0] ?? null;
}

async function findActiveUomForTriage(
  executor: Pick<PoolClient, 'query'>,
  uomId: string,
): Promise<{ id: string; code: string; name: string } | null> {
  const result = await executor.query<{ id: string; code: string; name: string }>(
    `SELECT u.id, u.code, u.name
       FROM units_of_measure u
      WHERE u.id = $1
        AND u.status = 'ACTIVE'
      LIMIT 1`,
    [uomId],
  );
  return result.rows[0] ?? null;
}

export const handymanUnlistedIntakeRepository = {
  findById,
  findByActorAndIdempotencyKey,
  insertUnlistedIntakeCase,
  listByBuildingScoped,
  listForCareWorkspaceScoped,
  listForOperationsTriageScoped,
  findCaseForTriageLock,
  insertTriageDecision,
  findTriageDecisionById,
  findTriageDecisionByCaseAndIdempotencyKey,
  listTriageDecisionsByCase,
  projectCaseTriageState,
  findCatalogServiceForTriage,
  findActiveUomForTriage,
};
