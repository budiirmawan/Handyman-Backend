import { getPool } from '../../database';
import type { SlaClockStatus, SlaClockType } from '../applied-slas/applied-sla.types';
import type { SlaEscalationActionStatus } from '../sla-escalation-actions/sla-escalation-action.types';
import type {
  PublicWorkOrderSlaRow,
  WorkOrderSlaRegisterFilters,
} from './work-order-sla-register.types';

/**
 * R10 PART 06 — Work Order SLA Register repository.
 *
 * One read-only statement over the EXISTING SLA authority. No writes, no ETL, no new
 * tables, no new SLA rule and no new clock, breach, pause or escalation semantics.
 *
 * GRAIN — exactly one row per `sla_clocks` row. `applied_slas` drives the query and
 * the clock is INNER JOINed to it, so a clock can only ever appear through its own
 * applied SLA and a Work Order with both clocks yields two rows. There is no
 * `GROUP BY work_order_id`, no `DISTINCT ON (work_order_id)`, no per-Work-Order
 * LIMIT 1, no coalescing of RESPONSE into RESOLUTION and no "primary clock".
 *
 * SCOPE — `sla_clocks` and `sla_clock_pause_intervals` have no client_id and no
 * building_id, so the base predicate is `a.building_id = ANY($1::uuid[])` on
 * `applied_slas`, the scope bridge. Nothing is scoped by `work_order_id` or
 * `sla_clock_id` without first traversing `applied_slas`.
 *
 * WORK ORDER ENRICHMENT — LEFT JOIN pinned to structural equality on all three of
 * `wo.id = a.work_order_id AND wo.client_id = a.client_id AND wo.building_id =
 * a.building_id`, never UUID uniqueness alone. LEFT so a clock row survives malformed
 * enrichment (number/status become NULL) instead of vanishing, and the extra
 * equalities so a cross-client or cross-building reference can never widen
 * visibility. This mirrors the sibling register read models' isolation convention.
 *
 * PAUSE — intervals are 1:N and are NEVER flattened into the clock row. One LATERAL
 * produces bounded aggregates only (`pause_count`, `total_paused_milliseconds`,
 * `is_paused`), scoped by `p.sla_clock_id = c.id`: the clock is already in scope
 * through `applied_slas`, which is the only traversal available because pause
 * intervals carry no client or building column. Pause actor identities are not
 * selected.
 *
 * PAUSE DEDUCTION — TWO DIFFERENT THINGS, kept strictly apart:
 *
 *   (A) PERSISTED PAUSE FACTS. `pauseCount`, `totalPausedMilliseconds` and
 *       `isPaused` report the clock's own `sla_clock_pause_intervals` rows exactly
 *       as persisted, for ANY clock type. A RESPONSE clock carrying legacy,
 *       malformed or externally-created pause rows still reports them: they are
 *       never erased, zeroed or hidden to make (B) come out right.
 *
 *   (B) DEDUCTION FROM ELAPSED. `effectiveElapsedMilliseconds` deducts pause
 *       duration ONLY when `c.clock_type = 'RESOLUTION'`; for a RESPONSE clock the
 *       deduction is structurally 0 no matter what pause rows exist.
 *
 * The RESOLUTION-only guard is the SLA domain's OWN authoritative deduction shape
 * (`CASE WHEN clock_type='RESOLUTION' THEN <pause sum> ELSE 0 END`, as used by
 * `markBreached` / `findDueRunning`), restored here around the read-side pause sum.
 * Relying on the write path only ever opening RESOLUTION pauses would not be
 * structurally sufficient for Reporting, which must stay correct against persisted,
 * legacy, malformed or externally-created rows — so the guard is expressed in the
 * statement itself rather than assumed from caller behaviour.
 *
 * The wall-clock elapsed term and the pause sum still reuse the domain's read-side
 * accounting formula (`appliedSlaRepository.pauseAccounting`) verbatim —
 * `FLOOR(EXTRACT(EPOCH …) * 1000)` and `GREATEST(0, …)` — so no new elapsed formula
 * is invented: the only addition is the required clock-type guard. The breach
 * threshold comparison and its `* 60000` constant are NOT copied into Reporting.
 *
 * ELAPSED — `effectiveElapsedMilliseconds` is CURRENT-ONLY, evaluated at the bound
 * `asOf` instant. It is not a historical snapshot and is never labelled
 * elapsed-at-breach, historical or final elapsed. `asOf` is bound as a parameter in
 * place of the domain's `statement_timestamp()` so that every row of one load shares
 * exactly one read-time instant, which is what makes the envelope's `asOf` truthful.
 *
 * BREACH — `c.breached_at` only. Never derived from `started_at`, `target_minutes`
 * or the current time, and no approaching-breach threshold exists.
 *
 * ESCALATION — actions are 1:N and are NEVER flattened. Two LATERALs produce the
 * bounded count and the single latest fact. Both are pinned structurally to the
 * authoritative applied SLA AND clock (`applied_sla_id`, `sla_clock_id`,
 * `work_order_id`, `client_id`, `building_id` all equal to the applied SLA's), never
 * joined by `work_order_id` alone. "Latest" follows the escalation domain's own
 * ordering authority for a clock's ladder (`ORDER BY level`, see
 * `sla-escalation-action.repository`), taken descending and made fully deterministic
 * with `created_at DESC, id DESC`. Recipient identities (`recipient_rule`,
 * `recipients_resolved`, `notifications_created`, `template_key`) are not selected
 * and no second escalation timeline is built here.
 *
 * DATE WINDOW — UTC half-open `[start, end)` over `applied_slas.applied_at`.
 *
 * ORDERING — deterministic over persisted identifiers and timestamps only:
 * `a.applied_at, a.work_order_id, c.clock_type, c.id`. Never a mutable presentation
 * name such as a Work Order number or title.
 */

