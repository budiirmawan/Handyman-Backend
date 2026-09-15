import { getPool } from '../../database';
import type {
  GeneratedTaskStatus,
  PublicScheduledOperationLineageRow,
  RecurrenceFrequency,
  RecurrenceStatus,
  ScheduleDefinitionStatus,
  ScheduledOperationLineageFilters,
} from './scheduled-operation-lineage.types';
import type { AssigneeType } from '../cleaning-assignments/cleaning-assignment.types';

/**
 * R10 PART 09 — Scheduled Operation Lineage repository.
 *
 * ONE read-only statement over the EXISTING schedule / generated-task schema. No writes,
 * no ETL, no new table, no new status vocabulary, no scheduler logic and no KPI. Every
 * column selected is persisted data; nothing is derived.
 *
 * GRAIN — exactly one row per `generated_tasks.id`, which is the FROM table. There is no
 * `GROUP BY`, no `DISTINCT ON`, no `LIMIT 1` per task and no window function, because no
 * join can multiply a row: `schedule_definitions` is 1..1 through a NOT NULL FK,
 * `schedule_recurrence` is 0..1 by `recurrence_schedule_unique UNIQUE
 * (schedule_definition_id)` (0076), `checklist_executions` is 0..1 by the partial unique
 * index `checklist_executions_generated_task_unique` (0339), `form_instances` is 0..1 by
 * `form_instances_generated_task_unique` (0340), and `task_assignments` is 0..1 by
 * `task_active_assignment_unique ON (task_id) WHERE status='ACTIVE'` (0078). The two name
 * lookups are PK joins on the assignment's own FKs. Row count therefore equals the number
 * of in-scope generated tasks, and no child grain is fanned out.
 *
 * SCOPE — fail-closed on `gt.building_id = ANY($1::uuid[])`. `generated_tasks.building_id`
 * is nullable and the task domain's own list route widens with
 * `OR (building_id IS NULL AND client_id = ANY($2))`; that client-only branch is
 * deliberately NOT reproduced here, so NULL-building generated tasks are excluded and
 * `client_id` alone is never treated as scope authority. The explicit
 * `gt.building_id IS NOT NULL` is redundant against `= ANY(...)` (NULL never matches) and
 * is kept so the exclusion stays visible and cannot be lost to a later refactor.
 *
 * STRUCTURAL EQUALITY — `schedule_definitions` carries authoritative `client_id` and
 * `building_id`, so the join pins all three of `sd.id = gt.schedule_definition_id AND
 * sd.client_id = gt.client_id AND sd.building_id IS NOT DISTINCT FROM gt.building_id`
 * rather than trusting UUID uniqueness alone. `IS NOT DISTINCT FROM` is the correct form
 * for these two nullable columns and is lossless here: the generator inserts
 * `generated_tasks.building_id` directly from `schedule_definitions.building_id`
 * (`src/modules/tasks/task.routes.ts`), so a legitimate parent always matches, while a
 * malformed cross-client or cross-building reference yields NULL enrichment instead of
 * widened visibility.
 *
 * RECURRENCE — a plain bounded join on the schedule's own id, with NO LATERAL, NO
 * `LIMIT 1`, NO `MAX(created_at)`, NO "latest"/"current" recurrence selector and NO
 * recurrence count, because 0076 makes recurrence TOTAL at 0..1 per schedule rather than
 * a history. It is joined through `sd.id` and not `gt.schedule_definition_id` so that a
 * schedule whose structural equality failed contributes neither definition nor recurrence
 * facts. `sr.status` is NOT filtered: this is a lineage read model, not a scheduler, and
 * the `status='ACTIVE'` predicate the generation path uses would hide INACTIVE recurrence
 * and turn `recurrenceStatus` into a constant.
 *
 * EXECUTION BINDINGS — exposed as two separate fields, `checklistExecutionId` and
 * `formInstanceId`, each joined on its own `generated_task_id` FK plus `client_id`
 * equality. They are never merged into a generic `executionId`, no engine is inferred from
 * whichever happens to be non-NULL, and neither binding is expanded into execution
 * history: only the bound row's id is selected, never its status, timestamps, responses
 * or actor.
 *
 * ASSIGNMENT — `ta.status = 'ACTIVE'` is the owning domain's own deterministic current
 * assignment shape (`housekeeping-report.repository.ts`), and 0078's partial unique index
 * makes it 0..1 at the database level. Because ambiguity is structurally impossible for
 * ACTIVE assignments, no bounded selector, no invented precedence and no `assignmentCount`
 * is needed; INACTIVE rows are never consulted, so this is not an assignment history.
 * `assigned_by_user_id` is not selected. Field names stay assignment semantics: nothing
 * here claims executor, executedBy, performedBy or completedBy meaning.
 *
 * NO MISSED / OVERDUE — no missed, overdue, dueBefore, graceMinutes, late, delay, breach
 * or schedule-compliance value is derived, and no arithmetic touches `occurrence_at`. The
 * Security patrol KPI owns that derivation authority and this read model does not
 * reproduce it. `occurrence_at` is used only as a persisted timestamp and as the date
 * window authority.
 *
 * NO CLOCK — the contract has no current-time-derived field, so this repository takes no
 * `asOf` and reads no clock.
 *
 * ORDERING — deterministic over persisted values: `gt.occurrence_at ASC, gt.id ASC`, the
 * task domain's own convention. Never ordered by a mutable presentation name.
 */

