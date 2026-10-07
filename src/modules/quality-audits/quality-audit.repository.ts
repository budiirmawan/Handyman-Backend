import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  CompleteQualityAuditInput,
  QualityAuditFilter,
  QualityAuditRecord,
  QualityAuditResult,
  QualityAuditSourceType,
  QualityAuditStatus,
  UpdateQualityAuditInput,
} from './quality-audit.types';

type QualityAuditRow = {
  id: string;
  client_id: string;
  building_id: string;
  cleaning_area_id: string | null;
  source_type: QualityAuditSourceType;
  source_id: string;
  auditor_user_id: string;
  score: string | number | null;
  result: QualityAuditResult | null;
  status: QualityAuditStatus;
  notes: string | null;
  audited_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type QualityAuditWithContextRow = QualityAuditRow & {
  area_code: string | null;
  area_name: string | null;
  area_status: string | null;
};

function mapRow(row: QualityAuditRow): QualityAuditRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    cleaningAreaId: row.cleaning_area_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    auditorUserId: row.auditor_user_id,
    score: row.score === null ? null : Number(row.score),
    result: row.result,
    status: row.status,
    notes: row.notes,
    auditedAt: row.audited_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function create(input: {
  clientId: string;
  buildingId: string;
  cleaningAreaId: string | null;
  sourceType: QualityAuditSourceType;
  sourceId: string;
  auditorUserId: string;
  score?: number | null;
  result?: QualityAuditResult | null;
  notes?: string | null;
}): Promise<QualityAuditRecord> {
  const result = await getPool().query<QualityAuditRow>(
    `INSERT INTO quality_audits
       (id, client_id, building_id, cleaning_area_id, source_type,
        source_id, auditor_user_id, score, result, notes, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'DRAFT')
     RETURNING *`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.cleaningAreaId,
      input.sourceType,
      input.sourceId,
      input.auditorUserId,
      input.score ?? null,
      input.result ?? null,
      input.notes ?? null,
    ],
  );
  return mapRow(result.rows[0]);
}

export async function findById(
  id: string,
): Promise<QualityAuditWithContextRow | null> {
  const result = await getPool().query<QualityAuditWithContextRow>(
    `SELECT
       qa.*,
       ca.code AS area_code,
       ca.name AS area_name,
       ca.status AS area_status
     FROM quality_audits qa
     LEFT JOIN cleaning_areas ca ON ca.id = qa.cleaning_area_id
     WHERE qa.id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/**
 * CR-BE-RN15-CLEANING-QUALITY-MOBILE-01 — the single current DRAFT audit of one
 * audited source.
 *
 * Migration 0353 caps `(source_type, source_id) WHERE status = 'DRAFT'` at one
 * row, so this is a genuine single-row lookup and never picks a winner.
 * COMPLETED history is excluded by the `status` predicate, not ordered and
 * truncated, so a completed audit never masquerades as the open one.
 */
export async function findDraftBySource(
  sourceType: QualityAuditSourceType,
  sourceId: string,
): Promise<QualityAuditWithContextRow | null> {
  const result = await getPool().query<QualityAuditWithContextRow>(
    `SELECT
       qa.*,
       ca.code AS area_code,
       ca.name AS area_name,
       ca.status AS area_status
     FROM quality_audits qa
     LEFT JOIN cleaning_areas ca ON ca.id = qa.cleaning_area_id
     WHERE qa.source_type = $1
       AND qa.source_id = $2
       AND qa.status = 'DRAFT'`,
    [sourceType, sourceId],
  );
  return result.rows[0] ?? null;
}

export async function list(
  filter: QualityAuditFilter = {},
): Promise<QualityAuditWithContextRow[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filter.buildingId) {
    values.push(filter.buildingId);
    conditions.push(`qa.building_id = $${values.length}`);
  }

  if (filter.cleaningAreaId) {
    values.push(filter.cleaningAreaId);
    conditions.push(`qa.cleaning_area_id = $${values.length}`);
  }

  if (filter.sourceType) {
    values.push(filter.sourceType);
    conditions.push(`qa.source_type = $${values.length}`);
  }

  if (filter.result) {
    values.push(filter.result);
    conditions.push(`qa.result = $${values.length}`);
  }

  if (filter.status) {
    values.push(filter.status);
    conditions.push(`qa.status = $${values.length}`);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await getPool().query<QualityAuditWithContextRow>(
    `SELECT
       qa.*,
       ca.code AS area_code,
       ca.name AS area_name,
       ca.status AS area_status
     FROM quality_audits qa
     LEFT JOIN cleaning_areas ca ON ca.id = qa.cleaning_area_id
     ${whereClause}
     ORDER BY qa.created_at DESC`,
    values,
  );
  return result.rows;
}

export async function update(
  id: string,
  input: UpdateQualityAuditInput,
): Promise<QualityAuditRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.score !== undefined) {
    values.push(input.score);
    sets.push(`score = $${values.length}`);
  }

  if (input.result !== undefined) {
    values.push(input.result);
    sets.push(`result = $${values.length}`);
  }

  if (input.notes !== undefined) {
    values.push(input.notes);
    sets.push(`notes = $${values.length}`);
  }

  if (sets.length === 0) {
    const existing = await findById(id);
    return existing ? mapRow(existing) : null;
  }

  values.push(id);
  const result = await getPool().query<QualityAuditRow>(
    `UPDATE quality_audits
     SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $${values.length}
     RETURNING *`,
    values,
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function complete(
  id: string,
  input: CompleteQualityAuditInput,
): Promise<QualityAuditRecord | null> {
  const sets = [
    'result = $1',
    'score = COALESCE($2, score)',
    'notes = COALESCE($3, notes)',
    "status = 'COMPLETED'",
    'audited_at = NOW()',
    'updated_at = NOW()',
  ];
  const values = [input.result, input.score ?? null, input.notes ?? null, id];

  const result = await getPool().query<QualityAuditRow>(
    `UPDATE quality_audits
     SET ${sets.join(', ')}
     WHERE id = $4
     RETURNING *`,
    values,
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/**
 * CR-BE-RN15-CLEANING-QUALITY-MOBILE-01 — true when the error is the database
 * refusing a SECOND DRAFT for one source (migration 0353). Used to translate a
 * race that slipped past the service pre-check into the same 409 the pre-check
 * raises, so the invariant holds under concurrency too.
 */
export function isDraftQualityAuditUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint === 'quality_audits_source_draft_unique'
  );
}

export const qualityAuditRepository = {
  complete,
  create,
  findById,
  findDraftBySource,
  isDraftQualityAuditUniqueViolation,
  list,
  update,
};
