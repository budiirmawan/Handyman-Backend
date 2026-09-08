/**
 * CR-BE-STAB-01 PART 03 — due operational job dispatcher result types.
 *
 * The dispatcher is a lightweight runtime caller for the existing reminder and
 * escalation scheduler seams. It introduces no new domain tables, no new
 * storage, and no cron/queue engine (that belongs to PART 04). It only drives
 * the already-built `findDue*` / dispatch / trigger seams.
 */

/** Per-domain outcome of one dispatcher run. */
export type DueJobDomainResult = {
  /** Number of eligible due items that were processed (dispatched/triggered). */
  processed: number;
  /** Total in-app notifications created across processed items. */
  notificationsCreated: number;
  /** Number of items that threw while being processed (isolated per item). */
  failures: number;
};

/**
 * CR-BE-NOTIFY-PROV-01 PART 04 — outbound delivery domain result.
 *
 * Richer than the uniform `DueJobDomainResult` because an outbound attempt
 * ends in one of several lifecycle transitions, each worth reporting:
 * sent / retryScheduled / failedPermanent / exhausted. `skipped` counts due
 * rows whose claim was lost to a concurrent runner (they stay due — neither
 * work done nor an error); `failures` counts unexpected throws, isolated per
 * row.
 */
export type DueOutboundDeliveryResult = {
  due: number;
  sent: number;
  retryScheduled: number;
  failedPermanent: number;
  exhausted: number;
  skipped: number;
  failures: number;
};

/**
 * CR-BE-DOC-CONTROL-01 PART 04 — evidence retention execution result.
 *
 * Richer than the uniform `DueJobDomainResult` because one pass performs two
 * distinct governed transitions (due marking and purging) plus governed
 * skips: `dueMarked` (ACTIVE → RETENTION_DUE), `purged` (binary disposed +
 * tombstone), `held` (purge blocked by a retention hold — neither work done
 * nor an error), `failures` (per-row isolated; the row stays RETENTION_DUE
 * and is retried next tick).
 */
export type DueEvidenceRetentionResult = {
  dueMarked: number;
  purged: number;
  held: number;
  failures: number;
};

/**
 * CR-BE-INTEG-01 PART 05 — integration webhook domain result (governance
 * §8). One tick runs two bounded phases in order — outbox fan-out, then due
 * delivery execution — so `fannedOut` counts delivery rows newly created by
 * fan-out while the four lifecycle counters report this tick's executed
 * attempts. `skipped` sums claims lost to concurrent runners across both
 * phases (they stay due — neither work done nor an error); `failures` sums
 * per-row isolated unexpected throws across both phases. With
 * `INTEGRATION_WEBHOOKS_ENABLED` off the domain is a cheap all-zero no-op.
 */
export type DueIntegrationWebhookResult = {
  fannedOut: number;
  delivered: number;
  retryScheduled: number;
  failedPermanent: number;
  exhausted: number;
  skipped: number;
  failures: number;
};

/**
 * Aggregate result of a dispatcher run.
 *
 * CR-BE-SLA-02 PART 04 added the two SLA keys; CR-BE-NOTIFY-PROV-01 PART 04
 * added `outboundDeliveries`. Every change is purely additive: earlier keys
 * keep their existing meaning and counts, so no existing caller reads a
 * different value than before.
 */
export type DueJobDispatchResult = {
  reminders: DueJobDomainResult;
  escalations: DueJobDomainResult;
  /**
   * SLA-01 breach detection (`processDueSlaClocks`). Executed by the
   * dispatcher since CR-BE-SLA-01; reported since CR-BE-SLA-02 PART 04.
   * `processed` counts clocks newly marked breached — breach detection creates
   * no notification of its own, so `notificationsCreated` is always 0.
   */
  slaClocks: DueJobDomainResult;
  /**
   * CR-BE-SLA-02 escalation levels executed this tick
   * (`processDueSlaEscalations`). `processed` counts actions this run claimed
   * and triggered. Due actions deliberately left `PENDING` — a lost claim, or
   * a deactivated template — are neither processed nor failures; they stay due
   * for the next tick.
   */
  slaEscalations: DueJobDomainResult;
  /**
   * CR-BE-NOTIFY-PROV-01 PART 04 outbound delivery execution
   * (`processDueOutboundDeliveries`): claim → adapter send → attempt-history
   * row → guarded lifecycle transition for due EMAIL/WHATSAPP intents.
   */
  outboundDeliveries: DueOutboundDeliveryResult;
  /**
   * CR-BE-DOC-CONTROL-01 PART 04 evidence retention execution
   * (`processDueEvidenceRetention`): governed-due marking
   * (ACTIVE → RETENTION_DUE), binary disposal + PURGED tombstone, hold
   * skips, per-row failure isolation. Purely additive — earlier keys keep
   * their existing meaning and counts.
   */
  evidenceRetention: DueEvidenceRetentionResult;
  /**
   * CR-BE-INTEG-01 PART 05 integration webhook fan-out + delivery execution
   * (`processDueIntegrationWebhookJobs`). Purely additive — earlier keys
   * keep their existing meaning and counts.
   */
  webhookDeliveries: DueIntegrationWebhookResult;
  /** ISO timestamp of when the run executed. */
  executedAt: string;
};
