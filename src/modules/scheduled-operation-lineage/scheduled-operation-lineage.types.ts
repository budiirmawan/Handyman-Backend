import type { AssigneeType } from '../cleaning-assignments/cleaning-assignment.types';

/**
 * R10 PART 09 — Scheduled Operation Lineage read-model contract.
 *
 * A bounded Reporting read model over persisted schedule → generated-task lineage. It
 * is NOT a scheduler engine, NOT a task KPI, NOT a missed/overdue derivation, NOT an
 * execution-history engine, NOT a recurrence history and NOT a universal operational
 * lineage graph. It only re-presents relationships the schema already persists.
 *
 * GRAIN — ONE ROW PER `generated_tasks.id`. `generated_tasks.id` is the row identity.
 * Nothing is collapsed by `schedule_definition_id`, `task_id`,
 * `checklist_execution_id`, `form_instance_id`, recurrence or assignment, and no child
 * rows are fanned out. Every join below is provably 0..1 or 1..1, so the row count is
 * always exactly the number of in-scope generated tasks:
 *
 *   schedule_definitions     1..1  `generated_tasks.schedule_definition_id` is NOT NULL
 *                                  and FK-bound (migration 0077)
 *   schedule_recurrence      0..1  `recurrence_schedule_unique UNIQUE
 *                                  (schedule_definition_id)` (migration 0076) — TOTAL
 *                                  recurrence per schedule, never recurrence history
 *   checklist_executions     0..1  partial unique index
 *                                  `checklist_executions_generated_task_unique`
 *                                  (migration 0339)
 *   form_instances           0..1  partial unique index
 *                                  `form_instances_generated_task_unique`
 *                                  (migration 0340)
 *   task_assignments         0..1  partial unique index `task_active_assignment_unique
 *                                  ON (task_id) WHERE status='ACTIVE'` (migration 0078)
 *   workforce_profiles       0..1  PK lookup on the assignment's own FK
 *   teams                    0..1  PK lookup on the assignment's own FK
 *
 * SCOPE — the base authority is `generated_tasks.building_id = ANY($1::uuid[])`.
 * `generated_tasks.building_id` is NULLABLE and the task domain's own list route
 * deliberately widens to client-scoped rows via
 * `(building_id IS NULL AND client_id = ANY(...))`. THIS read model does not: a
 * NULL-building generated task is excluded, `client_id` alone is never sufficient scope
 * authority, and no client-only branch may reintroduce those rows.
 *
 * NO TASK ENTITY — the schema has no `tasks` table and `generated_tasks` has no
 * `task_id` column: `generated_tasks.id` IS the task identity, and
 * `task_assignments.task_id` is simply its FK back to `generated_tasks.id`. There is
 * therefore no distinct `taskId` to expose, and none is invented.
 *
 * NO EXECUTION FACTS — `generated_tasks.started_at`, `completed_at`,
 * `completed_by_user_id` and `completion_notes` (migration 0079) and
 * `maintenance_binding_id` (migration 0108) are persisted but deliberately NOT part of
 * this contract: they are execution history and a domain-specific binding, both out of
 * scope for a lineage read model. Nothing here derives or renames them.
 */

/**
 * `generated_tasks.status` — migration 0077 created it as CHECK IN ('OPEN') and
 * migration 0079 replaced that constraint with the five persisted values below. This is
 * the task's OWN persisted lifecycle status; it is never reinterpreted as "Completed On
 * Time", "Late", "Missed", "Overdue", "Successful" or "Failed".
 */
export type GeneratedTaskStatus =
  | 'OPEN'
  | 'ASSIGNED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'CANCELLED';

/** `schedule_definitions.status` — constraint `schedule_status` (migration 0075). */
export type ScheduleDefinitionStatus = 'ACTIVE' | 'INACTIVE';

/** `schedule_recurrence.frequency` — constraint `recurrence_frequency` (migration 0076). */
export type RecurrenceFrequency = 'DAILY' | 'WEEKLY' | 'MONTHLY';

/** `schedule_recurrence.status` — constraint `recurrence_status` (migration 0076). */
export type RecurrenceStatus = 'ACTIVE' | 'INACTIVE';

/**
 * Bounded filters at the generated-task grain. Exactly these — no `missed`, `overdue`,
 * `graceMinutes`, `executor`, `completedBy`, `clientId` scope override, `limit`,
 * `offset`, `sort` or `search`, and no second date mode.
 */
export type ScheduledOperationLineageFilters = {
  /**
   * Optional. Omitted means "roll up across every Building the caller can access";
   * supplied means the Building is existence-checked and access-asserted. Resolved into
   * the authorized `buildingIds` scope by the PART 10 service — the repository never
   * treats it as a substitute for that scope, and it can never widen it.
   */
  buildingId?: string;
  /** Narrows to one schedule definition's generated tasks. Never a scope substitute. */
  scheduleDefinitionId?: string;
  /** Narrows to ONE generated task, i.e. to at most one row. */
  generatedTaskId?: string;
  /** Persisted generated-task status only — never a derived timeliness judgement. */
  status?: GeneratedTaskStatus;
  /** Narrows to the generated task bound to one checklist execution (0..1 binding). */
  checklistExecutionId?: string;
  /** Narrows to the generated task bound to one form instance (0..1 binding). */
  formInstanceId?: string;
  /** Existing assignment vocabulary authority: WORKFORCE | TEAM. */
  assigneeType?: AssigneeType;
  /** Narrows on the ACTIVE assignment's workforce profile. Assignment, not execution. */
  assignedWorkforceProfileId?: string;
  /** Narrows on the ACTIVE assignment's team. Assignment, not execution. */
  assignedTeamId?: string;
  /** ISO date (YYYY-MM-DD) or datetime; day windows are UTC half-open. */
  dateFrom?: string;
  /** ISO date (YYYY-MM-DD) or datetime; day windows are UTC half-open. */
  dateTo?: string;
};

