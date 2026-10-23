import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { getPool } from '../../database';
import type {
  CompetencyEnforcementLevel,
  CompetencyRequirementChanges,
  CompetencyRequirementRecord,
  CompetencyRequirementStatus,
  CompetencyRequirementTarget,
  CompetencyRequirementType,
  NewCompetencyRequirement,
} from './service-competency-requirement.types';

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 03A/03B2A — requirement repository. Sole
 * writer of `service_catalog_competency_requirements`.
 *
 * The table serves TWO targets since 0465, with one requirement MODEL:
 *   - a Service Catalog entry (the Handyman "job type", PART 03A), and
 *   - a Work Order TRADE CATEGORY (the multi-trade Work Order path, PART
 *     03B2A).
 *
 * Exactly one target is set per row (database CHECK). Queries take a
 * `CompetencyRequirementTarget` and bind the target column explicitly, so a
 * caller can never read across targets: a requirement configured for a trade
 * category is invisible to the job-type evaluator and vice versa.
 *
 * Reads are Client-scoped by the caller-supplied `clientId`; the write path
 * never trusts a caller-supplied Client (the service derives it from the
 * target row it just authorised).
 */

type Row = QueryResultRow;

const SELECT = `
  SELECT r.id,
         r.client_id,
         r.service_catalog_id,
         r.trade_category_id,
         r.requirement_type,
         r.enforcement_level,
         r.skill_id,
         r.minimum_proficiency_level,
         r.certificate_name,
         r.notes,
         r.status,
         r.created_by_user_id,
         r.created_at,
         r.updated_at,
         s.code AS skill_code,
         s.name AS skill_name,
         s.category AS skill_category,
         s.status AS skill_status
    FROM service_catalog_competency_requirements r
    LEFT JOIN skills s ON s.id = r.skill_id`;

/** Binds the target predicate without ever interpolating a column name. */
function targetParams(target: CompetencyRequirementTarget): {
  serviceCatalogId: string | null;
  tradeCategoryId: string | null;
} {
  return target.kind === 'SERVICE_CATALOG'
    ? { serviceCatalogId: target.serviceCatalogId, tradeCategoryId: null }
    : { serviceCatalogId: null, tradeCategoryId: target.tradeCategoryId };
}

function mapRow(row: Row): CompetencyRequirementRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    serviceCatalogId: row.service_catalog_id ?? null,
    tradeCategoryId: row.trade_category_id ?? null,
    requirementType: row.requirement_type as CompetencyRequirementType,
    enforcementLevel: row.enforcement_level as CompetencyEnforcementLevel,
    skillId: row.skill_id ?? null,
    skill:
      row.skill_id && row.skill_code
        ? {
            id: row.skill_id,
            code: row.skill_code,
            name: row.skill_name,
            category: row.skill_category,
            status: row.skill_status,
          }
        : null,
    minimumProficiencyLevel: row.minimum_proficiency_level ?? null,
    certificateName: row.certificate_name ?? null,
    notes: row.notes ?? null,
    status: row.status as CompetencyRequirementStatus,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function insertRequirement(
  executor: Pick<PoolClient, 'query'>,
  record: NewCompetencyRequirement,
): Promise<CompetencyRequirementRecord> {
  const result = await executor.query(
    `INSERT INTO service_catalog_competency_requirements (
       id, client_id, service_catalog_id, trade_category_id, requirement_type,
       enforcement_level, skill_id, minimum_proficiency_level,
       certificate_name, notes, status, created_by_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'ACTIVE', $11)
     RETURNING id`,
    [
      randomUUID(),
      record.clientId,
      record.serviceCatalogId,
      record.tradeCategoryId,
      record.requirementType,
      record.enforcementLevel,
      record.skillId,
      record.minimumProficiencyLevel,
      record.certificateName,
      record.notes,
      record.createdByUserId,
    ],
  );
  const created = await findById(executor, result.rows[0].id);
  if (!created) {
    throw new Error(
      'SERVICE_COMPETENCY_REQUIREMENT_PERSIST_FAILED: insert committed no row',
    );
  }
  return created;
}

