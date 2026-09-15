import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { getPool } from '../../database';
import { clampDueItemLimit } from '../../shared/due-retrieval';
import type { SlaEscalationLevelRecord } from '../sla-escalation-policies/sla-escalation-policy.types';
import type {
  ApplicableEscalationPolicy,
  SlaBreachContext,
  SlaEscalationActionRecord,
  SlaEscalationCancelReason,
} from './sla-escalation-action.types';

/** Any executor: the pool, or the caller's open transaction client. */
type Q = Pick<Pool | PoolClient, 'query'>;

const A = `id,applied_sla_id AS "appliedSlaId",sla_clock_id AS "slaClockId",work_order_id AS "workOrderId",client_id AS "clientId",building_id AS "buildingId",clock_type AS "clockType",policy_id AS "policyId",escalation_level_id AS "escalationLevelId",level,template_key AS "templateKey",recipient_rule AS "recipientRule",breached_at AS "breachedAt",due_at AS "dueAt",status,triggered_at AS "triggeredAt",cancelled_at AS "cancelledAt",cancel_reason AS "cancelReason",recipients_resolved AS "recipientsResolved",notifications_created AS "notificationsCreated",failure_reason AS "failureReason",created_at AS "createdAt",updated_at AS "updatedAt"`;

const LEVEL = `id,policy_id AS "policyId",level,offset_minutes AS "offsetMinutes",template_key AS "templateKey",recipient_rule AS "recipientRule",status,created_at AS "createdAt",updated_at AS "updatedAt"`;

/**
 * Candidate policies for one breach, scored by the frozen specificity rule:
 * Building 8, exact `clock_type` (not `ANY`) 4, `work_type` 2, `priority` 1.
 *
 * The filter mirrors SLA-01's `selectApplicable` shape exactly — same Client,
 * ACTIVE, effective at the breach instant, `WORK_ORDER`, Building/work type/
 * priority NULL-or-equal — plus the `ANY` clock-type widening. Ordering is
 * deterministic so the caller can compare the top two scores for a tie.
 */
async function findApplicablePolicies(
  ctx: Pick<SlaBreachContext, 'clientId' | 'buildingId' | 'clockType' | 'workType' | 'priority' | 'breachedAt'>,
  q: Q,
): Promise<ApplicableEscalationPolicy[]> {
  return (
    await q.query<ApplicableEscalationPolicy>(
      `SELECT id,client_id AS "clientId",building_id AS "buildingId",code,clock_type AS "clockType",work_type AS "workType",priority,
              (CASE WHEN building_id IS NOT NULL THEN 8 ELSE 0 END
               +CASE WHEN clock_type<>'ANY' THEN 4 ELSE 0 END
               +CASE WHEN work_type IS NOT NULL THEN 2 ELSE 0 END
               +CASE WHEN priority IS NOT NULL THEN 1 ELSE 0 END)::int AS specificity
         FROM sla_escalation_policies
        WHERE client_id=$1
          AND (building_id IS NULL OR building_id=$2)
          AND operational_type='WORK_ORDER'
          AND status='ACTIVE'
          AND (clock_type=$3 OR clock_type='ANY')
          AND effective_from<=$6 AND (effective_to IS NULL OR effective_to>$6)
          AND (work_type IS NULL OR work_type=$4)
          AND (priority IS NULL OR priority=$5)
        ORDER BY specificity DESC,code`,
      [ctx.clientId, ctx.buildingId, ctx.clockType, ctx.workType, ctx.priority, ctx.breachedAt],
    )
  ).rows;
}

/** ACTIVE levels of the selected policy, in escalation order. */
async function findActiveLevels(policyId: string, q: Q): Promise<SlaEscalationLevelRecord[]> {
  return (
    await q.query<SlaEscalationLevelRecord>(
      `SELECT ${LEVEL} FROM sla_escalation_levels WHERE policy_id=$1 AND status='ACTIVE' ORDER BY level`,
      [policyId],
    )
  ).rows;
}

/**
 * Inserts one PENDING action, snapshotting `template_key` / `recipient_rule`
 * and freezing `due_at = breached_at + offset_minutes`.
 *
 * `ON CONFLICT DO NOTHING` on `UNIQUE (sla_clock_id, escalation_level_id)` is
 * idempotency layer 2: a duplicate materialization attempt returns `null`
 * instead of creating a second row or aborting the caller's transaction.
 */
async function insertAction(
  ctx: SlaBreachContext,
  policyId: string,
  level: SlaEscalationLevelRecord,
  q: Q,
): Promise<SlaEscalationActionRecord | null> {
  return (
    await q.query<SlaEscalationActionRecord>(
      `INSERT INTO sla_escalation_actions(id,applied_sla_id,sla_clock_id,work_order_id,client_id,building_id,clock_type,policy_id,escalation_level_id,level,template_key,recipient_rule,breached_at,due_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::timestamptz,$13::timestamptz+make_interval(mins=>$14::int))
       ON CONFLICT ON CONSTRAINT sla_escalation_actions_clock_level_unique DO NOTHING
       RETURNING ${A}`,
      [
        randomUUID(),
        ctx.appliedSlaId,
        ctx.slaClockId,
        ctx.workOrderId,
        ctx.clientId,
        ctx.buildingId,
        ctx.clockType,
        policyId,
        level.id,
        level.level,
        level.templateKey,
        JSON.stringify(level.recipientRule),
        ctx.breachedAt,
        level.offsetMinutes,
      ],
    )
  ).rows[0] ?? null;
}

