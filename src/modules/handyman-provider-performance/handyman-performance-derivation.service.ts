import { getPool } from '../../database';
import {
  HANDYMAN_SLA_SUBJECT_MILESTONES,
  HANDYMAN_SLA_SUBJECT_TYPES,
} from '../sla-definitions/handyman-sla-subjects';
import { HANDYMAN_AUDIT_EVENT_CONTRACT } from '../handyman-audit';
import type {
  HandymanMilestoneAdherence,
  HandymanOperationalTruthEntry,
  HandymanPerformanceScope,
  HandymanProviderPerformanceSnapshot,
  HandymanResponseResolutionAttainment,
  SlaOutcomeCounts,
} from './handyman-performance-contract';

/**
 * CR-HM-16 PART 04 — provider performance derivation (read-only).
 *
 * Computes the published `HandymanProviderPerformanceSnapshot` at QUERY time
 * from governed facts only (§6): Handyman SLA outcomes (`applied_slas` +
 * `sla_clocks`, Handyman subject types only — the FM firewall) and certified
 * Handyman domain events (`operational_events`, `HANDYMAN_` entity namespace
 * only — the FM/SaaS firewall on the event side). Every statement is a
 * SELECT. Nothing is persisted, scheduled, or written — not SLA facts, not
 * notifications, not audit rows, not outbox rows.
 *
 * Milestone coordinates come from the PART 01 frozen map
 * (`HANDYMAN_SLA_SUBJECT_MILESTONES`) by reference — this module never
 * restates the milestone vocabulary. The certified event vocabulary comes
 * from the PART 03 audit contract by reference (`factKind === 'DOMAIN'`).
 */

/** The certified CR-HM-01..15 domain vocabulary (PART 03 audit contract). */
const DOMAIN_EVENT_TYPES: readonly string[] = HANDYMAN_AUDIT_EVENT_CONTRACT
  .filter((entry) => entry.factKind === 'DOMAIN')
  .map((entry) => entry.eventType);

type SlaOutcomeRow = {
  subjectType: string;
  clockType: string;
  clocks: number;
  satisfied: number;
  satisfiedWithinTarget: number;
  breached: number;
  terminated: number;
  running: number;
};

type OperationalTruthRow = {
  eventType: string;
  occurrences: number;
  firstOccurredAt: Date;
  lastOccurredAt: Date;
};

function percent(met: number, missed: number): number | null {
  const decided = met + missed;
  if (decided === 0) return null;
  return Math.round((met / decided) * 100 * 100) / 100;
}

function toCounts(row: Pick<SlaOutcomeRow, 'clocks' | 'satisfied' | 'satisfiedWithinTarget' | 'breached' | 'terminated' | 'running'>): SlaOutcomeCounts {
  return {
    clocks: row.clocks,
    satisfied: row.satisfied,
    satisfiedWithinTarget: row.satisfiedWithinTarget,
    breached: row.breached,
    terminated: row.terminated,
    running: row.running,
    attainmentPercent: percent(row.satisfiedWithinTarget, row.breached),
  };
}

const ZERO: SlaOutcomeCounts = {
  clocks: 0,
  satisfied: 0,
  satisfiedWithinTarget: 0,
  breached: 0,
  terminated: 0,
  running: 0,
  attainmentPercent: null,
};

/**
 * Derives one provider performance snapshot for the given scope/window.
 * Pure read: identical inputs always yield an identical snapshot (up to
 * `derivedAt`), and running it never changes any stored fact.
 */
