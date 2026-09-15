import type { PoolClient } from 'pg';
import { recordOperationalEvent } from '../operational-events';
import { slaEscalationActionRepository } from './sla-escalation-action.repository';
import type {
  ApplicableEscalationPolicy,
  SlaBreachContext,
  SlaEscalationActionRecord,
  SlaEscalationCancelReason,
} from './sla-escalation-action.types';

/**
 * CR-BE-SLA-02 PART 02 — breach-time materialization and cancellation.
 *
 * WHAT THIS OWNS
 * --------------
 * Turning a *persisted* SLA breach into durable, immutable escalation
 * intentions (`sla_escalation_actions` rows) and retiring them when the source
 * clock stops being escalatable. Nothing here resolves recipients, renders
 * templates, creates notifications, or triggers anything — those are PART 03.
 *
 * WHAT THIS MUST NEVER DO
 * -----------------------
 * Escalation is strictly additive to SLA-01. It never writes to `work_orders`,
 * `applied_slas`, `sla_clocks`, or `sla_clock_pause_intervals`, and never
 * re-times or clears `breached_at`.
 *
 * TRANSACTIONALITY
 * ----------------
 * Every entry point takes the caller's `tx`, so the breach write, the
 * `SLA_CLOCK_BREACHED` event, and the action inserts commit or roll back
 * together (idempotency layer 3). A committed breach with a missing schedule —
 * or a schedule with no breach — is therefore impossible.
 */

/** Outcome of one materialization attempt, for the caller's logs and tests. */
export type MaterializationOutcome =
  /** No ACTIVE policy matched the breach. Normal: escalation is optional. */
  | { kind: 'NO_POLICY'; actions: [] }
  /** Two or more policies tied on specificity. Fails closed: nothing scheduled. */
  | { kind: 'AMBIGUOUS'; actions: []; policyIds: string[] }
  /** A policy was selected but it has no ACTIVE levels ("configured but silent"). */
  | { kind: 'NO_LEVELS'; actions: []; policyId: string }
  /** Levels were materialized (possibly zero new rows if already materialized). */
  | { kind: 'SCHEDULED'; actions: SlaEscalationActionRecord[]; policyId: string };

/**
 * Picks the single applicable policy.
 *
 * Highest specificity wins (Building 8 > exact clock_type 4 > work_type 2 >
 * priority 1, so `ANY` always loses to an exact clock match at equal scope).
 * A tie returns `null` together with the tied candidates: unlike SLA-01's 409,
 * a breach has no caller to reject, so the safe outcome is to schedule nothing
 * and leave an audit trail.
 */
function selectPolicy(candidates: ApplicableEscalationPolicy[]): {
  selected: ApplicableEscalationPolicy | null;
  tied: ApplicableEscalationPolicy[];
} {
  const top = candidates[0];
  if (!top) return { selected: null, tied: [] };
  const tied = candidates.filter((c) => c.specificity === top.specificity);
  return tied.length > 1 ? { selected: null, tied } : { selected: top, tied: [] };
}

/** All escalation events share the Work Order entity and the applied SLA's scope. */
async function event(
  ctx: SlaBreachContext | Pick<SlaEscalationActionRecord, 'clientId' | 'buildingId' | 'workOrderId'>,
  eventType: string,
  summary: string,
  metadata: Record<string, unknown>,
  tx: PoolClient,
): Promise<void> {
  await recordOperationalEvent(
    {
      clientId: ctx.clientId,
      buildingId: ctx.buildingId,
      entityType: 'WORK_ORDER',
      entityId: ctx.workOrderId,
      eventType,
      summary,
      metadata,
    },
    tx,
  );
}

/**
 * Materializes one action per ACTIVE level of the applicable policy for a
 * breach that was *just persisted for the first time*.
 *
 * Callers must invoke this only inside the first-write branch of
 * `markBreached` (idempotency layer 1); the unique constraint on
 * `(sla_clock_id, escalation_level_id)` is the durable backstop (layer 2).
 * `template_key` and `recipient_rule` are snapshotted and
 * `due_at = breached_at + offset_minutes` is frozen at this moment, so later
 * policy edits only affect future breaches.
 */
