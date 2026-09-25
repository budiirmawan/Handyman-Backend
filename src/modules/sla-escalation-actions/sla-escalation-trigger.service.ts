import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { getActiveTemplateByKey, renderTemplate } from '../notification-templates';
import { recordNotification } from '../notifications';
import { recordOperationalEvent } from '../operational-events';
import { resolveRecipients } from '../recipient-resolution';
import { workOrderRepository } from '../work-orders';
import { slaEscalationActionRepository } from './sla-escalation-action.repository';
import { expandActionRecipientSpecs, forceActionScope } from './sla-escalation-recipients';
import type { SlaEscalationActionRecord, SlaEscalationActionStatus } from './sla-escalation-action.types';

/**
 * CR-BE-SLA-02 PART 03 — due execution and notification intent.
 *
 * WHAT THIS OWNS
 * --------------
 * Turning a due `sla_escalation_actions` row into notification intent: claim
 * the row, expand and resolve its snapshotted recipient rule, render its
 * snapshotted template, and call BE-26A `recordNotification` once per resolved
 * User. Nothing else. It creates no delivery engine, no channel, and no
 * scheduler — PART 04 wires this into the existing due-job dispatcher.
 *
 * THE ACTION ROW IS THE ONLY EXECUTION AUTHORITY
 * ----------------------------------------------
 * Every decision — which template, which recipients, which Client/Building,
 * which level, when it was due — is read from the row that PART 02 froze at
 * breach time. The live policy, the live level, and the live clock are NEVER
 * re-read to decide who or what triggers, so editing or deactivating a policy
 * after a breach cannot rewrite an escalation that was already scheduled. The
 * only live read is the BE-26B template (§7: a deactivated template suppresses
 * the send) and the Work Order row used purely to fill template variables.
 *
 * ORDERING IS THE SAFETY PROPERTY
 * -------------------------------
 * pre-check → template check → CLAIM → resolve → render → notify → persist
 * counters → event. Nothing after "CLAIM" can run for a caller that lost the
 * claim, so a side effect strictly cannot happen twice. Delivery is
 * at-most-once by design (governance §7): if the process dies mid-send the
 * level is lost, never duplicated.
 */

const SOURCE_EVENT_TYPE = 'SLA_ESCALATION_TRIGGERED';

/**
 * Why a trigger attempt did nothing, or what it did. Every non-`TRIGGERED`
 * outcome is a normal, silent no-op — none of them is an error, and none of
 * them has produced a side effect.
 */
export type SlaEscalationTriggerOutcome =
  /** No such action (already purged, or a bad id). */
  | { kind: 'NOT_FOUND' }
  /** Already `TRIGGERED`, or `CANCELLED`/`SKIPPED`: terminal, never re-executed. */
  | { kind: 'NOT_PENDING'; status: SlaEscalationActionStatus }
  /** `due_at` is still in the future. */
  | { kind: 'NOT_DUE'; dueAt: Date }
  /** The snapshotted template is missing or no longer ACTIVE — left `PENDING`, unclaimed. */
  | { kind: 'TEMPLATE_INACTIVE'; templateKey: string }
  /** Another worker won the guarded `PENDING → TRIGGERED` update. */
  | { kind: 'CLAIM_LOST' }
  /** This caller claimed the action and owns its (single) execution. */
  | {
      kind: 'TRIGGERED';
      action: SlaEscalationActionRecord;
      recipientsResolved: number;
      notificationsCreated: number;
      /** Non-null when the post-claim work failed; the action still stays `TRIGGERED`. */
      failureReason: string | null;
    };

/** Aggregate of one bounded execution pass, for the PART 04 dispatcher and tests. */
export type SlaEscalationDispatchResult = {
  due: number;
  triggered: number;
  notificationsCreated: number;
  /** Claimed actions whose post-claim work failed (already recorded on the row). */
  failures: number;
  /** Due actions this pass deliberately left `PENDING` (lost claim / inactive template). */
  skipped: number;
};

/** Template variables offered to the snapshotted BE-26B template. */
function templateValues(
  action: SlaEscalationActionRecord,
  workOrder: { workOrderNumber: string; title: string; workType: string; priority: string } | null,
): Record<string, string | number> {
  return {
    workOrderNumber: workOrder?.workOrderNumber ?? '',
    workOrderTitle: workOrder?.title ?? '',
    workType: workOrder?.workType ?? '',
    priority: workOrder?.priority ?? '',
    clockType: action.clockType,
    level: action.level,
    breachedAt: action.breachedAt.toISOString(),
    dueAt: action.dueAt.toISOString(),
  };
}