/**
 * One Scheduled Operation Lineage row = ONE `generated_tasks` row, enriched with its
 * schedule definition, that schedule's single TOTAL recurrence, its 0..1 checklist and
 * form bindings, and its 0..1 ACTIVE assignment.
 *
 * NULLABLE ENRICHMENT — schedule, recurrence, binding and assignment fields are NULL
 * whenever the relationship is absent or fails structural scope equality. A generated
 * task row always survives as a row; enrichment is dropped to NULL instead, so a
 * malformed cross-client or cross-building reference can never widen visibility and can
 * never delete lineage that does exist.
 *
 * NAME SEMANTICS — `scheduleDefinitionName`, `assignedWorkforceName` and
 * `assignedTeamName` are LIVE/CURRENT names read from their reference tables, not
 * persisted snapshots; the schema stores no historical name on any of these rows. The
 * accompanying IDs are durable, the names may change, and nothing here is labelled as a
 * snapshot name.
 *
 * ASSIGNMENT SEMANTICS — every assignment field describes who the task is ASSIGNED to.
 * None of it is executor authority: assignment is not execution, and the contract
 * exposes no `executor`, `executedBy`, `performedBy` or `completedBy` field.
 */
export type PublicScheduledOperationLineageRow = {
  /** `generated_tasks.id` — the row identity and the task identity. */
  generatedTaskId: string;
  /** `generated_tasks.client_id`, NOT NULL. */
  clientId: string;
  /** `generated_tasks.building_id`; never NULL in this read model (NULL rows excluded). */
  buildingId: string;

  /** `generated_tasks.schedule_definition_id`, NOT NULL and FK-bound. */
  scheduleDefinitionId: string;
  /** `schedule_definitions.code`; NULL if structural scope equality fails. */
  scheduleDefinitionCode: string | null;
  /** `schedule_definitions.name` — LIVE/CURRENT, not a snapshot. */
  scheduleDefinitionName: string | null;
  /** `schedule_definitions.status` — persisted ACTIVE | INACTIVE. */
  scheduleDefinitionStatus: ScheduleDefinitionStatus | null;

  /** `generated_tasks.status` — persisted lifecycle status, never reinterpreted. */
  status: GeneratedTaskStatus;
  /** `generated_tasks.occurrence_at` — the authoritative planned occurrence instant. */
  occurrenceAt: string;
  /** `generated_tasks.generated_at` — when the row was generated. */
  generatedAt: string;

  /** `checklist_executions.id` bound to this task (0..1); kept separate from the form. */
  checklistExecutionId: string | null;
  /** `form_instances.id` bound to this task (0..1); never merged into an executionId. */
  formInstanceId: string | null;

  /** `task_assignments.assignee_type` of the single ACTIVE assignment, if any. */
  assigneeType: AssigneeType | null;
  /** `task_assignments.workforce_profile_id`; NULL for a TEAM assignment. */
  assignedWorkforceProfileId: string | null;
  /** `workforce_profiles.full_name` — LIVE/CURRENT, not a snapshot. */
  assignedWorkforceName: string | null;
  /** `task_assignments.team_id`; NULL for a WORKFORCE assignment. */
  assignedTeamId: string | null;
  /** `teams.name` — LIVE/CURRENT, not a snapshot. */
  assignedTeamName: string | null;

  /** `schedule_recurrence.frequency` — DAILY | WEEKLY | MONTHLY. */
  recurrenceFrequency: RecurrenceFrequency | null;
  /** `schedule_recurrence.interval`, NOT NULL with CHECK (interval > 0) when present. */
  recurrenceInterval: number | null;
  /** `schedule_recurrence.days_of_week`, INTEGER[] constrained to 0..6. */
  recurrenceDaysOfWeek: number[] | null;
  /** `schedule_recurrence.day_of_month`, constrained to 1..31. */
  recurrenceDayOfMonth: number | null;
  /** `schedule_recurrence.start_date`, DATE, presented as YYYY-MM-DD. */
  recurrenceStartDate: string | null;
  /** `schedule_recurrence.end_date`, DATE, presented as YYYY-MM-DD. */
  recurrenceEndDate: string | null;
  /**
   * `schedule_recurrence.status` — the persisted status of the schedule's single TOTAL
   * recurrence row. Exposed verbatim and never filtered away, so an INACTIVE recurrence
   * stays visible as lineage rather than silently disappearing.
   */
  recurrenceStatus: RecurrenceStatus | null;
};

/**
 * Public read-model envelope, shaped for the PART 10 service. Scope resolution is NOT
 * implemented here.
 *
 * `asOf` exists for envelope consistency across Reporting read models. Unlike the Work
 * Order SLA register, this contract has NO current-time-derived field — every value is
 * persisted — so the repository neither takes an instant nor reads a clock, and the
 * service supplies `asOf` purely as the read instant of the envelope.
 */
export type PublicScheduledOperationLineage = {
  /** Null when the read model is a multi-building rollup. */
  buildingId: string | null;
  /** Every Building actually included in the rows. */
  buildingScope: string[];
  dateFrom: string | null;
  dateTo: string | null;
  /** The instant the envelope was read. No business fact in `rows` is derived from it. */
  asOf: string;
  rows: PublicScheduledOperationLineageRow[];
};
