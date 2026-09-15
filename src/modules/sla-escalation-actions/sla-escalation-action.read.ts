import { slaEscalationActionRepository } from './sla-escalation-action.repository';
import type { SlaEscalationActionRecord } from './sla-escalation-action.types';

/**
 * CR-BE-SLA-02 PART 05 — escalation history read model.
 *
 * WHAT THIS OWNS
 * --------------
 * The projection of the PART 02 action ledger into the public representation
 * served by `GET /work-orders/{id}/sla/escalations`. It is a pure read: no
 * claim, no trigger, no cancellation, no counter write. PART 03/PART 04
 * execution behaviour is completely untouched by this file.
 *
 * PRIVACY BOUNDARY (deliberate omissions)
 * ---------------------------------------
 * Two fields of `SlaEscalationActionRecord` are intentionally NOT projected:
 *
 *   - `recipientRule` — the snapshotted rule enumerates Users, roles,
 *     permissions, teams and derived targets. Publishing it would expose WHO
 *     was notified (and who is configured to be notified) to every holder of
 *     `work_order.read`, which is a strictly wider audience than the recipients
 *     themselves. The caller learns HOW MANY recipients resolved
 *     (`recipientsResolved`) and how many in-app notifications were created
 *     (`notificationsCreated`) — enough to audit that the escalation worked,
 *     never enough to enumerate people. Notification bodies remain visible only
 *     through the notification surface, to their own recipient.
 *   - nothing provider-related exists to omit: escalation delivery is in-app
 *     only (BE-26A), so there is no provider id, transport status, address,
 *     phone number, mailbox, or delivery receipt anywhere in this model. If a
 *     provider channel is ever added, its delivery data must stay out of this
 *     projection by the same rule.
 *
 * `failureReason` IS exposed: it is an operator-facing diagnostic written by
 * PART 03 (e.g. a render failure) and is capped at 500 characters. It never
 * carries recipient identities.
 */

/**
 * One materialized escalation level as served by the read API: the full status,
 * timing and policy/level provenance of the action, minus recipient identities.
 */
export type PublicSlaEscalationAction = {
  id: string;
  workOrderId: string;
  appliedSlaId: string;
  slaClockId: string;
  clientId: string;
  buildingId: string;
  clockType: 'RESPONSE' | 'RESOLUTION';
  /** Provenance: which policy and which of its levels produced this action. */
  policyId: string;
  escalationLevelId: string;
  level: number;
  /** Snapshotted at materialization; later policy edits cannot rewrite it. */
  templateKey: string;
  /** The persisted breach instant this action descends from. */
  breachedAt: string;
  /** `breachedAt + offsetMinutes`, computed once at materialization. */
  dueAt: string;
  status: string;
  triggeredAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  /** Count only — never the identities behind it. */
  recipientsResolved: number;
  notificationsCreated: number;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Projects one ledger row. Written as an explicit field list rather than a
 * spread-and-delete so that any future column added to the ledger is invisible
 * to the API until someone deliberately publishes it — a column added for
 * execution must never leak through this seam by default.
 */
export function toPublicSlaEscalationAction(
  action: SlaEscalationActionRecord,
): PublicSlaEscalationAction {
  return {
    id: action.id,
    workOrderId: action.workOrderId,
    appliedSlaId: action.appliedSlaId,
    slaClockId: action.slaClockId,
    clientId: action.clientId,
    buildingId: action.buildingId,
    clockType: action.clockType,
    policyId: action.policyId,
    escalationLevelId: action.escalationLevelId,
    level: action.level,
    templateKey: action.templateKey,
    breachedAt: action.breachedAt.toISOString(),
    dueAt: action.dueAt.toISOString(),
    status: action.status,
    triggeredAt: action.triggeredAt?.toISOString() ?? null,
    cancelledAt: action.cancelledAt?.toISOString() ?? null,
    cancelReason: action.cancelReason,
    recipientsResolved: action.recipientsResolved,
    notificationsCreated: action.notificationsCreated,
    failureReason: action.failureReason,
    createdAt: action.createdAt.toISOString(),
    updatedAt: action.updatedAt.toISOString(),
  };
}

/**
 * Escalation history of one Work Order, ordered by clock type then level — the
 * order in which the levels were configured to fire.
 *
 * Returns `[]` for a Work Order that never breached, that had no applicable
 * policy, or that has no SLA at all. An empty ledger is a normal state, not a
 * 404: the Work Order's own existence and access are validated by the caller
 * (the route) before this seam is reached.
 */
export async function listWorkOrderEscalations(
  workOrderId: string,
): Promise<PublicSlaEscalationAction[]> {
  const actions = await slaEscalationActionRepository.listActionsForWorkOrder(workOrderId);
  return actions.map(toPublicSlaEscalationAction);
}

export const slaEscalationActionReadService = {
  listWorkOrderEscalations,
  toPublicSlaEscalationAction,
};
