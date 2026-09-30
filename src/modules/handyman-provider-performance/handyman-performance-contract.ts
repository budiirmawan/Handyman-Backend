/**
 * CR-HM-16 PART 04 — provider performance derivation + published read
 * contract (governance `docs/handyman/CR-HM-16_START_GOVERNANCE.md` §6,
 * §7 seam 6, §9 PART 04 row: "Derivation model binding (§6 inputs only),
 * derived read contract for CR-HM-17/18/22; boundary/firewall verification
 * battery").
 *
 * WHAT THIS OWNS
 * --------------
 * The frozen derivation law and the PUBLISHED, read-only performance contract
 * consumed by downstream journeys (CR-HM-17 frontend, CR-HM-18 mobile,
 * CR-HM-22 certification). Provider performance is DERIVED ANALYTICS computed
 * at query time from governed Handyman facts and nothing else:
 *
 *   1. governed Handyman operational events (`operational_events`, the
 *      certified CR-HM-01..15 domain vocabulary, `HANDYMAN_` entity
 *      namespace), and
 *   2. authoritative SLA outcomes (`applied_snapshots` + `sla_clocks`
 *      status/breach facts) for Handyman SLA subject types.
 *
 * WHAT THIS NEVER OWNS
 * --------------------
 * Never a manually entered KPI. Never a transactional or authoritative record
 * — no persisted KPI rows, no writes of any kind, no scheduler and no engine.
 * Never an input to entitlement, settlement, pricing or payment (CR-HM-13/14
 * remain sole financial authorities). Never inferred from control-plane data.
 * Never written by clients (matrix row 19: clients present backend-derived
 * state; "no KPI entry client-side"). Derived performance never mutates SLA
 * facts, and an SLA breach never implies a performance write.
 *
 * FIREWALLS (frozen)
 * ------------------
 *   - SLA Engine != Performance Read Model — the engine persists clocks and
 *     breach facts and stops there; this model reads those facts and stops
 *     there.
 *   - FM firewall — FM Work Order applied SLAs, FM subjects and FM
 *     `overdue`/KPI fields are never performance truth. The derivation admits
 *     Handyman SLA subject types and the `HANDYMAN_` entity namespace only.
 *   - SaaS firewall — no subscription/entitlement/billing fact gates, biases
 *     or enters the derivation.
 *   - Notification/audit/outbox — notification records and outbox/webhook
 *     rows are NOT inputs (the outbox is a prospective marker, not an event
 *     store); operational events are READ from the single audit authority,
 *     never written here.
 */

import type { HandymanSlaMilestoneName, HandymanSlaSubjectType } from '../sla-definitions/handyman-sla-subjects';

/** Query scope of one derived snapshot. */
export type HandymanPerformanceScope = {
  clientId: string;
  buildingId?: string | null;
  /** Inclusive window start (ISO instant). */
  from: Date;
  /** Exclusive window end (ISO instant). */
  to: Date;
};

/**
 * The governed-input law (§6.1): these are the ONLY inputs. Nothing else is
 * an input — no outbox/webhook deliveries, no notification records, no manual
 * KPI values, no control-plane records.
 */
export const HANDYMAN_PERFORMANCE_INPUT_LAW = Object.freeze({
  inputs: Object.freeze([
    'governed Handyman operational events (certified CR-HM-01..15 domain vocabulary)',
    'authoritative SLA outcomes (applied snapshots + clock status/breach facts)',
  ]),
  nothingElseIsAnInput: true,
  excludedInputs: Object.freeze([
    'outbox/webhook deliveries',
    'notification records',
    'manual KPI values',
    'control-plane records',
  ]),
});

/**
 * The separation law (§6.3/§6.4): what a derived performance figure can never
 * be. Booleans are frozen facts, not settings.
 */
export const HANDYMAN_PERFORMANCE_SEPARATION_LAW = Object.freeze({
  derivedAnalyticsOnly: true,
  manualKpiEntry: false,
  transactionalAuthority: false,
  lifecycleAuthority: false,
  entitlementSettlementPricingPaymentInput: false,
  inferredFromControlPlane: false,
  writtenByClients: false,
  mutatesSlaFacts: false,
  slaBreachImpliesPerformanceWrite: false,
  persistedKpiRows: false,
  schedulerOrEngine: false,
});

/** Raw outcome counts of one clock cohort (the governed SLA facts, counted). */
export type SlaOutcomeCounts = {
  clocks: number;
  satisfied: number;
  /** Satisfied with NO first-write breach fact — met within target. */
  satisfiedWithinTarget: number;
  /** First-write breach facts — the authoritative missed-marker. */
  breached: number;
  terminated: number;
  running: number;
  /**
   * DERIVED: satisfiedWithinTarget / (satisfiedWithinTarget + breached),
   * percent rounded to 2 decimals; null when no milestone has been decided
   * (no met and no missed). Formula tuning is product governance; the INPUT
   * law above is frozen.
   */
  attainmentPercent: number | null;
};

/** One frozen milestone's derived adherence (capability-map row 19). */
export type HandymanMilestoneAdherence = SlaOutcomeCounts & {
  milestone: HandymanSlaMilestoneName;
  subjectType: HandymanSlaSubjectType;
  clockType: 'RESPONSE' | 'RESOLUTION';
};

/** Response/resolution attainment aggregated across Handyman subject types. */
export type HandymanResponseResolutionAttainment = SlaOutcomeCounts & {
  clockType: 'RESPONSE' | 'RESOLUTION';
};

/** One certified domain event type's sequenced truth in the window. */
export type HandymanOperationalTruthEntry = {
  eventType: string;
  occurrences: number;
  firstOccurredAt: string;
  lastOccurredAt: string;
};

/**
 * The PUBLISHED read contract for CR-HM-17/18/22. Every field is
 * backend-derived; no field may ever be written, tuned or overridden by a
 * client. Date fields are ISO strings so the contract crosses process
 * boundaries unchanged.
 */
export type HandymanProviderPerformanceSnapshot = {
  scope: { clientId: string; buildingId: string | null; from: string; to: string };
  derivedAt: string;
  /** Governed-input counts for transparency; never an authority. */
  inputs: { slaClocks: number; operationalEvents: number };
  /** Derived from SLA outcome facts; RESPONSE then RESOLUTION. */
  responseResolutionAttainment: HandymanResponseResolutionAttainment[];
  /** Derived per frozen milestone (all nine always present, zero-filled). */
  milestoneAdherence: HandymanMilestoneAdherence[];
  /** Event-sequenced operational truth; absent type = zero occurrences. */
  operationalTruth: HandymanOperationalTruthEntry[];
};
