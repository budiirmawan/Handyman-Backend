import type { SlaClockStatus, SlaClockType } from '../applied-slas/applied-sla.types';
import type { SlaEscalationActionStatus } from '../sla-escalation-actions/sla-escalation-action.types';

/**
 * R10 PART 06 — Work Order SLA Register read-model contract.
 *
 * READ MODEL ONLY. This file declares the bounded Reporting contract over the
 * EXISTING SLA authority (`applied_slas`, `sla_clocks`,
 * `sla_clock_pause_intervals`, `sla_escalation_actions`, `work_orders`). It creates
 * no business entity, no persistence, no lifecycle and no vocabulary of its own:
 * clock type, clock status and escalation status are all imported from the domains
 * that already own them, and every value in a row is the persisted value verbatim.
 *
 * NO NEW SLA SEMANTICS. There is no new SLA rule, clock rule, breach rule, pause
 * rule, escalation rule, threshold or "approaching breach" concept here. Breach
 * truth is the persisted `sla_clocks.breached_at` and is never recomputed from
 * `started_at`, `target_minutes` or the current time.
 *
 * GRAIN — ONE ROW PER `sla_clocks` ROW. A Work Order therefore produces up to two
 * rows, RESPONSE and RESOLUTION, because status, breach, pause, target, elapsed and
 * escalation are all clock-level facts. The two clocks are never collapsed into one
 * Work Order row, never coalesced, and no "primary clock" is chosen.
 *
 * SCOPE — `sla_clocks` and `sla_clock_pause_intervals` carry NO client_id and NO
 * building_id, so every clock and pause fact is reached through
 * `sla_clocks → applied_slas`, and `applied_slas.building_id` is the isolation
 * column. A clock is never scoped by `work_order_id` or `sla_clock_id` alone without
 * that traversal.
 *
 * CURRENT-ONLY FIELDS — `isPaused`, `pauseCount`, `totalPausedMilliseconds` and
 * `effectiveElapsedMilliseconds` are read-time values evaluated at the envelope's
 * `asOf` instant. They are NOT a historical snapshot and are never presented as
 * elapsed-at-breach, historical or final elapsed. `asOf` exists in the envelope
 * precisely so a consumer can tell what instant those four describe.
 *
 * NOT EXPOSED — pause interval rows are never flattened into the clock row, and
 * escalation action rows are never flattened either; only bounded aggregates and the
 * single deterministically-latest escalation fact appear. Escalation recipient
 * identities (`recipient_rule`, `recipients_resolved`, `notifications_created`,
 * `template_key`) and pause actor identities (`pause_actor_user_id`,
 * `resume_actor_user_id`) are deliberately absent, and no second escalation timeline
 * is created here.
 *
 * PART 06 declares the contract and the repository read only. There is deliberately
 * no service, no index, no route, no permission, no Reporting dataset enum entry and
 * no OpenAPI change, so this module is unreachable from runtime routes and the export
 * registry until PART 07 wires it.
 */

/**
 * Bounded Reporting filters for the Work Order SLA Register.
 *
 * Every filter NARROWS an already-authorized scope; none can widen it. There is
 * deliberately no `approachingBreach`, no `daysOverdue`, no severity score, no
 * generic cross-domain SLA status and no non-WORK_ORDER operational type: the
 * existing SLA operational type remains `WORK_ORDER`.
 */
export type WorkOrderSlaRegisterFilters = {
  /**
   * Optional. Omitted means "roll up across every Building the caller can access";
   * supplied means the Building is existence-checked and access-asserted. Resolved
   * into the authorized `buildingIds` scope by the PART 07 service — the repository
   * never treats it as a substitute for that scope.
   */
  buildingId?: string;
  /** Narrows to one Work Order's applied SLA. Never a scope substitute. */
  workOrderId?: string;
  /** Existing clock-type authority: RESPONSE | RESOLUTION. */
  clockType?: SlaClockType;
  /** Existing clock-status authority: RUNNING | SATISFIED | TERMINATED. */
  clockStatus?: SlaClockStatus;
  /**
   * Persisted-breach narrowing only: TRUE keeps clocks whose `breached_at` is set,
   * FALSE keeps clocks whose `breached_at` is NULL. This never recomputes breach and
   * never introduces an approaching-breach threshold.
   */
  breached?: boolean;
  /**
   * Read-time narrowing over the clock's own open pause interval, evaluated at `asOf`.
   * Current-state semantics only, not a historical "was ever paused" fact.
   */
  paused?: boolean;
  /**
   * Existing escalation-status authority: PENDING | TRIGGERED | CANCELLED | SKIPPED.
   * Matches the exposed `latestEscalationStatus` — the single deterministically
   * latest escalation action for the clock — and never a hidden per-action row.
   */
  escalationStatus?: SlaEscalationActionStatus;
  /** `applied_slas.definition_code` verbatim. */
  definitionCode?: string;
  /**
   * The applied snapshot `applied_slas.work_order_work_type`, which is the work type
   * that actually drove SLA selection. The live `work_orders.work_type` is
   * deliberately not a filter, so a missing or malformed Work Order enrichment can
   * never change which clock rows are visible.
   */
  workType?: string;
  /** The applied snapshot `applied_slas.work_order_priority`, for the same reason. */
  priority?: string;
  /** ISO date (YYYY-MM-DD) or datetime; day windows are UTC half-open. */
  dateFrom?: string;
  /** ISO date (YYYY-MM-DD) or datetime; day windows are UTC half-open. */
  dateTo?: string;
};

