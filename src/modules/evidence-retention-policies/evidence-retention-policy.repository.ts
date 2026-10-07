import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  ApplicableRetentionPolicy,
  CreateEvidenceRetentionPolicyInput,
  EvidenceRetentionPolicyFilters,
  EvidenceRetentionPolicyRecord,
  UpdateEvidenceRetentionPolicyInput,
} from './evidence-retention-policy.types';

/** CR-BE-DOC-CONTROL-01 PART 03 — retention policy persistence. */

const S = `id, client_id AS "clientId", building_id AS "buildingId", code, name,
  evidence_type AS "evidenceType", execution_type AS "executionType",
  retention_days AS "retentionDays", status,
  effective_from AS "effectiveFrom", effective_to AS "effectiveTo",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

async function create(
  input: CreateEvidenceRetentionPolicyInput,
): Promise<EvidenceRetentionPolicyRecord> {
  const result = await getPool().query<EvidenceRetentionPolicyRecord>(
    `INSERT INTO evidence_retention_policies
       (id, client_id, building_id, code, name, evidence_type, execution_type,
        retention_days, status, effective_from, effective_to)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING ${S}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId ?? null,
      input.code,
      input.name,
      input.evidenceType ?? null,
      input.executionType ?? null,
      input.retentionDays,
      input.status ?? 'ACTIVE',
      input.effectiveFrom,
      input.effectiveTo ?? null,
    ],
  );
  return result.rows[0];
}

async function findById(id: string): Promise<EvidenceRetentionPolicyRecord | null> {
  const result = await getPool().query<EvidenceRetentionPolicyRecord>(
    `SELECT ${S} FROM evidence_retention_policies WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function list(
  clientId: string,
  filters: EvidenceRetentionPolicyFilters,
): Promise<EvidenceRetentionPolicyRecord[]> {
  const values: unknown[] = [clientId];
  const where = ['client_id = $1'];
  if (filters.buildingId !== undefined) {
    values.push(filters.buildingId);
    where.push(`building_id = $${values.length}`);
  }
  if (filters.status !== undefined) {
    values.push(filters.status);
    where.push(`status = $${values.length}`);
  }
  const result = await getPool().query<EvidenceRetentionPolicyRecord>(
    `SELECT ${S} FROM evidence_retention_policies
      WHERE ${where.join(' AND ')} ORDER BY code, effective_from`,
    values,
  );
  return result.rows;
}

async function update(
  id: string,
  input: UpdateEvidenceRetentionPolicyInput,
): Promise<EvidenceRetentionPolicyRecord | null> {
  const map: Record<string, string> = {
    name: 'name',
    evidenceType: 'evidence_type',
    executionType: 'execution_type',
    retentionDays: 'retention_days',
    status: 'status',
    effectiveFrom: 'effective_from',
    effectiveTo: 'effective_to',
  };
  const values: unknown[] = [];
  const sets: string[] = [];
  for (const [key, column] of Object.entries(map)) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      values.push((input as Record<string, unknown>)[key] ?? null);
      sets.push(`${column} = $${values.length}`);
    }
  }
  values.push(id);
  const result = await getPool().query<EvidenceRetentionPolicyRecord>(
    `UPDATE evidence_retention_policies
        SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = $${values.length}
      RETURNING ${S}`,
    values,
  );
  return result.rows[0] ?? null;
}

/**
 * Deterministic precedence (START GOVERNANCE §5): among ACTIVE policies of
 * the evidence's Client that are effective at the anchor instant and whose
 * scoping fields are each NULL or equal to the evidence's values, score
 * building +4, execution_type +2, evidence_type +1; highest score wins.
 * A NULL evidence building matches only client-wide policies.
 */
async function selectApplicable(
  clientId: string,
  buildingId: string | null,
  executionType: string,
  evidenceType: string,
  at: Date,
): Promise<ApplicableRetentionPolicy[]> {
  const result = await getPool().query<ApplicableRetentionPolicy>(
    `SELECT id, code, retention_days AS "retentionDays",
            (CASE WHEN building_id IS NOT NULL THEN 4 ELSE 0 END
             + CASE WHEN execution_type IS NOT NULL THEN 2 ELSE 0 END
             + CASE WHEN evidence_type IS NOT NULL THEN 1 ELSE 0 END)::int AS specificity
       FROM evidence_retention_policies
      WHERE client_id = $1
        AND (building_id IS NULL OR building_id = $2)
        AND (execution_type IS NULL OR execution_type = $3)
        AND (evidence_type IS NULL OR evidence_type = $4)
        AND status = 'ACTIVE'
        AND effective_from <= $5
        AND (effective_to IS NULL OR effective_to > $5)
      ORDER BY specificity DESC, code`,
    [clientId, buildingId, executionType, evidenceType, at],
  );
  return result.rows;
}

export const evidenceRetentionPolicyRepository = {
  create,
  findById,
  list,
  update,
  selectApplicable,
};