function reason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}

/** Mutable progress of the post-claim work, so a partial send is still counted. */
type TriggerProgress = { recipientsResolved: number; notificationsCreated: number };

/**
 * Everything that happens AFTER the claim. Isolated so the claim path stays
 * obvious, and wrapped by the caller in a single try/catch: any failure here
 * is recorded as `failure_reason` on the already-`TRIGGERED` row and never
 * reverts the claim, because a notification may already have been written.
 *
 * `progress` is mutated as work completes rather than returned, so a failure
 * halfway through the recipient loop still persists the notifications that were
 * really created. A counter that under-reports sent messages would be worse
 * than the failure itself.
 */
async function executeClaimed(
  action: SlaEscalationActionRecord,
  progress: TriggerProgress,
): Promise<void> {
  const template = await getActiveTemplateByKey(action.templateKey);
  if (!template) {
    // Deactivated between the pre-check and the claim: nothing to render.
    throw new Error(`Notification template '${action.templateKey}' is no longer ACTIVE.`);
  }

  const scope = forceActionScope(action);
  // A stored rule that narrows outside the action's own Client/Building
  // resolves to nobody. It must never fall back to unscoped resolution.
  const recipientIds = scope
    ? await resolveRecipients(await expandActionRecipientSpecs(action), scope)
    : [];
  progress.recipientsResolved = recipientIds.length;

  if (recipientIds.length === 0) {
    // Zero recipients is a legitimate TRIGGERED outcome (§5.5), not a failure:
    // the audience may simply have no Building access. Render is skipped so a
    // template-variable problem cannot mask "nobody to tell".
    return;
  }

  const workOrder = await workOrderRepository.findById(action.workOrderId);
  const rendered = renderTemplate(
    { subject: template.subject, body: template.body },
    templateValues(action, workOrder),
  );

  for (const recipientUserId of recipientIds) {
    await recordNotification({
      clientId: action.clientId,
      recipientUserId,
      type: template.type,
      channel: 'IN_APP',
      title: rendered.subject,
      body: rendered.body,
      sourceEntityType: 'WORK_ORDER',
      sourceEntityId: action.workOrderId,
      sourceEventType: SOURCE_EVENT_TYPE,
      templateKey: action.templateKey,
      // CR-BE-RN21-NOTIFICATION-NAV-01 — the EXPLICIT backend-owned navigation
      // target. This is the only producer that declares one today: the action
      // row already carries the canonical `work_orders.id` it was raised
      // against (`action.workOrderId`, used verbatim above for the source
      // entity), so the target is READ from the frozen action row — never
      // inferred from `sourceEntityType`, and never taken from `metadata`.
      navigationTarget: {
        type: 'WORK_ORDER_FIELD_WORK',
        id: action.workOrderId,
      },
      metadata: {
        escalationActionId: action.id,
        slaClockId: action.slaClockId,
        clockType: action.clockType,
        policyId: action.policyId,
        level: action.level,
        breachedAt: action.breachedAt.toISOString(),
        dueAt: action.dueAt.toISOString(),
      },
    });
    progress.notificationsCreated += 1;
  }
}

/**
 * Persists the trigger outcome and emits `SLA_ESCALATION_TRIGGERED`.
 *
 * Both writes share one transaction so the ledger counters and the audit event
 * can never disagree. The caller may supply its own `tx` (PART 04's per-action
 * transaction); the claim itself is deliberately NOT part of it — a claim that
 * could roll back after a notification was written would re-open the door to
 * double-sending.
 */
async function completeTrigger(
  action: SlaEscalationActionRecord,
  result: { recipientsResolved: number; notificationsCreated: number; failureReason: string | null },
  tx?: PoolClient,
): Promise<SlaEscalationActionRecord> {
  const run = async (executor: PoolClient | ReturnType<typeof getPool>): Promise<SlaEscalationActionRecord> => {
    const persisted = await slaEscalationActionRepository.recordTriggerResult(action.id, result, executor);
    await recordOperationalEvent(
      {
        clientId: action.clientId,
        buildingId: action.buildingId,
        entityType: 'WORK_ORDER',
        entityId: action.workOrderId,
        eventType: SOURCE_EVENT_TYPE,
        summary: `SLA escalation level ${action.level} triggered for the ${action.clockType} breach`,
        metadata: {
          escalationActionId: action.id,
          slaClockId: action.slaClockId,
          appliedSlaId: action.appliedSlaId,
          level: action.level,
          clockType: action.clockType,
          recipientsResolved: result.recipientsResolved,
          notificationsCreated: result.notificationsCreated,
          // Recipient identities are intentionally NOT in the event: the
          // counters are the operational signal, the notification rows are the
          // record of who was told.
          ...(result.failureReason ? { failureReason: result.failureReason } : {}),
        },
      },
      executor,
    );
    return persisted ?? action;
  };

  return tx ? run(tx) : withTransaction((created) => run(created));
}