/**
 * One Work Order SLA Register row = ONE `sla_clocks` row, enriched with its applied
 * SLA snapshot and bounded pause/escalation facts.
 *
 * Nullable Work Order enrichment (`workOrderNumber`, `workOrderStatus`) reflects a
 * LEFT JOIN pinned to structural client AND building equality: a clock row survives
 * malformed enrichment with those two fields NULL rather than disappearing, and a
 * cross-client or cross-building reference can never widen visibility.
 */
export type PublicWorkOrderSlaRow = {
  /* Applied SLA — the scope bridge and the immutable snapshot */
  appliedSlaId: string;
  workOrderId: string;
  /** LEFT JOIN enrichment; NULL if the Work Order row does not match structurally. */
  workOrderNumber: string | null;
  /** LEFT JOIN enrichment; NULL if the Work Order row does not match structurally. */
  workOrderStatus: string | null;
  clientId: string;
  buildingId: string;

  /* Definition snapshot, verbatim from applied_slas */
  slaDefinitionId: string;
  definitionCode: string;
  /** Existing SLA operational type; persisted as WORK_ORDER only. */
  operationalType: 'WORK_ORDER';
  definitionWorkType: string | null;
  definitionPriority: string | null;
  workOrderWorkType: string;
  workOrderPriority: string;
  responseTargetMinutes: number | null;
  resolutionTargetMinutes: number | null;
  definitionEffectiveFrom: string;
  definitionEffectiveTo: string | null;
  appliedAt: string;

  /* The clock — this row's grain */
  slaClockId: string;
  clockType: SlaClockType;
  targetMinutes: number;
  startedAt: string;
  clockStatus: SlaClockStatus;
  satisfiedAt: string | null;
  terminatedAt: string | null;
  /** Persisted breach truth. NULL means never breached; it is never recomputed. */
  breachedAt: string | null;

  /* Pause facts — bounded aggregates over the clock's own intervals at `asOf` */
  /** Read-time: an open interval exists for this clock at `asOf`. */
  isPaused: boolean;
  pauseCount: number;
  totalPausedMilliseconds: number;
  /**
   * Read-time effective elapsed at `asOf`, reusing the SLA domain's own read-side
   * formula. CURRENT-ONLY: not elapsed-at-breach, not historical, not final.
   */
  effectiveElapsedMilliseconds: number;

  /* Escalation facts — bounded aggregate plus the single latest action */
  escalationCount: number;
  /** Level of the deterministically latest escalation action; NULL when none exists. */
  latestEscalationLevel: number | null;
  latestEscalationStatus: SlaEscalationActionStatus | null;
  /** Persisted `triggered_at` of that latest action; NULL while it is untriggered. */
  latestEscalationTriggeredAt: string | null;
};

/**
 * The public register envelope, shaped for PART 07 service wiring.
 *
 * PART 06 declares it only — scope resolution and access assertion stay with the
 * service that does not exist yet.
 */
export type PublicWorkOrderSlaRegister = {
  /** Null when the register is a multi-building rollup. */
  buildingId: string | null;
  /** Every Building actually included in the rows. */
  buildingScope: string[];
  dateFrom: string | null;
  dateTo: string | null;
  /**
   * The single read-time instant behind `isPaused`, `pauseCount`,
   * `totalPausedMilliseconds` and `effectiveElapsedMilliseconds`. Required because
   * those four are CURRENT-ONLY rather than persisted history.
   */
  asOf: string;
  rows: PublicWorkOrderSlaRow[];
};