/**
 * Cancels every still-`PENDING` action of one clock. Status-guarded, so
 * already-`TRIGGERED` (immutable history), `CANCELLED`, and `SKIPPED` rows are
 * never rewritten.
 */
async function cancelPendingForClock(
  slaClockId: string,
  reason: SlaEscalationCancelReason,
  at: Date,
  q: Q,
): Promise<SlaEscalationActionRecord[]> {
  return (
    await q.query<SlaEscalationActionRecord>(
      `UPDATE sla_escalation_actions SET status='CANCELLED',cancelled_at=$2,cancel_reason=$3,updated_at=NOW()
        WHERE sla_clock_id=$1 AND status='PENDING' RETURNING ${A}`,
      [slaClockId, at, reason],
    )
  ).rows;
}

/**
 * CR-BE-SLA-02 PART 03 — due-action enumeration.
 *
 * Mirrors `findDueRunning` on `sla_clocks` and BE-26I's `findDue`: `PENDING`
 * and `due_at <= before`, deterministically ordered, bounded by the shared
 * `clampDueItemLimit` so one pass can never load an unbounded backlog after an
 * outage. `FOR UPDATE SKIP LOCKED` keeps concurrent workers off each other's
 * rows when the caller runs this inside a transaction; it is an efficiency
 * measure only — the authoritative concurrency primitive is `claimAction`.
 */
async function findDueActions(before: Date, limit: number | undefined, q: Q): Promise<SlaEscalationActionRecord[]> {
  return (
    await q.query<SlaEscalationActionRecord>(
      `SELECT ${A} FROM sla_escalation_actions
        WHERE status='PENDING' AND due_at<=$1
        ORDER BY due_at ASC,level ASC,id ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [before, clampDueItemLimit(limit)],
    )
  ).rows;
}

/**
 * CR-BE-SLA-02 PART 03 — claim-before-send (idempotency layer 4).
 *
 * The guarded `PENDING → TRIGGERED` transition. Exactly one caller can ever
 * receive a row for a given action: PostgreSQL serializes the concurrent
 * UPDATEs on the row, and the loser re-evaluates `status='PENDING'` against the
 * winner's committed value and matches nothing. A `null` return therefore means
 * "someone else owns this action" and the caller MUST NOT resolve recipients,
 * render, or create notifications.
 */
async function claimAction(id: string, at: Date, q: Q): Promise<SlaEscalationActionRecord | null> {
  return (
    await q.query<SlaEscalationActionRecord>(
      `UPDATE sla_escalation_actions SET status='TRIGGERED',triggered_at=$2,updated_at=NOW()
        WHERE id=$1 AND status='PENDING' RETURNING ${A}`,
      [id, at],
    )
  ).rows[0] ?? null;
}

/**
 * CR-BE-SLA-02 PART 03 — trigger outcome persistence.
 *
 * Writes the observability counters onto the already-claimed row. Guarded by
 * `status='TRIGGERED'` so it can only ever annotate a claim this process won,
 * never resurrect or rewrite a `CANCELLED`/`SKIPPED`/`PENDING` action. It
 * deliberately cannot change `status` — a claimed action stays TRIGGERED even
 * when the side effect failed halfway (at-most-once, never revert).
 */
async function recordTriggerResult(
  id: string,
  result: { recipientsResolved: number; notificationsCreated: number; failureReason: string | null },
  q: Q,
): Promise<SlaEscalationActionRecord | null> {
  return (
    await q.query<SlaEscalationActionRecord>(
      `UPDATE sla_escalation_actions
          SET recipients_resolved=$2,notifications_created=$3,failure_reason=$4,updated_at=NOW()
        WHERE id=$1 AND status='TRIGGERED' RETURNING ${A}`,
      [id, result.recipientsResolved, result.notificationsCreated, result.failureReason],
    )
  ).rows[0] ?? null;
}

/** Single-action read seam (executor-aware); used by the trigger pre-check. */
async function findActionById(id: string, q: Q = getPool()): Promise<SlaEscalationActionRecord | null> {
  return (await q.query<SlaEscalationActionRecord>(`SELECT ${A} FROM sla_escalation_actions WHERE id=$1`, [id]))
    .rows[0] ?? null;
}

/** Read seam for the ledger of one clock (ordered); used by tests and PART 05. */
async function listActionsForClock(slaClockId: string, q: Q = getPool()): Promise<SlaEscalationActionRecord[]> {
  return (
    await q.query<SlaEscalationActionRecord>(
      `SELECT ${A} FROM sla_escalation_actions WHERE sla_clock_id=$1 ORDER BY level`,
      [slaClockId],
    )
  ).rows;
}

/** Read seam for the ledger of one Work Order (ordered); used by tests and PART 05. */
async function listActionsForWorkOrder(workOrderId: string, q: Q = getPool()): Promise<SlaEscalationActionRecord[]> {
  return (
    await q.query<SlaEscalationActionRecord>(
      `SELECT ${A} FROM sla_escalation_actions WHERE work_order_id=$1 ORDER BY clock_type,level`,
      [workOrderId],
    )
  ).rows;
}

export const slaEscalationActionRepository = {
  findApplicablePolicies,
  findActiveLevels,
  insertAction,
  cancelPendingForClock,
  findDueActions,
  claimAction,
  recordTriggerResult,
  findActionById,
  listActionsForClock,
  listActionsForWorkOrder,
};