export async function materializeEscalationActions(
  ctx: SlaBreachContext,
  tx: PoolClient,
): Promise<MaterializationOutcome> {
  const candidates = await slaEscalationActionRepository.findApplicablePolicies(ctx, tx);
  const { selected, tied } = selectPolicy(candidates);

  if (tied.length > 1) {
    const policyIds = tied.map((p) => p.id);
    await event(
      ctx,
      'SLA_ESCALATION_POLICY_AMBIGUOUS',
      'Escalation policy selection was ambiguous; no escalation scheduled',
      {
        slaClockId: ctx.slaClockId,
        clockType: ctx.clockType,
        breachedAt: ctx.breachedAt.toISOString(),
        specificity: tied[0]!.specificity,
        policyIds,
        policyCodes: tied.map((p) => p.code),
      },
      tx,
    );
    return { kind: 'AMBIGUOUS', actions: [], policyIds };
  }

  if (!selected) return { kind: 'NO_POLICY', actions: [] };

  const levels = await slaEscalationActionRepository.findActiveLevels(selected.id, tx);
  if (levels.length === 0) return { kind: 'NO_LEVELS', actions: [], policyId: selected.id };

  const actions: SlaEscalationActionRecord[] = [];
  for (const level of levels) {
    const created = await slaEscalationActionRepository.insertAction(ctx, selected.id, level, tx);
    if (created) actions.push(created);
  }

  // One event per breach summarizing the materialized levels, not one per level.
  if (actions.length > 0) {
    await event(
      ctx,
      'SLA_ESCALATION_SCHEDULED',
      `${actions.length} escalation level(s) scheduled for the ${ctx.clockType} SLA breach`,
      {
        slaClockId: ctx.slaClockId,
        clockType: ctx.clockType,
        breachedAt: ctx.breachedAt.toISOString(),
        policyId: selected.id,
        policyCode: selected.code,
        levels: actions.map((a) => ({
          actionId: a.id,
          level: a.level,
          dueAt: a.dueAt.toISOString(),
          templateKey: a.templateKey,
        })),
      },
      tx,
    );
  }

  return { kind: 'SCHEDULED', actions, policyId: selected.id };
}

/**
 * Cancels the still-`PENDING` actions of a clock that has left `RUNNING`.
 *
 * Once the Work Order is acknowledged (RESPONSE) or completed/cancelled
 * (RESOLUTION) there is no reason to keep escalating. Already-`TRIGGERED`
 * actions are immutable history and are never rewritten — the message really
 * was sent. Runs in the caller's transaction, alongside the clock transition.
 */
export async function cancelPendingEscalationActions(
  slaClockId: string,
  reason: SlaEscalationCancelReason,
  at: Date,
  tx: PoolClient,
): Promise<SlaEscalationActionRecord[]> {
  const cancelled = await slaEscalationActionRepository.cancelPendingForClock(slaClockId, reason, at, tx);
  if (cancelled.length === 0) return cancelled;
  const first = cancelled[0]!;
  await event(
    first,
    'SLA_ESCALATION_CANCELLED',
    `${cancelled.length} pending escalation level(s) cancelled (${reason})`,
    {
      slaClockId,
      clockType: first.clockType,
      cancelReason: reason,
      cancelledAt: at.toISOString(),
      actionIds: cancelled.map((a) => a.id),
      levels: cancelled.map((a) => a.level),
    },
    tx,
  );
  return cancelled;
}

export const slaEscalationActionService = {
  materializeEscalationActions,
  cancelPendingEscalationActions,
  listActionsForClock: slaEscalationActionRepository.listActionsForClock,
  listActionsForWorkOrder: slaEscalationActionRepository.listActionsForWorkOrder,
};
