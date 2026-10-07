import { randomUUID } from 'node:crypto';
import { getPool, withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import {
  contextAccessService,
} from '../context-access';
import {
  finishChecklistExecution,
  loadChecklistExecutionRow,
  resolveAuthoritativeChecklistSourceContext,
  saveChecklistResponses,
  startChecklistExecution,
} from '../checklist-executions';
import type { ChecklistExecutionRow } from '../checklist-executions';
import {
  clientInactiveError,
  clientNotFoundError,
  clientRepository,
} from '../clients';
import {
  findingBuildingClientMismatchError,
  findingNumberAlreadyExistsError,
} from '../findings/finding.errors';
import { findingRepository } from '../findings/finding.repository';
import { recordFindingEvent } from '../finding-history/finding-history.service';
import { resolveCurrentShifts } from '../mobile-current-shift';
import {
  isBoundTaskExecutableByUser,
  resolveActiveTaskAssignment,
} from '../mobile-task-authority';
import { resolveBuildingClientId } from '../shifts';
import type {
  MobileChecklistEvidenceRequirement,
  MobileChecklistExecution,
  MobileChecklistFindingCreated,
  MobileChecklistItem,
  MobileChecklistMeasurement,
  MobileChecklistTaskReference,
  MobileChecklistTemplateReference,
  MobileChecklistUom,
} from './mobile-checklist.types';

/**
 * BE-25D — Mobile checklist execution read model.
 *
 * Assembles the mobile checklist execution contract for one execution,
 * strictly reusing the BE-07 authorities:
 *   - checklist_executions / checklist_templates / checklist_items (templates
 *     + items),
 *   - checklist_item_responses (stored values/status),
 *   - checklist_items.uom_id / minimum_value / maximum_value / decimal_precision
 *     + units_of_measure (measurement/UOM),
 *   - evidence_requirements (evidence requirements; submission is BE-25E),
 *   - generated_tasks via target reference (task context when the execution's
 *     template is the task's target).
 *
 * Client/Building scope is enforced with the BE-02G accessible-Client set.
 */

type ExecutionRow = {
  id: string;
  client_id: string;
  checklist_template_id: string;
  /** MOB-C04 PART 02A — authoritative generated-task binding (nullable). */
  generated_task_id: string | null;
  status: string;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type TemplateRow = {
  id: string;
  client_id: string;
  code: string;
  name: string;
  description: string | null;
  status: string;
};

type ItemRow = {
  id: string;
  checklist_template_id: string;
  code: string;
  label: string;
  item_type: 'CHECK' | 'BOOLEAN' | 'TEXT' | 'NUMBER' | 'SELECT';
  required: boolean;
  display_order: number;
  status: string;
  uom_id: string | null;
  minimum_value: string | null;
  maximum_value: string | null;
  decimal_precision: number | null;
  value: unknown;
  result: string | null;
  notes: string | null;
};

type EvidenceRequirementRow = {
  id: string;
  target_id: string;
  evidence_type: 'PHOTO' | 'DOCUMENT' | 'SIGNATURE';
  required: boolean;
  minimum_count: number;
  maximum_count: number | null;
  description: string | null;
};

type TaskRow = {
  id: string;
  schedule_definition_id: string | null;
  occurrence_at: Date;
  target_id: string;
  building_id: string | null;
  status: string;
};

const iso = (value: Date | null | undefined): string | null =>
  value instanceof Date ? value.toISOString() : null;

const EXECUTION_ACTIONS = ['START', 'SAVE_RESPONSES', 'COMPLETE', 'CANCEL'] as const;

export function resolveChecklistExecutionActions(status: string): string[] {
  const actions: string[] = [];
  if (status === 'DRAFT') {
    actions.push('START');
  }
  if (status === 'DRAFT' || status === 'IN_PROGRESS') {
    actions.push('SAVE_RESPONSES', 'COMPLETE', 'CANCEL');
  }
  return actions;
}

export async function getMobileChecklistExecution(
  executionId: string,
  userId: string,
): Promise<MobileChecklistExecution> {
  const execution = await getPool().query<ExecutionRow>(
    'SELECT * FROM checklist_executions WHERE id = $1',
    [executionId],
  );
  const executionRow = execution.rows[0];
  if (!executionRow) {
    throw new AppError({
      code: ERROR_CODES.NOT_FOUND,
      message: 'Checklist execution not found.',
      statusCode: 404,
      resource: { type: 'CHECKLIST_EXECUTION', id: executionId },
    });
  }

  const clientIds = await contextAccessService.getAccessibleClientIds(userId);
  if (!clientIds.includes(executionRow.client_id)) {
    throw new AppError({
      code: 'BUILDING_ACCESS_DENIED',
      message: 'Access to the execution is denied.',
      statusCode: 403,
    });
  }

  const template = await getPool().query<TemplateRow>(
    'SELECT * FROM checklist_templates WHERE id = $1',
    [executionRow.checklist_template_id],
  );
  const templateRow = template.rows[0];
  if (!templateRow) {
    throw AppError.notFound('Checklist template not found.');
  }

  const [itemRows, evidenceRows, responseRows, taskRows] = await Promise.all([
    getPool().query<ItemRow>(
      `SELECT i.*, r.value, r.result, r.notes
         FROM checklist_items i
         LEFT JOIN checklist_item_responses r
           ON r.checklist_item_id = i.id
          AND r.checklist_execution_id = $1
        WHERE i.checklist_template_id = $2 AND i.status = 'ACTIVE'
        ORDER BY i.display_order, i.id`,
      [executionRow.id, templateRow.id],
    ),
    getPool().query<EvidenceRequirementRow>(
      `SELECT id, target_id, evidence_type, required, minimum_count, maximum_count, description
         FROM evidence_requirements
        WHERE status = 'ACTIVE'
          AND client_id = $1
          AND (
            (target_type = 'CHECKLIST_TEMPLATE' AND target_id = $2)
            OR (target_type = 'CHECKLIST_ITEM' AND target_id = ANY($3::uuid[]))
          )
        ORDER BY target_type, target_id, evidence_type`,
      [
        executionRow.client_id,
        templateRow.id,
        [],
      ],
    ),
    getPool().query<{ uom_id: string }>(
      `SELECT DISTINCT uom_id FROM checklist_items
        WHERE checklist_template_id = $1 AND uom_id IS NOT NULL`,
      [templateRow.id],
    ),
    // MOB-C04 PART 02A — authoritative task reference: when the execution is
    // bound to a generated task (generated_task_id), resolve that EXACT task.
    // An unbound execution is NOT field work: the `task` projection falls back
    // to a best-effort display of the first template-targeting task only for
    // backward compatibility and is never used as an authorization grant.
    executionRow.generated_task_id
      ? getPool().query<TaskRow>(
          `SELECT id, schedule_definition_id, occurrence_at, target_id, building_id, status
             FROM generated_tasks
            WHERE id = $1`,
          [executionRow.generated_task_id],
        )
      : getPool().query<TaskRow>(
          `SELECT id, schedule_definition_id, occurrence_at, target_id, building_id, status
             FROM generated_tasks
            WHERE target_type = 'CHECKLIST_TEMPLATE'
              AND target_id = $1
            ORDER BY occurrence_at, id
            LIMIT 1`,
          [templateRow.id],
        ),
  ]);

  // Evidence requirements need the item ids; resolve them now.
  const items = itemRows.rows;
  const itemIds = items.map((item) => item.id);
  const evidence = await getPool().query<EvidenceRequirementRow>(
    `SELECT id, target_id, evidence_type, required, minimum_count, maximum_count, description
       FROM evidence_requirements
      WHERE status = 'ACTIVE'
        AND client_id = $1
        AND (
          (target_type = 'CHECKLIST_TEMPLATE' AND target_id = $2)
          OR (target_type = 'CHECKLIST_ITEM' AND target_id = ANY($3::uuid[]))
        )
      ORDER BY target_type, target_id, evidence_type`,
    [executionRow.client_id, templateRow.id, itemIds],
  );

  // UOM records for the item measurements.
  const uomIds = items
    .map((item) => item.uom_id)
    .filter((value): value is string => value !== null);
  const uoms = new Map<string, MobileChecklistUom>();
  if (uomIds.length > 0) {
    const uomRows = await getPool().query<{
      id: string;
      code: string;
      name: string;
      symbol: string;
      category: string;
    }>(
      `SELECT id, code, name, symbol, category FROM units_of_measure WHERE id = ANY($1::uuid[])`,
      [uomIds],
    );
    for (const uom of uomRows.rows) {
      uoms.set(uom.id, {
        id: uom.id,
        code: uom.code,
        name: uom.name,
        symbol: uom.symbol,
        category: uom.category,
      });
    }
  }

  // Template-level requirements are attributed below; item-level ones are
  // attributed in the item loop.
  const checklistItems: MobileChecklistItem[] = items.map((item) => {
    const measurement: MobileChecklistMeasurement | null =
      item.item_type === 'NUMBER' || item.uom_id !== null
        ? {
            uom: item.uom_id ? (uoms.get(item.uom_id) ?? null) : null,
            minimumValue:
              item.minimum_value === null ? null : Number(item.minimum_value),
            maximumValue:
              item.maximum_value === null ? null : Number(item.maximum_value),
            decimalPrecision: item.decimal_precision,
          }
        : null;

    const itemRequirements: MobileChecklistEvidenceRequirement[] = [];
    for (const requirement of evidence.rows) {
      if (
        requirement.target_id === item.id &&
        !itemRequirements.some((entry) => entry.id === requirement.id)
      ) {
        itemRequirements.push({
          id: requirement.id,
          evidenceType: requirement.evidence_type,
          required: requirement.required,
          minimumCount: requirement.minimum_count,
          maximumCount: requirement.maximum_count,
          description: requirement.description,
        });
      }
    }

    return {
      id: item.id,
      code: item.code,
      label: item.label,
      itemType: item.item_type,
      required: item.required,
      displayOrder: item.display_order,
      status: item.status,
      itemStatus: item.value === null || item.value === undefined ? 'PENDING' : 'ANSWERED',
      value:
        item.value === null || item.value === undefined
          ? null
          : (item.value as boolean | number | string),
      result: item.result,
      notes: item.notes,
      measurement,
      evidenceRequirements: itemRequirements,
    };
  });

  // Template-level evidence requirements (deduplicated from the raw rows).
  const templateEvidenceRequirements: MobileChecklistEvidenceRequirement[] = [];
  const seen = new Set<string>();
  for (const requirement of evidence.rows) {
    if (
      requirement.target_id === templateRow.id &&
      !seen.has(requirement.id)
    ) {
      seen.add(requirement.id);
      templateEvidenceRequirements.push({
        id: requirement.id,
        evidenceType: requirement.evidence_type,
        required: requirement.required,
        minimumCount: requirement.minimum_count,
        maximumCount: requirement.maximum_count,
        description: requirement.description,
      });
    }
  }

  const task = taskRows.rows[0] ?? null;
  const taskReference: MobileChecklistTaskReference | null = task
    ? {
        taskId: task.id,
        scheduleDefinitionId: task.schedule_definition_id,
        occurrenceAt: iso(task.occurrence_at) ?? '',
        targetId: task.target_id,
        buildingId: task.building_id,
        taskStatus: task.status,
      }
    : null;

  const templateReference: MobileChecklistTemplateReference = {
    id: templateRow.id,
    clientId: templateRow.client_id,
    code: templateRow.code,
    name: templateRow.name,
    description: templateRow.description,
    status: templateRow.status,
  };

  return {
    id: executionRow.id,
    clientId: executionRow.client_id,
    checklist: templateReference,
    task: taskReference,
    status: executionRow.status,
    startedAt: iso(executionRow.started_at),
    completedAt: iso(executionRow.completed_at),
    createdAt: iso(executionRow.created_at) ?? '',
    updatedAt: iso(executionRow.updated_at) ?? '',
    items: checklistItems,
    evidenceRequirements: templateEvidenceRequirements,
    availableActions: resolveChecklistExecutionActions(executionRow.status),
  };
}

/* -------------------------------------------------------------------------- */
/*  MOB-C04 PART 02 — Online mobile checklist execution lock.                */
/*                                                                             */
/*  The mobile online execution surface (POST/PUT under                       */
/*  /mobile/checklist-executions/:executionId/...) reuses the SAME shared      */
/*  checklist-execution service functions as the generic REST execution        */
/*  endpoints (start / responses / complete / cancel) — lifecycle, scope and   */
/*  terminal-state rules are never re-implemented. On top of that, every       */
/*  mutation is gated by the authoritative current-shift Building authority:   */
/*  a checklist execution may only be executed by a user who is currently on   */
/*  shift at the Building the execution's work belongs to. No client-provided  */
/*  buildingId / shiftId / securityPostId / role / permission / activeShift /  */
/*  workforceProfileId is accepted as authority.                               */
/* -------------------------------------------------------------------------- */

function checklistExecutionNotInCurrentShiftError(): AppError {
  return new AppError({
    code: ERROR_CODES.CHECKLIST_EXECUTION_NOT_IN_CURRENT_SHIFT,
    message:
      'Checklist execution is not currently executable for the caller shift.',
    statusCode: 403,
  });
}

/** A generated task row (authoritative work-instance binding target). */
type BoundTaskRow = {
  id: string;
  client_id: string;
  building_id: string | null;
};

/**
 * MOB-C04 PART 02A — Resolve the authoritative work Building of a bound
 * checklist execution through its `generated_task_id` → `generated_tasks`.
 *
 * Returns the exact generated task the execution is bound to (never a
 * template-first / occurrence guess). `null` when the execution is UNBOUND
 * (no generated_task_id) — an unbound/standalone execution is NOT field work
 * and must never receive a field-work authorization grant from a coincidental
 * template match.
 */
async function resolveBoundTask(
  execution: ChecklistExecutionRow,
): Promise<BoundTaskRow | null> {
  if (!execution.generated_task_id) {
    return null;
  }
  const result = await getPool().query<BoundTaskRow>(
    `SELECT id, client_id, building_id
       FROM generated_tasks
      WHERE id = $1`,
    [execution.generated_task_id],
  );
  const task = result.rows[0] ?? null;
  // Defense in depth: a generated task from a DIFFERENT Client can never be a
  // valid work binding for this execution (would be a forged/cross-Client
  // binding). Treat as not-field-work rather than trusting the row.
  if (task && task.client_id !== execution.client_id) {
    return null;
  }
  return task;
}

/**
 * MOB-C04 PART 02A — Authoritative work-context of a checklist execution for
 * the authenticated user. Returns the EXACT bound generated task + its
 * Building when the execution is authoritatively bound (generated_task_id,
 * same Client); null when the execution is unbound/standalone or not a valid
 * field-work binding. Loads the execution with the existing BE-02G scope (an
 * inaccessible execution throws BUILDING_ACCESS_DENIED). Never a
 * template-first / occurrence guess.
 */
export async function resolveMobileChecklistWorkContext(
  executionId: string,
  userId: string,
): Promise<{ taskId: string; buildingId: string } | null> {
  const execution = await loadChecklistExecutionRow(executionId, userId);
  const task = await resolveBoundTask(execution);
  if (!task || !task.building_id) {
    return null;
  }
  return { taskId: task.id, buildingId: task.building_id };
}

/**
 * MOB-C04 PART 02 / PART 02A — Current-shift + work-authority gate for mobile
 * online execution. Loads the execution with the existing BE-02G
 * accessible-Client scope, then requires ALL of the following (server-derived,
 * never client-supplied):
 *   - the execution is bound to an authoritative generated task
 *     (`generated_task_id`); an unbound/standalone execution fails closed,
 *   - that generated task's Building is a Building the authenticated user is
 *     currently on shift at (authoritative `/mobile/current-shift`),
 *   - the bound generated task is executable by the authenticated user per the
 *     existing task-assignment authority.
 *
 * `now` is injectable only for deterministic tests; the route always uses the
 * real current instant.
 *
 * Rejections (403 CHECKLIST_EXECUTION_NOT_IN_CURRENT_SHIFT — no existence or
 * authority leak):
 *   - inaccessible execution   → existing `BUILDING_ACCESS_DENIED` (scope load).
 *   - unbound / no building / off-shift / not-executable-by-caller.
 */
export async function assertMobileChecklistExecutionCurrentShift(
  executionId: string,
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  const execution = await loadChecklistExecutionRow(executionId, userId);
  const task = await resolveBoundTask(execution);
  if (!task || !task.building_id) {
    throw checklistExecutionNotInCurrentShiftError();
  }
  const current = await resolveCurrentShifts(userId, now);
  const onShift = current.shifts.some((shift) => shift.buildingId === task.building_id);
  if (!onShift) {
    throw checklistExecutionNotInCurrentShiftError();
  }
  const executable = await isBoundTaskExecutableByUser(task.id, userId);
  if (!executable) {
    throw checklistExecutionNotInCurrentShiftError();
  }
}

/** Mobile online execution: start a checklist (DRAFT → IN_PROGRESS). */
export async function executeMobileChecklistStart(
  executionId: string,
  userId: string,
  now: Date = new Date(),
): Promise<ChecklistExecutionRow> {
  await assertMobileChecklistExecutionCurrentShift(executionId, userId, now);
  return startChecklistExecution(executionId, userId);
}

/** Mobile online execution: save checklist item responses. */
export async function executeMobileChecklistResponses(
  executionId: string,
  userId: string,
  body: unknown,
  now: Date = new Date(),
): Promise<Record<string, never>> {
  await assertMobileChecklistExecutionCurrentShift(executionId, userId, now);
  return saveChecklistResponses(executionId, userId, body);
}

/** Mobile online execution: complete or cancel a checklist. */
export async function executeMobileChecklistFinish(
  executionId: string,
  userId: string,
  action: 'complete' | 'cancel',
  now: Date = new Date(),
): Promise<ChecklistExecutionRow> {
  await assertMobileChecklistExecutionCurrentShift(executionId, userId, now);
  return finishChecklistExecution(executionId, userId, action);
}

/* -------------------------------------------------------------------------- */
/*  MOB-C04 PART 02B — Authoritative task → checklist-execution creation.     */
/*                                                                             */
/*  Opens (get-or-create) the bound checklist execution for a generated task   */
/*  the authenticated worker is authorized to execute. Authority is derived    */
/*  entirely server-side from the authenticated session + the generated task   */
/*  — never from a client-supplied template/building/shift/assignment id.      */
/* -------------------------------------------------------------------------- */

/** A generated task row, resolved authoritatively (never client-selected). */
type TaskTargetRow = {
  id: string;
  client_id: string;
  building_id: string | null;
  target_type: string;
  target_id: string;
  status: string;
};

function notAuthorizedForShiftError(): AppError {
  return new AppError({
    code: ERROR_CODES.CHECKLIST_EXECUTION_NOT_IN_CURRENT_SHIFT,
    message:
      'Checklist execution is not currently openable for the caller shift.',
    statusCode: 403,
  });
}

/**
 * Loads a generated task by id and returns it. The caller's authority over the
 * task (accessible scope / assignment / current shift) is validated separately.
 */
async function loadTaskRow(taskId: string): Promise<TaskTargetRow> {
  const result = await getPool().query<TaskTargetRow>(
    'SELECT id, client_id, building_id, target_type, target_id, status FROM generated_tasks WHERE id = $1',
    [taskId],
  );
  const task = result.rows[0];
  if (!task) {
    throw AppError.notFound('Task not found.');
  }
  return task;
}

/**
 * Loads an ACTIVE checklist template by id. Returns null when absent or not
 * ACTIVE (used to reject non-checklist / invalid-template targets without
 * leaking whether a template exists).
 */
async function loadActiveChecklistTemplate(
  templateId: string,
): Promise<{ id: string } | null> {
  const result = await getPool().query<{ id: string; status: string }>(
    'SELECT id, status FROM checklist_templates WHERE id = $1',
    [templateId],
  );
  const template = result.rows[0];
  return template && template.status === 'ACTIVE' ? template : null;
}

/**
 * MOB-C04 PART 02B — Opens (get-or-create) the authoritative checklist
 * execution for a generated task, binding it with `generated_task_id = task.id`.
 *
 * Authority chain (all server-derived, never client-supplied):
 *   1. the task exists,
 *   2. its `target_type` is CHECKLIST_TEMPLATE,
 *   3. `target_id` references an ACTIVE checklist template,
 *   4. the task's Building is inside the caller's BE-02G accessible scope,
 *   5. the task is executable by the caller via the existing WORKFORCE / TEAM
 *      assignment authority,
 *   6. the caller is currently on shift in the task's Building.
 *
 * Get-or-create: if a checklist execution already exists bound to this task it
 * is returned unchanged; otherwise exactly one is created (a partial UNIQUE
 * index on generated_task_id is the concurrency backstop). Creation only
 * establishes the binding; lifecycle (start/responses/complete/cancel) runs
 * through the shared service and the PART 02 shift-locked commands.
 *
 * `now` is injectable for deterministic tests; the route uses the real instant.
 */
export async function openChecklistExecutionForTask(
  taskId: string,
  userId: string,
  now: Date = new Date(),
): Promise<ChecklistExecutionRow> {
  const task = await loadTaskRow(taskId);

  // 2 + 3 — target is an ACTIVE checklist template.
  if (task.target_type !== 'CHECKLIST_TEMPLATE') {
    throw AppError.badRequest('Task is not a checklist task.');
  }
  const template = await loadActiveChecklistTemplate(task.target_id);
  if (!template) {
    throw AppError.badRequest('Checklist template is not active or not found.');
  }

  // 4 — BE-02G accessible Building scope (the task Building must be in the
  // caller's accessible set). A building-less field task cannot be opened.
  if (!task.building_id) {
    throw notAuthorizedForShiftError();
  }
  const buildingIds = await contextAccessService.getAccessibleBuildingIds(userId);
  if (!buildingIds.includes(task.building_id)) {
    throw notAuthorizedForShiftError();
  }

  // 5 — assignment authority (WORKFORCE / TEAM).
  const executable = await isBoundTaskExecutableByUser(task.id, userId);
  if (!executable) {
    throw notAuthorizedForShiftError();
  }

  // 6 — current-shift authority in the task Building.
  const current = await resolveCurrentShifts(userId, now);
  const onShift = current.shifts.some(
    (shift) => shift.buildingId === task.building_id,
  );
  if (!onShift) {
    throw notAuthorizedForShiftError();
  }

  // Get-or-create the bound execution. An existing bound execution is reused
  // exactly as today — its assignment snapshot is NEVER refreshed from the
  // current (possibly reassigned) task assignment.
  const existing = await getPool().query<ChecklistExecutionRow>(
    'SELECT * FROM checklist_executions WHERE generated_task_id = $1',
    [task.id],
  );
  if (existing.rowCount !== null && existing.rowCount > 0) {
    return existing.rows[0];
  }

  // R06 PART 02 — snapshot the authoritative ACTIVE assignment facts that
  // exist at creation time (the same task-assignment authority the gate used).
  // Records WHO/WHAT WAS ASSIGNED at creation — never an actual executor.
  const assignment = await resolveActiveTaskAssignment(task.id);

  try {
    const created = await getPool().query<ChecklistExecutionRow>(
      `INSERT INTO checklist_executions
         (id, client_id, checklist_template_id, generated_task_id, status,
          assignee_type, assigned_workforce_profile_id, assigned_team_id,
          assignment_snapshot_at)
       VALUES ($1, $2, $3, $4, 'DRAFT', $5, $6, $7, NOW())
       RETURNING *`,
      [
        randomUUID(),
        task.client_id,
        template.id,
        task.id,
        assignment?.assigneeType ?? null,
        assignment?.workforceProfileId ?? null,
        assignment?.teamId ?? null,
      ],
    );
    return created.rows[0];
  } catch (error) {
    // Unique-violation backstop (partial unique index on generated_task_id):
    // a concurrent create won the race — return that execution.
    if (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: string }).code === '23505'
    ) {
      const winner = await getPool().query<ChecklistExecutionRow>(
        'SELECT * FROM checklist_executions WHERE generated_task_id = $1',
        [task.id],
      );
      if (winner.rowCount !== null && winner.rowCount > 0) {
        return winner.rows[0];
      }
    }
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/*  MOB-C05 PART 03 — Mobile Finding from authoritative checklist execution.   */
/*                                                                             */
/*  A thin, production-safe field-worker command to report a Finding from an   */
/*  authoritative bound checklist execution. It composes, in order:            */
/*    1. the authoritative source context (PART 01): execution →               */
/*       generated_task_id → generated_tasks → Building/Client (fails closed   */
/*       for unbound / missing / Building-less / cross-Client executions),     */
/*    2. the C04 current-shift + task-assignment + BE-02G authority gate,      */
/*    3. a server-generated Finding number + atomic (single-transaction)        */
/*       Finding insert and CHECKLIST_EXECUTION source binding.                */
/*                                                                             */
/* Nothing here grants user authority by itself and no `finding.manage` or a   */
/* new `finding.report` permission is used — the route permission is only an   */
/* execution-domain gate; the server-side authority chain above is what        */
/* actually authorizes creation. QR / direct-TASK / WORK_ORDER / standalone    */
/* and manual Finding creation remain out of scope for this command.           */
/* -------------------------------------------------------------------------- */

/** Bounded retries on the (astronomically unlikely) Finding-number collision. */
const MOBILE_FINDING_NUMBER_MAX_ATTEMPTS = 3;

function isFindingNumberUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint === 'finding_number_unique'
  );
}

