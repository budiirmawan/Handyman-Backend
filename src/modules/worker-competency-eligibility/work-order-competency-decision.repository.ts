import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { getPool } from '../../database';
import type {
  WorkOrderCompetencyDecisionRow,
  WorkOrderCompetencyHistoryItem,
} from './worker-competency-eligibility.types';

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 03B2A — append-only decision ledger for
 * Work Order assignment (`work_order_assignment_competency_decisions`, 0465).
 *
 * Same discipline as the Handyman ledger of PART 03B1 (0464):
 *   - every write is an INSERT (the table rejects UPDATE/DELETE by trigger),
 *   - rows are written in the SAME transaction as the assignment, so a refused
 *     assignment leaves nothing behind,
 *   - the snapshot keeps the minimum evidence (opaque certificate id,
 *     verification status, expiry date, proficiency level) and never a
 *     certificate number, document id, storage key or document content.
 */

type Row = QueryResultRow;

const SELECT = `
  SELECT id,
         decision_group_id,
         client_id,
         work_order_id,
         assignment_id,
         action,
         assignee_type,
         trade_category_id,
         trade_category_code,
         risk_level,
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
    FROM work_order_assignment_competency_decisions`;

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toNullableIso(value: Date | string | null): string | null {
  return value === null || value === undefined ? null : toIso(value);
}

function mapRow(row: Row): WorkOrderCompetencyHistoryItem {
  return {
    id: row.id,
    decisionGroupId: row.decision_group_id,
    clientId: row.client_id,
    workOrderId: row.work_order_id,
    assignmentId: row.assignment_id,
    action: row.action,
    assigneeType: row.assignee_type,
    tradeCategoryId: row.trade_category_id ?? null,
    tradeCategoryCode: row.trade_category_code ?? null,
    riskLevel: row.risk_level ?? null,
    workforceProfileId: row.workforce_profile_id,
    requirementId: row.requirement_id,
    requirementType: row.requirement_type,
    enforcementLevel: row.enforcement_level,
    skillId: row.skill_id ?? null,
    skillCode: row.skill_code ?? null,
    minimumProficiencyLevel: row.minimum_proficiency_level ?? null,
    certificateName: row.certificate_name ?? null,
    satisfied: row.satisfied,
    reason: row.reason ?? null,
    evidenceProficiencyLevel: row.evidence_proficiency_level ?? null,
    evidenceCertificationId: row.evidence_certification_id ?? null,
    evidenceVerificationStatus: row.evidence_verification_status ?? null,
    evidenceExpiryDate: toNullableIso(row.evidence_expiry_date),
    evaluatedAt: toIso(row.evaluated_at),
  };
}

export type AppendWorkOrderDecisionRowsInput = {
  decisionGroupId: string;
  clientId: string;
  workOrderId: string;
  assignmentId: string;
  action: 'ASSIGNED' | 'REASSIGNED';
  assigneeType: 'WORKFORCE' | 'TEAM' | 'VENDOR' | 'VENDOR_WORKFORCE';
  tradeCategoryId: string | null;
  tradeCategoryCode: string | null;
  riskLevel: string | null;
  rows: WorkOrderCompetencyDecisionRow[];
};

/**
 * Appends the whole decision group in ONE multi-row INSERT, inside the caller's
 * assignment transaction.
 */
async function appendDecisionGroup(
  executor: Pick<PoolClient, 'query'>,
  input: AppendWorkOrderDecisionRowsInput,
): Promise<number> {
  if (input.rows.length === 0) return 0;

  const columns = 24;
  const values: unknown[] = [];
  const tuples: string[] = [];
  let index = 1;

  for (const row of input.rows) {
    values.push(
      randomUUID(),
      input.decisionGroupId,
      input.clientId,
      input.workOrderId,
      input.assignmentId,
      input.action,
      input.assigneeType,
      input.tradeCategoryId,
      input.tradeCategoryCode,
      input.riskLevel,
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
    tuples.push(
      `(${Array.from({ length: columns }, () => `$${index++}`).join(', ')})`,
    );
  }

  const result = await executor.query(
    `INSERT INTO work_order_assignment_competency_decisions (
       id, decision_group_id, client_id, work_order_id, assignment_id,
       action, assignee_type, trade_category_id, trade_category_code,
       risk_level, workforce_profile_id, requirement_id, requirement_type,
       enforcement_level, skill_id, skill_code, minimum_proficiency_level,
       certificate_name, satisfied, reason, evidence_proficiency_level,
       evidence_certification_id, evidence_verification_status,
       evidence_expiry_date
     ) VALUES ${tuples.join(', ')}`,
    values,
  );
  return result.rowCount ?? 0;
}

async function listDecisionHistory(
  executor: Pick<PoolClient, 'query'> = getPool(),
  input: {
    clientId: string;
    workOrderId: string;
    limit: number;
    offset: number;
    action?: 'ASSIGNED' | 'REASSIGNED';
    assignmentId?: string;
    workforceProfileId?: string;
    satisfied?: boolean;
    enforcementLevel?: 'MANDATORY' | 'RECOMMENDED';
  },
): Promise<WorkOrderCompetencyHistoryItem[]> {
  const result = await executor.query(
    `${SELECT}
      WHERE client_id = $1
        AND work_order_id = $2
        AND ($3::text IS NULL OR action = $3)
        AND ($4::uuid IS NULL OR assignment_id = $4)
        AND ($5::uuid IS NULL OR workforce_profile_id = $5)
        AND ($6::boolean IS NULL OR satisfied = $6)
        AND ($7::text IS NULL OR enforcement_level = $7)
      ORDER BY evaluated_at DESC, id DESC
      LIMIT $8 OFFSET $9`,
    [
      input.clientId,
      input.workOrderId,
      input.action ?? null,
      input.assignmentId ?? null,
      input.workforceProfileId ?? null,
      input.satisfied === undefined ? null : input.satisfied,
      input.enforcementLevel ?? null,
      input.limit,
      input.offset,
    ],
  );
  return result.rows.map(mapRow);
}

async function countDecisionHistory(
  executor: Pick<PoolClient, 'query'> = getPool(),
  input: {
    clientId: string;
    workOrderId: string;
    action?: 'ASSIGNED' | 'REASSIGNED';
    assignmentId?: string;
    workforceProfileId?: string;
    satisfied?: boolean;
    enforcementLevel?: 'MANDATORY' | 'RECOMMENDED';
  },
): Promise<number> {
  const result = await executor.query(
    `SELECT COUNT(*)::int AS total
       FROM work_order_assignment_competency_decisions
      WHERE client_id = $1
        AND work_order_id = $2
        AND ($3::text IS NULL OR action = $3)
        AND ($4::uuid IS NULL OR assignment_id = $4)
        AND ($5::uuid IS NULL OR workforce_profile_id = $5)
        AND ($6::boolean IS NULL OR satisfied = $6)
        AND ($7::text IS NULL OR enforcement_level = $7)`,
    [
      input.clientId,
      input.workOrderId,
      input.action ?? null,
      input.assignmentId ?? null,
      input.workforceProfileId ?? null,
      input.satisfied === undefined ? null : input.satisfied,
      input.enforcementLevel ?? null,
    ],
  );
  return result.rows[0]?.total ?? 0;
}

export const workOrderCompetencyDecisionRepository = {
  appendDecisionGroup,
  countDecisionHistory,
  listDecisionHistory,
};
