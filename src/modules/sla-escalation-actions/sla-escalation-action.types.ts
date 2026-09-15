import type { SlaClockType } from '../applied-slas/applied-sla.types';
import type { SlaEscalationRecipientRule } from '../sla-escalation-policies/sla-escalation-policy.types';

/**
 * CR-BE-SLA-02 PART 02 — escalation action ledger vocabulary.
 *
 * PART 02 only ever writes `PENDING` (materialization) and `CANCELLED`
 * (source lifecycle no longer applicable). `TRIGGERED` is written by PART 03's
 * claim-before-send, `SKIPPED` is reserved for the optional deactivated-level
 * outcome described in the governance document (§8.2).
 */
export const SLA_ESCALATION_ACTION_STATUSES = ['PENDING', 'TRIGGERED', 'CANCELLED', 'SKIPPED'] as const;
export type SlaEscalationActionStatus = (typeof SLA_ESCALATION_ACTION_STATUSES)[number];

/** Reasons PART 02 may cancel a still-`PENDING` action. */
export const SLA_ESCALATION_CANCEL_REASONS = ['CLOCK_SATISFIED', 'CLOCK_TERMINATED'] as const;
export type SlaEscalationCancelReason = (typeof SLA_ESCALATION_CANCEL_REASONS)[number];

/** One materialized escalation level for one breached SLA clock. */
export type SlaEscalationActionRecord = {
  id: string;
  appliedSlaId: string;
  slaClockId: string;
  workOrderId: string;
  clientId: string;
  buildingId: string;
  clockType: SlaClockType;
  policyId: string;
  escalationLevelId: string;
  level: number;
  /** Snapshotted from the level at materialization; later policy edits cannot rewrite it. */
  templateKey: string;
  /** Snapshotted from the level at materialization; later policy edits cannot rewrite it. */
  recipientRule: SlaEscalationRecipientRule;
  breachedAt: Date;
  /** `breached_at + offset_minutes`, computed once and never recomputed. */
  dueAt: Date;
  status: SlaEscalationActionStatus;
  triggeredAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  recipientsResolved: number;
  notificationsCreated: number;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** A policy that matched a breach, with its frozen specificity score. */
export type ApplicableEscalationPolicy = {
  id: string;
  clientId: string;
  buildingId: string | null;
  code: string;
  clockType: 'RESPONSE' | 'RESOLUTION' | 'ANY';
  workType: string | null;
  priority: string | null;
  /** Building 8 + exact clock_type 4 + work_type 2 + priority 1. */
  specificity: number;
};

/**
 * Everything materialization needs about the breach, gathered by the caller
 * from the authoritative SLA-01 chain. Escalation reads it; it never re-derives
 * or mutates any of it.
 */
export type SlaBreachContext = {
  appliedSlaId: string;
  slaClockId: string;
  clockType: SlaClockType;
  workOrderId: string;
  clientId: string;
  buildingId: string;
  workType: string;
  priority: string;
  /** The persisted `sla_clocks.breached_at` instant. */
  breachedAt: Date;
};