/** Raw shape of the single statement, in select-list order. */
type ScheduledOperationLineageRow = {
  generated_task_id: string;
  client_id: string;
  building_id: string;
  schedule_definition_id: string;
  schedule_definition_code: string | null;
  schedule_definition_name: string | null;
  schedule_definition_status: ScheduleDefinitionStatus | null;
  status: GeneratedTaskStatus;
  occurrence_at: Date;
  generated_at: Date;
  checklist_execution_id: string | null;
  form_instance_id: string | null;
  assignee_type: AssigneeType | null;
  assigned_workforce_profile_id: string | null;
  assigned_workforce_name: string | null;
  assigned_team_id: string | null;
  assigned_team_name: string | null;
  recurrence_frequency: RecurrenceFrequency | null;
  recurrence_interval: number | null;
  recurrence_days_of_week: number[] | null;
  recurrence_day_of_month: number | null;
  /** DATE arrives as a Date or a string depending on the driver's type parsers. */
  recurrence_start_date: string | Date | null;
  /** DATE arrives as a Date or a string depending on the driver's type parsers. */
  recurrence_end_date: string | Date | null;
  recurrence_status: RecurrenceStatus | null;
};

function toIso(value: Date): string {
  return value.toISOString();
}

/**
 * Calendar-date presentation for a DATE column, following the owning domain's own
 * convention for `schedule_recurrence.start_date` / `end_date`
 * (`cleaning-schedule-binding.service.ts`, and the same helper shape in
 * `bast-document.repository.ts` / `vendor-bast-binding.repository.ts`). A DATE is a
 * calendar day, not an instant, so it is never emitted as a full ISO timestamp.
 */
function toDateOnly(value: string | Date | null): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function mapRow(row: ScheduledOperationLineageRow): PublicScheduledOperationLineageRow {
  return {
    generatedTaskId: row.generated_task_id,
    clientId: row.client_id,
    buildingId: row.building_id,
    scheduleDefinitionId: row.schedule_definition_id,
    scheduleDefinitionCode: row.schedule_definition_code,
    scheduleDefinitionName: row.schedule_definition_name,
    scheduleDefinitionStatus: row.schedule_definition_status,
    status: row.status,
    occurrenceAt: toIso(row.occurrence_at),
    generatedAt: toIso(row.generated_at),
    checklistExecutionId: row.checklist_execution_id,
    formInstanceId: row.form_instance_id,
    assigneeType: row.assignee_type,
    assignedWorkforceProfileId: row.assigned_workforce_profile_id,
    assignedWorkforceName: row.assigned_workforce_name,
    assignedTeamId: row.assigned_team_id,
    assignedTeamName: row.assigned_team_name,
    recurrenceFrequency: row.recurrence_frequency,
    recurrenceInterval: row.recurrence_interval,
    recurrenceDaysOfWeek: row.recurrence_days_of_week,
    recurrenceDayOfMonth: row.recurrence_day_of_month,
    recurrenceStartDate: toDateOnly(row.recurrence_start_date),
    recurrenceEndDate: toDateOnly(row.recurrence_end_date),
    recurrenceStatus: row.recurrence_status,
  };
}

/**
 * Reads scheduled-operation lineage rows for an already-authorized Building scope.
 *
 * `buildingIds` is the caller's resolved authorized scope — this function never resolves,
 * widens or substitutes it, and an empty scope simply yields no rows because
 * `= ANY('{}')` matches nothing. `start` (inclusive) and `end` (exclusive) bound
 * `gt.occurrence_at`, the authoritative planned occurrence instant; `created_at` is never
 * used as a fallback window and no default period is applied.
 */