function notAuthoritativeFieldWorkError(): AppError {
  return new AppError({
    code: ERROR_CODES.CHECKLIST_EXECUTION_NOT_IN_CURRENT_SHIFT,
    message:
      'Checklist execution is not an authoritative field-work source for the caller.',
    statusCode: 403,
  });
}

/**
 * MOB-C05 PART 03A — Restore the Finding creation invariants the generic
 * `findingService.createFinding` enforces, so the direct-repository mobile
 * path is not a weaker second creation path:
 *   1. the authoritative source Client exists and is ACTIVE,
 *   2. the authoritative source Building actually belongs to that Client.
 *
 * All inputs are server-derived (`source.clientId` / `source.buildingId` from
 * the PART 01 authoritative resolver); client payload is never consulted. It
 * reuses the SAME error semantics as generic Finding creation (not-found /
 * client-inactive / building-client mismatch), so no mobile-specific error is
 * invented.
 */
async function assertAuthoritativeFindingClientInvariants(
  clientId: string,
  buildingId: string,
): Promise<void> {
  const client = await clientRepository.findById(clientId);
  if (!client) throw clientNotFoundError();
  if (client.status !== 'ACTIVE') throw clientInactiveError();

  // Verify the actual Building→Property→Client relationship (not merely the
  // execution/task client cross-check, which does not prove the Building
  // belongs to the Client).
  const buildingClientId = await resolveBuildingClientId(buildingId);
  if (buildingClientId !== clientId) throw findingBuildingClientMismatchError();
}