export async function deriveHandymanProviderPerformance(
  scope: HandymanPerformanceScope,
): Promise<HandymanProviderPerformanceSnapshot> {
  const pool = getPool();
  const handymanTypes = [...HANDYMAN_SLA_SUBJECT_TYPES];
  const window = [scope.from, scope.to] as const;

  const slaRows = (
    await pool.query<SlaOutcomeRow>(
      `SELECT a.operational_type AS "subjectType",
              c.clock_type AS "clockType",
              count(*)::int AS clocks,
              count(*) FILTER (WHERE c.status='SATISFIED')::int AS satisfied,
              count(*) FILTER (WHERE c.status='SATISFIED' AND c.breached_at IS NULL)::int AS "satisfiedWithinTarget",
              count(*) FILTER (WHERE c.breached_at IS NOT NULL)::int AS breached,
              count(*) FILTER (WHERE c.status='TERMINATED')::int AS terminated,
              count(*) FILTER (WHERE c.status='RUNNING')::int AS running
         FROM sla_clocks c
         JOIN applied_slas a ON a.id = c.applied_sla_id
        WHERE a.client_id = $1
          AND a.operational_type = ANY($2::text[])
          AND c.started_at >= $3 AND c.started_at < $4
          ${scope.buildingId ? 'AND a.building_id = $5' : ''}
        GROUP BY 1, 2`,
      scope.buildingId
        ? [scope.clientId, handymanTypes, scope.from, scope.to, scope.buildingId]
        : [scope.clientId, handymanTypes, scope.from, scope.to],
    )
  ).rows;

  const eventRows = (
    await pool.query<OperationalTruthRow>(
      `SELECT event_type AS "eventType",
              count(*)::int AS occurrences,
              min(occurred_at) AS "firstOccurredAt",
              max(occurred_at) AS "lastOccurredAt"
         FROM operational_events
        WHERE client_id = $1
          AND event_type = ANY($2::text[])
          AND entity_type LIKE 'HANDYMAN\\_%'
          AND occurred_at >= $3 AND occurred_at < $4
          ${scope.buildingId ? 'AND building_id = $5' : ''}
        GROUP BY 1
        ORDER BY 1`,
      scope.buildingId
        ? [scope.clientId, [...DOMAIN_EVENT_TYPES], scope.from, scope.to, scope.buildingId]
        : [scope.clientId, [...DOMAIN_EVENT_TYPES], scope.from, scope.to],
    )
  ).rows;

  const byPair = new Map<string, SlaOutcomeRow>();
  for (const row of slaRows) {
    byPair.set(`${row.subjectType}|${row.clockType}`, row);
  }

  const milestoneAdherence: HandymanMilestoneAdherence[] = HANDYMAN_SLA_SUBJECT_MILESTONES.map(
    (m) => {
      const row = byPair.get(`${m.subjectType}|${m.clockType}`);
      return {
        milestone: m.milestone,
        subjectType: m.subjectType,
        clockType: m.clockType,
        ...(row ? toCounts(row) : ZERO),
      };
    },
  );

  const responseResolutionAttainment: HandymanResponseResolutionAttainment[] = (
    ['RESPONSE', 'RESOLUTION'] as const
  ).map((clockType) => {
    const totals = slaRows
      .filter((row) => row.clockType === clockType)
      .reduce(
        (acc, row) => ({
          clocks: acc.clocks + row.clocks,
          satisfied: acc.satisfied + row.satisfied,
          satisfiedWithinTarget: acc.satisfiedWithinTarget + row.satisfiedWithinTarget,
          breached: acc.breached + row.breached,
          terminated: acc.terminated + row.terminated,
          running: acc.running + row.running,
        }),
        { clocks: 0, satisfied: 0, satisfiedWithinTarget: 0, breached: 0, terminated: 0, running: 0 },
      );
    return { clockType, ...toCounts(totals) };
  });

  const operationalTruth: HandymanOperationalTruthEntry[] = eventRows.map((row) => ({
    eventType: row.eventType,
    occurrences: row.occurrences,
    firstOccurredAt: new Date(row.firstOccurredAt).toISOString(),
    lastOccurredAt: new Date(row.lastOccurredAt).toISOString(),
  }));

  return {
    scope: {
      clientId: scope.clientId,
      buildingId: scope.buildingId ?? null,
      from: scope.from.toISOString(),
      to: scope.to.toISOString(),
    },
    derivedAt: new Date().toISOString(),
    inputs: {
      slaClocks: slaRows.reduce((sum, row) => sum + row.clocks, 0),
      operationalEvents: eventRows.reduce((sum, row) => sum + row.occurrences, 0),
    },
    responseResolutionAttainment,
    milestoneAdherence,
    operationalTruth,
  };
}