async function findById(
  executor: Pick<PoolClient, 'query'> = getPool(),
  id: string,
): Promise<CompetencyRequirementRecord | null> {
  const result = await executor.query(`${SELECT} WHERE r.id = $1`, [id]);
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

async function findScopedById(
  executor: Pick<PoolClient, 'query'> = getPool(),
  input: { id: string; clientId: string; target: CompetencyRequirementTarget },
): Promise<CompetencyRequirementRecord | null> {
  const { serviceCatalogId, tradeCategoryId } = targetParams(input.target);
  const result = await executor.query(
    `${SELECT}
      WHERE r.id = $1
        AND r.client_id = $2
        AND (($3::uuid IS NOT NULL AND r.service_catalog_id = $3)
             OR ($4::uuid IS NOT NULL AND r.trade_category_id = $4))`,
    [input.id, input.clientId, serviceCatalogId, tradeCategoryId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

type ListFilter = {
  status?: CompetencyRequirementStatus;
  enforcementLevel?: CompetencyEnforcementLevel;
  requirementType?: CompetencyRequirementType;
};

async function listByTarget(
  executor: Pick<PoolClient, 'query'> = getPool(),
  input: { clientId: string; target: CompetencyRequirementTarget },
  filter: ListFilter = {},
): Promise<CompetencyRequirementRecord[]> {
  const { serviceCatalogId, tradeCategoryId } = targetParams(input.target);
  const result = await executor.query(
    `${SELECT}
      WHERE r.client_id = $1
        AND (($2::uuid IS NOT NULL AND r.service_catalog_id = $2)
             OR ($3::uuid IS NOT NULL AND r.trade_category_id = $3))
        AND ($4::text IS NULL OR r.status = $4)
        AND ($5::text IS NULL OR r.enforcement_level = $5)
        AND ($6::text IS NULL OR r.requirement_type = $6)
      ORDER BY r.enforcement_level ASC,
               r.requirement_type ASC,
               r.created_at ASC`,
    [
      input.clientId,
      serviceCatalogId,
      tradeCategoryId,
      filter.status ?? null,
      filter.enforcementLevel ?? null,
      filter.requirementType ?? null,
    ],
  );
  return result.rows.map(mapRow);
}

/**
 * Evaluation read: ACTIVE requirements only for one target. The evaluator
 * never needs INACTIVE rows, so this is a separate, index-friendly query
 * rather than a filter on top of the list read.
 */
async function listActiveByTarget(
  executor: Pick<PoolClient, 'query'> = getPool(),
  target: CompetencyRequirementTarget,
): Promise<CompetencyRequirementRecord[]> {
  const { serviceCatalogId, tradeCategoryId } = targetParams(target);
  const result = await executor.query(
    `${SELECT}
      WHERE (($1::uuid IS NOT NULL AND r.service_catalog_id = $1)
             OR ($2::uuid IS NOT NULL AND r.trade_category_id = $2))
        AND r.status = 'ACTIVE'
      ORDER BY r.enforcement_level ASC,
               r.requirement_type ASC,
               r.created_at ASC`,
    [serviceCatalogId, tradeCategoryId],
  );
  return result.rows.map(mapRow);
}

/** PART 03A entry point, preserved for the existing job-type evaluator. */
async function listActiveByServiceCatalog(
  executor: Pick<PoolClient, 'query'> = getPool(),
  serviceCatalogId: string,
): Promise<CompetencyRequirementRecord[]> {
  return listActiveByTarget(executor, {
    kind: 'SERVICE_CATALOG',
    serviceCatalogId,
  });
}

/**
 * PART 03B2A entry point for the multi-trade Work Order evaluator.
 *
 * The trade registry is PLATFORM-wide, while requirements are per Client, so
 * the Client is part of the read: a requirement another tenant configured for
 * the same trade can never gate this tenant's assignment.
 */
async function listActiveByTradeCategory(
  executor: Pick<PoolClient, 'query'> = getPool(),
  tradeCategoryId: string,
  clientId: string,
): Promise<CompetencyRequirementRecord[]> {
  const result = await executor.query(
    `${SELECT}
      WHERE r.trade_category_id = $1
        AND r.client_id = $2
        AND r.status = 'ACTIVE'
      ORDER BY r.enforcement_level ASC,
               r.requirement_type ASC,
               r.created_at ASC`,
    [tradeCategoryId, clientId],
  );
  return result.rows.map(mapRow);
}

/**
 * Duplicate probe, per Client. A trade category is platform-wide, so the
 * Client is part of the predicate: another tenant's requirement for the same
 * trade must never be mistaken for this tenant's (PART 03B2B isolation fix).
 */
async function findActiveSkillRequirement(
  executor: Pick<PoolClient, 'query'> = getPool(),
  input: { target: CompetencyRequirementTarget; clientId: string; skillId: string },
): Promise<CompetencyRequirementRecord | null> {
  const { serviceCatalogId, tradeCategoryId } = targetParams(input.target);
  const result = await executor.query(
    `${SELECT}
      WHERE (($1::uuid IS NOT NULL AND r.service_catalog_id = $1)
             OR ($2::uuid IS NOT NULL AND r.trade_category_id = $2))
        AND r.client_id = $4
        AND r.requirement_type = 'SKILL'
        AND r.skill_id = $3
        AND r.status = 'ACTIVE'`,
    [serviceCatalogId, tradeCategoryId, input.skillId, input.clientId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

async function findActiveCertificationRequirement(
  executor: Pick<PoolClient, 'query'> = getPool(),
  input: {
    target: CompetencyRequirementTarget;
    clientId: string;
    certificateName: string;
  },
): Promise<CompetencyRequirementRecord | null> {
  const { serviceCatalogId, tradeCategoryId } = targetParams(input.target);
  const result = await executor.query(
    `${SELECT}
      WHERE (($1::uuid IS NOT NULL AND r.service_catalog_id = $1)
             OR ($2::uuid IS NOT NULL AND r.trade_category_id = $2))
        AND r.client_id = $4
        AND r.requirement_type = 'CERTIFICATION'
        AND lower(btrim(r.certificate_name)) = lower(btrim($3))
        AND r.status = 'ACTIVE'`,
    [serviceCatalogId, tradeCategoryId, input.certificateName, input.clientId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

async function updateRequirement(
  executor: Pick<PoolClient, 'query'>,
  id: string,
  changes: CompetencyRequirementChanges,
): Promise<CompetencyRequirementRecord | null> {
  const result = await executor.query(
    `UPDATE service_catalog_competency_requirements
        SET enforcement_level = COALESCE($2, enforcement_level),
            minimum_proficiency_level =
              CASE WHEN $5::boolean
                   THEN $3
                   ELSE minimum_proficiency_level END,
            certificate_name =
              CASE WHEN $6::boolean
                   THEN $4
                   ELSE certificate_name END,
            notes = CASE WHEN $7::boolean THEN $8 ELSE notes END,
            updated_at = NOW()
      WHERE id = $1
        AND status = 'ACTIVE'
      RETURNING id`,
    [
      id,
      changes.enforcementLevel ?? null,
      changes.minimumProficiencyLevel ?? null,
      changes.certificateName ?? null,
      changes.minimumProficiencyLevel !== undefined,
      changes.certificateName !== undefined,
      changes.notes !== undefined,
      changes.notes === undefined ? null : changes.notes,
    ],
  );
  if (!result.rows[0]) return null;
  return findById(executor, id);
}

async function deactivateRequirement(
  executor: Pick<PoolClient, 'query'>,
  id: string,
): Promise<CompetencyRequirementRecord | null> {
  const result = await executor.query(
    `UPDATE service_catalog_competency_requirements
        SET status = 'INACTIVE',
            updated_at = NOW()
      WHERE id = $1
        AND status = 'ACTIVE'
      RETURNING id`,
    [id],
  );
  if (!result.rows[0]) return null;
  return findById(executor, id);
}

export const serviceCompetencyRequirementRepository = {
  deactivateRequirement,
  findActiveCertificationRequirement,
  findActiveSkillRequirement,
  findById,
  findScopedById,
  insertRequirement,
  listActiveByServiceCatalog,
  listActiveByTarget,
  listActiveByTradeCategory,
  listByTarget,
  updateRequirement,
};