/**
 * MOB-C05 PART 03 — Create a Finding from an authoritative bound checklist
 * execution.
 *
 * Authority chain (all server-derived, never client-supplied):
 *   authenticated user
 *   → checklist execution
 *   → exact generated_task_id
 *   → generated task
 *   → authoritative Building/Client (PART 01 resolver, fails closed)
 *   → BE-02G accessible scope
 *   → ACTIVE task assignment (C04 authority)
 *   → current shift in that Building (C04 gate)
 *   → atomic Finding create + CHECKLIST_EXECUTION source binding
 *
 * The Finding number is generated server-side (`FND_<8 uppercase hex>`) and
 * never accepted from the client; collisions are retried on the specific
 * uniqueness conflict with a small bounded cap. A checklist execution may
 * legitimately produce more than one Finding, so repeated calls create new
 * Findings (no source-uniqueness idempotency is imposed).
 *
 * `now` is injectable only for deterministic tests; the route uses the real
 * current instant.
 */
export async function createMobileChecklistFinding(
  executionId: string,
  userId: string,
  input: { title: string; description?: string },
  now: Date = new Date(),
): Promise<MobileChecklistFindingCreated> {
  // 1. Authoritative source context (PART 01) — fails closed for an unbound /
  //    missing-task / Building-less / cross-Client execution. This yields the
  //    exact Building + Client to create the Finding under.
  const source = await resolveAuthoritativeChecklistSourceContext(executionId);
  if (!source) {
    throw notAuthoritativeFieldWorkError();
  }

  // 2. BE-02G + current-shift + ACTIVE task-assignment authority (C04 gate).
  //    Re-throws 403 for an inaccessible / off-shift / unassigned caller and
  //    is authoritative for the work context.
  await assertMobileChecklistExecutionCurrentShift(executionId, userId, now);

  // 2b. Restore generic Finding creation invariant parity: the authoritative
  //     source Client must exist and be ACTIVE, and the authoritative source
  //     Building must belong to that Client. Fails before any mutation.
  await assertAuthoritativeFindingClientInvariants(
    source.clientId,
    source.buildingId,
  );

  // 3. Atomic create + source binding (single transaction), with a bounded
  //    retry that only fires on the exact finding-number uniqueness conflict.
  for (let attempt = 0; attempt < MOBILE_FINDING_NUMBER_MAX_ATTEMPTS; attempt++) {
    const findingNumber = `FND_${randomUUID().slice(0, 8).toUpperCase()}`;
    try {
      const finding = await withTransaction(async (client) => {
        const created = await findingRepository.create(
          {
            clientId: source.clientId,
            buildingId: source.buildingId,
            findingNumber,
            title: input.title,
            description: input.description ?? null,
            reportedByUserId: userId,
          },
          client,
        );
        // Authoritative source binding within the SAME transaction — never a
        // separate autocommit that could leave a Finding without its source.
        await findingRepository.updateSource(
          created.id,
          'CHECKLIST_EXECUTION',
          executionId,
          client,
        );
        return created;
      });

      // Record the Finding-created history event after commit (audit; the
      // finding itself and its source binding are already atomically durable).
      await recordFindingEvent({
        findingId: finding.id,
        clientId: finding.clientId,
        buildingId: finding.buildingId,
        eventType: 'FINDING_CREATED',
        actorUserId: userId,
        summary: 'Finding created from checklist execution',
        metadata: {
          findingNumber: finding.findingNumber,
          sourceType: 'CHECKLIST_EXECUTION',
          sourceId: executionId,
        },
      });

      return {
        findingId: finding.id,
        findingNumber: finding.findingNumber,
        status: finding.status,
        source: { type: 'CHECKLIST_EXECUTION', id: executionId },
      };
    } catch (error) {
      // Retry ONLY the specific finding-number uniqueness conflict. Any other
      // error (validation, DB failure, source constraint, …) propagates
      // immediately — the transaction rolls back so no partial Finding exists.
      if (!isFindingNumberUniqueViolation(error)) {
        throw error;
      }
    }
  }

  // All bounded attempts collided — surface the existing conflict semantics.
  throw findingNumberAlreadyExistsError();
}

export const mobileChecklistService = {
  getMobileChecklistExecution,
  assertMobileChecklistExecutionCurrentShift,
  executeMobileChecklistStart,
  executeMobileChecklistResponses,
  executeMobileChecklistFinish,
  openChecklistExecutionForTask,
  createMobileChecklistFinding,
};
