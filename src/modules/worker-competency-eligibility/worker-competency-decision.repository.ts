import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { getPool } from '../../database';
import type {
  AssignmentCompetencyEvaluationRow,
  AssignmentCompetencyHistoryItem,
  CompetencyGapReason,
} from './worker-competency-eligibility.types';

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 03B1 — assignment competency decision ledger
 * (`handyman_assignment_competency_evaluations`, migration `0464`).
 *
 * Writes are INSERT-only inside the assignment transaction; the table rejects
 * UPDATE/DELETE by trigger. Reads are always Client-scoped by the caller.
 *
 * Privacy: no certificate number, document id, storage key, document content or
 * token is ever written here (see the migration header for the rationale).
 */

type Row = QueryResultRow;

const SELECT = `
  SELECT id,
         decision_group_id,
         client_id,
         execution_scope_id,
         assignment_id,
         handyman_crew_id,
         action,
         service_catalog_id,
         worker_context_id,
         workforce_profile_id,
         requirement_id,
         requirement_type,
         enforcement_level,
         skill_id,
         skill_code,
         minimum_proficiency_level,
         certificate_name,
         satisfied,
         reason,
         evidence_proficiency_level,
         evidence_certification_id,
         evidence_verification_status,
         evidence_expiry_date,
         evaluated_at
    FROM handyman_assignment_competency_evaluations`;

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toNullableIso(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

function mapRow(row: Row): AssignmentCompetencyHistoryItem {
  return {
    id: row.id,
    decisionGroupId: row.decision_group_id,
    clientId: row.client_id,
    executionScopeId: row.execution_scope_id,
    assignmentId: row.assignment_id,
    crewId: row.handyman_crew_id,
    action: row.action,
    serviceCatalogId: row.service_catalog_id,
    workerContextId: row.worker_context_id,
    workforceProfileId: row.workforce_profile_id,
    requirementId: row.requirement_id,
    requirementType: row.requirement_type,
    enforcementLevel: row.enforcement_level,
    skillId: row.skill_id ?? null,
    skillCode: row.skill_code ?? null,
    minimumProficiencyLevel: row.minimum_proficiency_level ?? null,
    certificateName: row.certificate_name ?? null,
    satisfied: row.satisfied,
    reason: (row.reason as CompetencyGapReason | null) ?? null,
    evidenceProficiencyLevel: row.evidence_proficiency_level ?? null,
    evidenceCertificationId: row.evidence_certification_id ?? null,
    evidenceVerificationStatus: row.evidence_verification_status ?? null,
    evidenceExpiryDate: toNullableIso(row.evidence_expiry_date),
    evaluatedAt: toIso(row.evaluated_at),
  };
}

export type AppendDecisionRowsInput = {
  decisionGroupId: string;
  clientId: string;
  executionScopeId: string;
  assignmentId: string;
  crewId: string;
  action: 'ASSIGNED' | 'REASSIGNED';
  serviceCatalogId: string;
  rows: AssignmentCompetencyEvaluationRow[];
};

/**
 * Appends the whole decision group in ONE multi-row INSERT.
 *
 * Called only from the assignment transaction, after the assignment row exists
 * and before commit — so a rejected or rolled-back assignment can never leave a
 * decision behind, and a committed assignment always has its decision.
 */
async function appendDecisionGroup(
  executor: Pick<PoolClient, 'query'>,
  input: AppendDecisionRowsInput,
): Promise<number> {
  if (input.rows.length === 0) return 0;

  const values: unknown[] = [];
  const tuples: string[] = [];
  let index = 1;

  for (const row of input.rows) {
    tuples.push(
      `(${Array.from({ length: 23 }, () => `$${index++}`).join(', ')})`,
    );
    values.push(
      randomUUID(),
      input.decisionGroupId,
      input.clientId,
      input.executionScopeId,
      input.assignmentId,
      input.crewId,
      input.action,
      input.serviceCatalogId,
      row.workerContextId,
      row.workforceProfileId,
      row.requirementId,
      row.requirementType,
      row.enforcementLevel,
      row.skillId,
      row.skillCode,
      row.minimumProficiencyLevel,
      row.certificateName,
      row.satisfied,
      row.reason,
      row.evidenceProficiencyLevel,
      row.evidenceCertificationId,
      row.evidenceVerificationStatus,
      row.evidenceExpiryDate,
    );
  }

  const result = await executor.query(
    `INSERT INTO handyman_assignment_competency_evaluations (
       id, decision_group_id, client_id, execution_scope_id, assignment_id,
       handyman_crew_id, action, service_catalog_id, worker_context_id,
       workforce_profile_id, requirement_id, requirement_type,
       enforcement_level, skill_id, skill_code, minimum_proficiency_level,
       certificate_name, satisfied, reason, evidence_proficiency_level,
       evidence_certification_id, evidence_verification_status,
       evidence_expiry_date
     ) VALUES ${tuples.join(', ')}
     RETURNING id`,
    values,
  );
  return result.rowCount ?? 0;
}

export type ListDecisionHistoryInput = {
  clientId: string;
  executionScopeId: string;
  limit: number;
  offset: number;
  action?: 'ASSIGNED' | 'REASSIGNED';
  assignmentId?: string;
  crewId?: string;
  workerContextId?: string;
  satisfied?: boolean;
  enforcementLevel?: 'MANDATORY' | 'RECOMMENDED';
};

const HISTORY_FILTER = `
      WHERE client_id = $1
        AND execution_scope_id = $2
        AND ($3::text IS NULL OR action = $3)
        AND ($4::uuid IS NULL OR assignment_id = $4)
        AND ($5::uuid IS NULL OR handyman_crew_id = $5)
        AND ($6::uuid IS NULL OR worker_context_id = $6)
        AND ($7::boolean IS NULL OR satisfied = $7)
        AND ($8::text IS NULL OR enforcement_level = $8)`;

function filterParams(input: ListDecisionHistoryInput): unknown[] {
  return [
    input.clientId,
    input.executionScopeId,
    input.action ?? null,
    input.assignmentId ?? null,
    input.crewId ?? null,
    input.workerContextId ?? null,
    input.satisfied === undefined ? null : input.satisfied,
    input.enforcementLevel ?? null,
  ];
}

async function listDecisionHistory(
  executor: Pick<PoolClient, 'query'> = getPool(),
  input: ListDecisionHistoryInput,
): Promise<AssignmentCompetencyHistoryItem[]> {
  const result = await executor.query(
    `${SELECT}${HISTORY_FILTER}
      ORDER BY evaluated_at DESC, id DESC
      LIMIT $9 OFFSET $10`,
    [...filterParams(input), input.limit, input.offset],
  );
  return result.rows.map(mapRow);
}

async function countDecisionHistory(
  executor: Pick<PoolClient, 'query'> = getPool(),
  input: ListDecisionHistoryInput,
): Promise<number> {
  const result = await executor.query(
    `SELECT COUNT(*)::int AS total
       FROM handyman_assignment_competency_evaluations${HISTORY_FILTER}`,
    filterParams(input),
  );
  return result.rows[0]?.total ?? 0;
}

export const workerCompetencyDecisionRepository = {
  appendDecisionGroup,
  countDecisionHistory,
  listDecisionHistory,
};