type SlaRegisterRow = {
  applied_sla_id: string;
  work_order_id: string;
  work_order_number: string | null;
  work_order_status: string | null;
  client_id: string;
  building_id: string;
  sla_definition_id: string;
  definition_code: string;
  operational_type: 'WORK_ORDER';
  definition_work_type: string | null;
  definition_priority: string | null;
  work_order_work_type: string;
  work_order_priority: string;
  response_target_minutes: number | null;
  resolution_target_minutes: number | null;
  definition_effective_from: Date;
  definition_effective_to: Date | null;
  applied_at: Date;
  sla_clock_id: string;
  clock_type: SlaClockType;
  target_minutes: number;
  started_at: Date;
  clock_status: SlaClockStatus;
  satisfied_at: Date | null;
  terminated_at: Date | null;
  breached_at: Date | null;
  is_paused: boolean;
  pause_count: number;
  /** bigint arrives as a string from node-pg. */
  total_paused_milliseconds: string;
  /** bigint arrives as a string from node-pg. */
  effective_elapsed_milliseconds: string;
  escalation_count: number;
  latest_escalation_level: number | null;
  latest_escalation_status: SlaEscalationActionStatus | null;
  latest_escalation_triggered_at: Date | null;
};

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function mapRow(row: SlaRegisterRow): PublicWorkOrderSlaRow {
  return {
    appliedSlaId: row.applied_sla_id,
    workOrderId: row.work_order_id,
    workOrderNumber: row.work_order_number,
    workOrderStatus: row.work_order_status,
    clientId: row.client_id,
    buildingId: row.building_id,
    slaDefinitionId: row.sla_definition_id,
    definitionCode: row.definition_code,
    operationalType: row.operational_type,
    definitionWorkType: row.definition_work_type,
    definitionPriority: row.definition_priority,
    workOrderWorkType: row.work_order_work_type,
    workOrderPriority: row.work_order_priority,
    responseTargetMinutes: row.response_target_minutes,
    resolutionTargetMinutes: row.resolution_target_minutes,
    definitionEffectiveFrom: row.definition_effective_from.toISOString(),
    definitionEffectiveTo: toIso(row.definition_effective_to),
    appliedAt: row.applied_at.toISOString(),
    slaClockId: row.sla_clock_id,
    clockType: row.clock_type,
    targetMinutes: row.target_minutes,
    startedAt: row.started_at.toISOString(),
    clockStatus: row.clock_status,
    satisfiedAt: toIso(row.satisfied_at),
    terminatedAt: toIso(row.terminated_at),
    breachedAt: toIso(row.breached_at),
    isPaused: row.is_paused,
    pauseCount: row.pause_count,
    totalPausedMilliseconds: Number(row.total_paused_milliseconds),
    effectiveElapsedMilliseconds: Number(row.effective_elapsed_milliseconds),
    escalationCount: row.escalation_count,
    latestEscalationLevel: row.latest_escalation_level,
    latestEscalationStatus: row.latest_escalation_status,
    latestEscalationTriggeredAt: toIso(row.latest_escalation_triggered_at),
  };
}