export async function getScheduledOperationLineageRows(
  buildingIds: string[],
  filters: ScheduledOperationLineageFilters,
  start: Date | null,
  end: Date | null,
): Promise<PublicScheduledOperationLineageRow[]> {
  // $1 is the authorized Building scope; every filter binds from $2 upward so no value is
  // ever interpolated into the SQL text.
  const conditions: string[] = [
    'gt.building_id = ANY($1::uuid[])',
    'gt.building_id IS NOT NULL',
  ];
  const values: unknown[] = [buildingIds];

  // Narrowing only. `buildingId` is resolved into `buildingIds` by the caller and is never
  // re-applied here as a substitute for the authorized scope.
  if (filters.scheduleDefinitionId) {
    values.push(filters.scheduleDefinitionId);
    conditions.push(`gt.schedule_definition_id = $${values.length}`);
  }
  if (filters.generatedTaskId) {
    values.push(filters.generatedTaskId);
    conditions.push(`gt.id = $${values.length}`);
  }
  if (filters.status) {
    values.push(filters.status);
    conditions.push(`gt.status = $${values.length}`);
  }
  if (filters.checklistExecutionId) {
    values.push(filters.checklistExecutionId);
    conditions.push(`ce.id = $${values.length}`);
  }
  if (filters.formInstanceId) {
    values.push(filters.formInstanceId);
    conditions.push(`fi.id = $${values.length}`);
  }
  if (filters.assigneeType) {
    values.push(filters.assigneeType);
    conditions.push(`ta.assignee_type = $${values.length}`);
  }
  if (filters.assignedWorkforceProfileId) {
    values.push(filters.assignedWorkforceProfileId);
    conditions.push(`ta.workforce_profile_id = $${values.length}`);
  }
  if (filters.assignedTeamId) {
    values.push(filters.assignedTeamId);
    conditions.push(`ta.team_id = $${values.length}`);
  }
  // Half-open UTC window over the authoritative planned occurrence instant.
  if (start) {
    values.push(start);
    conditions.push(`gt.occurrence_at >= $${values.length}`);
  }
  if (end) {
    values.push(end);
    conditions.push(`gt.occurrence_at < $${values.length}`);
  }

  const result = await getPool().query<ScheduledOperationLineageRow>(
    `SELECT
       gt.id AS generated_task_id,
       gt.client_id AS client_id,
       gt.building_id AS building_id,
       gt.schedule_definition_id AS schedule_definition_id,
       sd.code AS schedule_definition_code,
       sd.name AS schedule_definition_name,
       sd.status AS schedule_definition_status,
       gt.status AS status,
       gt.occurrence_at AS occurrence_at,
       gt.generated_at AS generated_at,
       ce.id AS checklist_execution_id,
       fi.id AS form_instance_id,
       ta.assignee_type AS assignee_type,
       ta.workforce_profile_id AS assigned_workforce_profile_id,
       wp.full_name AS assigned_workforce_name,
       ta.team_id AS assigned_team_id,
       t.name AS assigned_team_name,
       sr.frequency AS recurrence_frequency,
       sr.interval AS recurrence_interval,
       sr.days_of_week AS recurrence_days_of_week,
       sr.day_of_month AS recurrence_day_of_month,
       sr.start_date AS recurrence_start_date,
       sr.end_date AS recurrence_end_date,
       sr.status AS recurrence_status
     FROM generated_tasks gt
     LEFT JOIN schedule_definitions sd
       ON sd.id = gt.schedule_definition_id
      AND sd.client_id = gt.client_id
      AND sd.building_id IS NOT DISTINCT FROM gt.building_id
     LEFT JOIN schedule_recurrence sr
       ON sr.schedule_definition_id = sd.id
     LEFT JOIN checklist_executions ce
       ON ce.generated_task_id = gt.id
      AND ce.client_id = gt.client_id
     LEFT JOIN form_instances fi
       ON fi.generated_task_id = gt.id
      AND fi.client_id = gt.client_id
     LEFT JOIN task_assignments ta
       ON ta.task_id = gt.id
      AND ta.status = 'ACTIVE'
     LEFT JOIN workforce_profiles wp
       ON wp.id = ta.workforce_profile_id
     LEFT JOIN teams t
       ON t.id = ta.team_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY gt.occurrence_at ASC, gt.id ASC`,
    values,
  );

  return result.rows.map(mapRow);
}