/**
 * Executes one escalation action, at most once, ever.
 *
 * Read-only pre-checks first (cheap, and they keep the common "nothing to do"
 * path free of writes), then the guarded claim, then — and only then — the
 * side effects. A `TEMPLATE_INACTIVE` action is left `PENDING` on purpose
 * (governance §7): re-activating the template lets a later pass deliver it,
 * whereas claiming now would silently swallow the escalation.
 */
export async function triggerSlaEscalation(
  actionId: string,
  at: Date = new Date(),
  tx?: PoolClient,
): Promise<SlaEscalationTriggerOutcome> {
  const existing = await slaEscalationActionRepository.findActionById(actionId);
  if (!existing) return { kind: 'NOT_FOUND' };
  if (existing.status !== 'PENDING') return { kind: 'NOT_PENDING', status: existing.status };
  if (existing.dueAt.getTime() > at.getTime()) return { kind: 'NOT_DUE', dueAt: existing.dueAt };

  const template = await getActiveTemplateByKey(existing.templateKey);
  if (!template) return { kind: 'TEMPLATE_INACTIVE', templateKey: existing.templateKey };

  // ---- claim-before-send (idempotency layer 4) --------------------------
  // Nothing below this line may run without a won claim. The claim is written
  // on the pool, outside any caller transaction, so it is durable the instant
  // it succeeds.
  const claimed = await slaEscalationActionRepository.claimAction(existing.id, at, getPool());
  if (!claimed) return { kind: 'CLAIM_LOST' };

  const progress: TriggerProgress = { recipientsResolved: 0, notificationsCreated: 0 };
  let failureReason: string | null = null;

  try {
    await executeClaimed(claimed, progress);
  } catch (error) {
    // Conservative: the action keeps its TRIGGERED claim and records why it
    // failed. Reverting to PENDING could re-send notifications that a partially
    // completed loop already created.
    failureReason = reason(error);
  }

  const action = await completeTrigger(claimed, { ...progress, failureReason }, tx);

  return {
    kind: 'TRIGGERED',
    action,
    recipientsResolved: progress.recipientsResolved,
    notificationsCreated: progress.notificationsCreated,
    failureReason,
  };
}

/**
 * One bounded execution pass over the due backlog.
 *
 * Enumeration runs in its own short transaction so `FOR UPDATE SKIP LOCKED`
 * has a transaction to hold its locks in; the locks are released before any
 * notification work begins, which keeps the pass short and leaves `claimAction`
 * as the authoritative mutual exclusion. Failure is isolated per action: one
 * bad action can never stop the rest of the batch, and leftovers simply stay
 * due for the next pass.
 */
export async function processDueSlaEscalations(
  before: Date = new Date(),
  limit?: number,
): Promise<SlaEscalationDispatchResult> {
  const due = await withTransaction((tx) => slaEscalationActionRepository.findDueActions(before, limit, tx));

  const result: SlaEscalationDispatchResult = {
    due: due.length,
    triggered: 0,
    notificationsCreated: 0,
    failures: 0,
    skipped: 0,
  };

  for (const action of due) {
    try {
      const outcome = await triggerSlaEscalation(action.id, before);
      if (outcome.kind === 'TRIGGERED') {
        result.triggered += 1;
        result.notificationsCreated += outcome.notificationsCreated;
        if (outcome.failureReason) result.failures += 1;
      } else {
        result.skipped += 1;
      }
    } catch {
      // Only an infrastructure failure (e.g. the claim UPDATE itself) reaches
      // here; the action stays PENDING and the next pass retries it.
      result.failures += 1;
    }
  }

  return result;
}

export const slaEscalationTriggerService = {
  triggerSlaEscalation,
  processDueSlaEscalations,
  findDueActions: slaEscalationActionRepository.findDueActions,
};