/**
 * Reads Work Order SLA clock rows for an already-authorized Building scope.
 *
 * `buildingIds` is the caller's resolved authorized scope — this function never
 * resolves or widens it. `asOf` is the single read-time instant behind the four
 * CURRENT-ONLY fields.
 */
export async function getWorkOrderSlaRegisterRows(
  buildingIds: string[],
  filters: WorkOrderSlaRegisterFilters,
  start: Date | null,
  end: Date | null,
  asOf: Date,
): Promise<PublicWorkOrderSlaRow[]> {
  // $1 is the authorized Building scope, $2 the shared read-time instant; every
  // filter binds from $3 upward so no value is ever interpolated into SQL.
  const conditions: string[] = ['a.building_id = ANY($1::uuid[])'];
  const values: unknown[] = [buildingIds, asOf];

  // Narrowing only. `buildingId` is resolved into `buildingIds` by the caller and is
  // never re-applied here as a substitute for the authorized scope.
  if (filters.workOrderId) {
    values.push(filters.workOrderId);
    conditions.push(`a.work_order_id = $${values.length}`);
  }
  if (filters.clockType) {
    values.push(filters.clockType);
    conditions.push(`c.clock_type = $${values.length}`);
  }
  if (filters.clockStatus) {
    values.push(filters.clockStatus);
    conditions.push(`c.status = $${values.length}`);
  }
  if (typeof filters.breached === 'boolean') {
    // Persisted breach truth only — never recomputed, never a threshold.
    conditions.push(filters.breached ? 'c.breached_at IS NOT NULL' : 'c.breached_at IS NULL');
  }
  if (typeof filters.paused === 'boolean') {
    // Read-time open-pause state at `asOf`, from the clock's own intervals.
    conditions.push(
      filters.paused
        ? 'COALESCE(ps.is_paused, FALSE) IS TRUE'
        : 'COALESCE(ps.is_paused, FALSE) IS NOT TRUE',
    );
  }
  if (filters.escalationStatus) {
    values.push(filters.escalationStatus);
    conditions.push(`le.status = $${values.length}`);
  }
  if (filters.definitionCode) {
    values.push(filters.definitionCode);
    conditions.push(`a.definition_code = $${values.length}`);
  }
  if (filters.workType) {
    values.push(filters.workType);
    conditions.push(`a.work_order_work_type = $${values.length}`);
  }
  if (filters.priority) {
    values.push(filters.priority);
    conditions.push(`a.work_order_priority = $${values.length}`);
  }
  if (start) {
    values.push(start);
    conditions.push(`a.applied_at >= $${values.length}`);
  }
  if (end) {
    values.push(end);
    conditions.push(`a.applied_at < $${values.length}`);
  }

  const result = await getPool().query<SlaRegisterRow>(
    `SELECT
       a.id AS applied_sla_id,
       a.work_order_id AS work_order_id,
       wo.work_order_number AS work_order_number,
       wo.status AS work_order_status,
       a.client_id AS client_id,
       a.building_id AS building_id,
       a.sla_definition_id AS sla_definition_id,
       a.definition_code AS definition_code,
       a.operational_type AS operational_type,
       a.definition_work_type AS definition_work_type,
       a.definition_priority AS definition_priority,
       a.work_order_work_type AS work_order_work_type,
       a.work_order_priority AS work_order_priority,
       a.response_target_minutes AS response_target_minutes,
       a.resolution_target_minutes AS resolution_target_minutes,
       a.definition_effective_from AS definition_effective_from,
       a.definition_effective_to AS definition_effective_to,
       a.applied_at AS applied_at,
       c.id AS sla_clock_id,
       c.clock_type AS clock_type,
       c.target_minutes AS target_minutes,
       c.started_at AS started_at,
       c.status AS clock_status,
       c.satisfied_at AS satisfied_at,
       c.terminated_at AS terminated_at,
       c.breached_at AS breached_at,
       COALESCE(ps.is_paused, FALSE) AS is_paused,
       COALESCE(ps.pause_count, 0)::int AS pause_count,
       COALESCE(ps.total_paused_milliseconds, 0)::bigint AS total_paused_milliseconds,
       GREATEST(0,
         FLOOR(EXTRACT(EPOCH FROM ($2 - c.started_at)) * 1000)
         - CASE WHEN c.clock_type = 'RESOLUTION'
                THEN COALESCE(ps.total_paused_milliseconds, 0)
                ELSE 0
           END
       )::bigint AS effective_elapsed_milliseconds,
       COALESCE(es.escalation_count, 0)::int AS escalation_count,
       le.level AS latest_escalation_level,
       le.status AS latest_escalation_status,
       le.triggered_at AS latest_escalation_triggered_at
     FROM applied_slas a
     INNER JOIN sla_clocks c
       ON c.applied_sla_id = a.id
     LEFT JOIN work_orders wo
       ON wo.id = a.work_order_id
      AND wo.client_id = a.client_id
      AND wo.building_id = a.building_id
     LEFT JOIN LATERAL (
       SELECT
         count(p.id)::int AS pause_count,
         COALESCE(SUM(
           FLOOR(EXTRACT(EPOCH FROM (COALESCE(p.resumed_at, $2) - p.paused_at)) * 1000)
         ), 0)::bigint AS total_paused_milliseconds,
         bool_or(p.resumed_at IS NULL) AS is_paused
       FROM sla_clock_pause_intervals p
       WHERE p.sla_clock_id = c.id
     ) ps ON TRUE
     LEFT JOIN LATERAL (
       SELECT count(*)::int AS escalation_count
       FROM sla_escalation_actions ea
       WHERE ea.sla_clock_id = c.id
         AND ea.applied_sla_id = a.id
         AND ea.work_order_id = a.work_order_id
         AND ea.client_id = a.client_id
         AND ea.building_id = a.building_id
     ) es ON TRUE
     LEFT JOIN LATERAL (
       SELECT ea.level, ea.status, ea.triggered_at
       FROM sla_escalation_actions ea
       WHERE ea.sla_clock_id = c.id
         AND ea.applied_sla_id = a.id
         AND ea.work_order_id = a.work_order_id
         AND ea.client_id = a.client_id
         AND ea.building_id = a.building_id
       ORDER BY ea.level DESC, ea.created_at DESC, ea.id DESC
       LIMIT 1
     ) le ON TRUE
     WHERE ${conditions.join('\n       AND ')}
     ORDER BY a.applied_at ASC, a.work_order_id ASC, c.clock_type ASC, c.id ASC`,
    values,
  );

  return result.rows.map(mapRow);
}
