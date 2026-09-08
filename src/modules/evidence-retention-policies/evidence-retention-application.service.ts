import { getPool } from '../../database';
import { recordOperationalEvent } from '../operational-events';
import { evidenceRetentionPolicyRepository } from './evidence-retention-policy.repository';

/**
 * CR-BE-DOC-CONTROL-01 PART 03 — deterministic retention application
 * (START GOVERNANCE §5, §6).
 *
 * Invoked by every evidence submission path immediately after the row is
 * created. Resolves the applicable ACTIVE retention policy of the evidence's
 * Client (optionally Building-scoped through the evidence's PARENT record)
 * and freezes an immutable snapshot onto the evidence row:
 *
 *   retained_until          anchor + retention_days
 *                           (anchor = captured_at ?? created_at)
 *   retention_policy_id/-code/retention_days_snapshot/retention_applied_at
 *                           identity AND frozen content of the applied rule —
 *                           later policy edits never rewrite governed history.
 *
 * Precedence: additive specificity (building +4, execution_type +2,
 * evidence_type +1), highest wins. A TIE at the top score is an ambiguity —
 * the evidence is left UNGOVERNED and an EVIDENCE_RETENTION_AMBIGUOUS event
 * records the candidates; nothing is guessed. NO matching policy is a valid
 * state: the row stays ungoverned (retained_until IS NULL) and is never
 * purged.
 *
 * Application is prospective only — this seam runs at evidence creation.
 * Activating a policy later never sweeps existing evidence (§11), and this
 * seam never re-applies to an already-governed row.
 */

/** Parent lookup per execution type to derive the Building scope (if any). */
const PARENT_BUILDING_SQL: Record<string, string> = {
  WORK_ORDER: 'SELECT building_id FROM work_orders WHERE id = $1',
  VENDOR_WORK: 'SELECT building_id FROM vendor_works WHERE id = $1',
  UTILITY_METER_READING: 'SELECT building_id FROM utility_meter_readings WHERE id = $1',
  PERMIT: 'SELECT building_id FROM permits WHERE id = $1',
  FINDING: 'SELECT building_id FROM findings WHERE id = $1',
  FINDING_REWORK: `SELECT f.building_id FROM finding_rework_cycles r
     JOIN findings f ON f.id = r.finding_id WHERE r.id = $1`,
  FINDING_VERIFICATION: `SELECT f.building_id FROM reviews r
     JOIN findings f ON f.id = r.target_id
    WHERE r.id = $1 AND r.target_type = 'FINDING'`,
  // FORM_INSTANCE / CHECKLIST_EXECUTION carry no building — client scope only.
};

async function resolveParentBuildingId(
  executionType: string,
  executionId: string,
): Promise<string | null> {
  const sql = PARENT_BUILDING_SQL[executionType];
  if (!sql) {
    return null;
  }
  const result = await getPool().query<{ building_id: string | null }>(sql, [executionId]);
  return result.rows[0]?.building_id ?? null;
}

export type RetentionApplicationResult =
  | { applied: true; policyId: string; policyCode: string; retainedUntil: Date }
  | { applied: false; reason: 'NO_POLICY' | 'AMBIGUOUS' | 'ALREADY_GOVERNED' };

/**
 * Applies the governing retention policy to one newly created evidence
 * submission. Never throws for no-match/ambiguity; those are governed
 * non-application outcomes.
 */
export async function applyRetentionToEvidence(
  evidenceId: string,
  actorUserId: string | null,
): Promise<RetentionApplicationResult> {
  const loaded = await getPool().query<{
    id: string;
    client_id: string;
    execution_type: string;
    execution_id: string;
    evidence_type: string;
    captured_at: Date | null;
    created_at: Date;
    retention_policy_id: string | null;
  }>(
    `SELECT id, client_id, execution_type, execution_id, evidence_type,
            captured_at, created_at, retention_policy_id
       FROM evidence_submissions WHERE id = $1`,
    [evidenceId],
  );
  const row = loaded.rows[0];
  if (!row) {
    return { applied: false, reason: 'NO_POLICY' };
  }
  if (row.retention_policy_id) {
    // Snapshots are immutable — never re-applied (§6).
    return { applied: false, reason: 'ALREADY_GOVERNED' };
  }

  const buildingId = await resolveParentBuildingId(row.execution_type, row.execution_id);
  const anchor = row.captured_at ?? row.created_at;
  const candidates = await evidenceRetentionPolicyRepository.selectApplicable(
    row.client_id,
    buildingId,
    row.execution_type,
    row.evidence_type,
    anchor,
  );

  if (candidates.length === 0) {
    return { applied: false, reason: 'NO_POLICY' };
  }

  const top = candidates[0];
  if (candidates[1]?.specificity === top.specificity) {
    // Tied precedence — never guess: leave ungoverned, record the ambiguity.
    await recordOperationalEvent({
      clientId: row.client_id,
      buildingId,
      eventType: 'EVIDENCE_RETENTION_AMBIGUOUS',
      entityType: 'EVIDENCE_SUBMISSION',
      entityId: evidenceId,
      actorUserId,
      summary: 'Applicable evidence retention policies are ambiguous; evidence left ungoverned',
      metadata: {
        evidenceId,
        candidatePolicyIds: candidates
          .filter((candidate) => candidate.specificity === top.specificity)
          .map((candidate) => candidate.id),
        specificity: top.specificity,
      },
    });
    return { applied: false, reason: 'AMBIGUOUS' };
  }

  const updated = await getPool().query<{ retained_until: Date }>(
    `UPDATE evidence_submissions
        SET retention_policy_id = $2,
            retention_policy_code = $3,
            retention_days_snapshot = $4,
            retention_applied_at = NOW(),
            retained_until = $5::timestamptz + make_interval(days => $4),
            updated_at = NOW()
      WHERE id = $1 AND retention_policy_id IS NULL
      RETURNING retained_until`,
    [evidenceId, top.id, top.code, top.retentionDays, anchor],
  );
  if (updated.rowCount === 0) {
    return { applied: false, reason: 'ALREADY_GOVERNED' };
  }
  const retainedUntil = updated.rows[0].retained_until;

  await recordOperationalEvent({
    clientId: row.client_id,
    buildingId,
    eventType: 'EVIDENCE_RETENTION_APPLIED',
    entityType: 'EVIDENCE_SUBMISSION',
    entityId: evidenceId,
    actorUserId,
    summary: `Retention policy ${top.code} applied to evidence`,
    metadata: {
      evidenceId,
      policyId: top.id,
      policyCode: top.code,
      retentionDays: top.retentionDays,
      retainedUntil: retainedUntil.toISOString(),
    },
  });

  return {
    applied: true,
    policyId: top.id,
    policyCode: top.code,
    retainedUntil,
  };
}
