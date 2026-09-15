import { getPool } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { contextAccessService } from '../context-access';
import {
  createTaskBoundFormInstance,
  finishFormInstance,
  saveFormResponses,
  startFormInstance,
  type FormInstanceRow,
} from '../form-instances';
import { resolveCurrentShifts } from '../mobile-current-shift';
import {
  isBoundTaskExecutableByUser,
  resolveActiveTaskAssignment,
} from '../mobile-task-authority';
import { resolveBuildingClientId } from '../shifts';

/**
 * MOB-C07 PART 02 / PART 03 — Authoritative task-bound Form Instance open
 * and execution (start + save responses).
 *
 * Authority is derived entirely server-side from the authenticated session +
 * the generated task / bound instance — never from a client-supplied
 * clientId / buildingId / generatedTaskId / formTemplateVersionId. Mobile
 * does not own form business rules: it re-checks authority on every
 * mutation, then calls the shared PART 01A lifecycle.
 *
 * Open only establishes the binding as DRAFT. Start / save / complete /
 * cancel never mutate the generated task.
 */

const EXECUTABLE_TASK_STATUSES = new Set(['OPEN', 'ASSIGNED', 'IN_PROGRESS']);

type ShiftGateKind = 'open' | 'execute';

type TaskTargetRow = {
  id: string;
  client_id: string;
  building_id: string | null;
  target_type: string;
  target_id: string;
  status: string;
};

type VersionAuthorityRow = {
  id: string;
  version_status: string;
  template_id: string;
  client_id: string;
  template_status: string;
};

function notAuthorizedForShiftError(kind: ShiftGateKind): AppError {
  return new AppError({
    code: ERROR_CODES.CHECKLIST_EXECUTION_NOT_IN_CURRENT_SHIFT,
    message:
      kind === 'execute'
        ? 'Form instance is not currently executable for the caller shift.'
        : 'Form instance is not currently openable for the caller shift.',
    statusCode: 403,
  });
}

function isGeneratedTaskUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint === 'form_instances_generated_task_unique'
  );
}

async function loadTaskRow(taskId: string): Promise<TaskTargetRow> {
  const result = await getPool().query<TaskTargetRow>(
    `SELECT id, client_id, building_id, target_type, target_id, status
       FROM generated_tasks
      WHERE id = $1`,
    [taskId],
  );
  const task = result.rows[0];
  if (!task) {
    throw AppError.notFound('Task not found.');
  }
  return task;
}

async function loadVersionAuthority(
  versionId: string,
): Promise<VersionAuthorityRow | null> {
  const result = await getPool().query<VersionAuthorityRow>(
    `SELECT v.id,
            v.status AS version_status,
            t.id AS template_id,
            t.client_id,
            t.status AS template_status
       FROM form_template_versions v
       JOIN form_templates t ON t.id = v.form_template_id
      WHERE v.id = $1`,
    [versionId],
  );
  return result.rows[0] ?? null;
}

function assertBoundInstanceConsistent(
  row: FormInstanceRow,
  task: TaskTargetRow,
): void {
  if (
    row.generated_task_id !== task.id ||
    row.form_template_version_id !== task.target_id ||
    row.client_id !== task.client_id
  ) {
    throw AppError.badRequest(
      'Bound form instance is inconsistent with the task.',
    );
  }
}

/**
 * Shared FORM_VERSION task authority used by both the PART 02 opener and
 * PART 03 mutations: exact PUBLISHED version, ACTIVE parent template,
 * client match, BE-02G Building, C04 assignment, current shift, and
 * non-terminal task status.
 */
async function assertFormVersionTaskAuthority(
  task: TaskTargetRow,
  userId: string,
  now: Date,
  kind: ShiftGateKind,
): Promise<void> {
  if (task.target_type !== 'FORM_VERSION') {
    throw AppError.badRequest('Task is not a form-version task.');
  }

  if (!EXECUTABLE_TASK_STATUSES.has(task.status)) {
    throw AppError.badRequest('Task is already terminal.');
  }

  const version = await loadVersionAuthority(task.target_id);
  if (!version) {
    throw AppError.badRequest('Form template version not found.');
  }
  if (version.version_status !== 'PUBLISHED') {
    throw AppError.badRequest(
      'Only published template versions can create instances.',
    );
  }
  if (version.template_status !== 'ACTIVE') {
    throw AppError.badRequest('Form template is not active.');
  }
  if (version.client_id !== task.client_id) {
    throw AppError.badRequest(
      'Task client does not match the form template client.',
    );
  }

  if (!task.building_id) {
    throw notAuthorizedForShiftError(kind);
  }
  const buildingIds = await contextAccessService.getAccessibleBuildingIds(userId);
  if (!buildingIds.includes(task.building_id)) {
    throw notAuthorizedForShiftError(kind);
  }
  const buildingClientId = await resolveBuildingClientId(task.building_id);
  if (buildingClientId !== task.client_id) {
    throw AppError.badRequest(
      'Task building does not belong to the task client.',
    );
  }

  const executable = await isBoundTaskExecutableByUser(task.id, userId);
  if (!executable) {
    throw notAuthorizedForShiftError(kind);
  }

  const current = await resolveCurrentShifts(userId, now);
  const onShift = current.shifts.some(
    (shift) => shift.buildingId === task.building_id,
  );
  if (!onShift) {
    throw notAuthorizedForShiftError(kind);
  }
}

/**
 * Resolves a Form Instance the caller is authorized to execute: the instance
 * must exist, must be bound (`generated_task_id` NOT NULL — unbound generic
 * instances stay on generic routes), must be consistent with the exact
 * FORM_VERSION task, and must pass the shared task authority chain.
 */
export async function assertMobileBoundFormInstanceAuthority(
  instanceId: string,
  userId: string,
  now: Date = new Date(),
): Promise<FormInstanceRow> {
  const result = await getPool().query<FormInstanceRow>(
    'SELECT * FROM form_instances WHERE id = $1',
    [instanceId],
  );
  const instance = result.rows[0];
  if (!instance) {
    throw AppError.notFound('Form instance not found.');
  }
  if (!instance.generated_task_id) {
    throw notAuthorizedForShiftError('execute');
  }

  const task = await loadTaskRow(instance.generated_task_id);
  if (task.target_type !== 'FORM_VERSION') {
    throw AppError.badRequest('Task is not a form-version task.');
  }
  assertBoundInstanceConsistent(instance, task);
  await assertFormVersionTaskAuthority(task, userId, now, 'execute');
  return instance;
}

/**
 * Opens (get-or-create) the authoritative Form Instance for a generated
 * FORM_VERSION task, binding it with `generated_task_id = task.id`.
 *
 * `now` is injectable for deterministic tests; the route uses the real instant.
 */
export async function openFormInstanceForTask(
  taskId: string,
  userId: string,
  now: Date = new Date(),
): Promise<FormInstanceRow> {
  const task = await loadTaskRow(taskId);
  await assertFormVersionTaskAuthority(task, userId, now, 'open');

  const existing = await getPool().query<FormInstanceRow>(
    'SELECT * FROM form_instances WHERE generated_task_id = $1',
    [task.id],
  );
  if (existing.rowCount !== null && existing.rowCount > 0) {
    const row = existing.rows[0];
    assertBoundInstanceConsistent(row, task);
    return row;
  }

  // R06 PART 04A — snapshot the authoritative ACTIVE assignment facts that
  // exist at creation time (the same task-assignment authority the gate used).
  // Records WHO/WHAT WAS ASSIGNED at creation — never an actual executor. An
  // existing bound instance is reused unchanged above, so reassignment never
  // refreshes a prior snapshot.
  const assignment = await resolveActiveTaskAssignment(task.id);

  try {
    return await createTaskBoundFormInstance(
      task.target_id,
      userId,
      task.id,
      assignment,
    );
  } catch (error) {
    if (!isGeneratedTaskUniqueViolation(error)) {
      throw error;
    }
    const winner = await getPool().query<FormInstanceRow>(
      'SELECT * FROM form_instances WHERE generated_task_id = $1',
      [task.id],
    );
    if (winner.rowCount !== null && winner.rowCount > 0) {
      const row = winner.rows[0];
      assertBoundInstanceConsistent(row, task);
      return row;
    }
    throw error;
  }
}

/**
 * Starts a task-bound Form Instance (DRAFT → IN_PROGRESS) after re-checking
 * bound-instance authority. Delegates lifecycle to PART 01A.
 */
export async function startMobileFormInstance(
  instanceId: string,
  userId: string,
  now: Date = new Date(),
): Promise<FormInstanceRow> {
  await assertMobileBoundFormInstanceAuthority(instanceId, userId, now);
  return startFormInstance(instanceId, userId);
}

/**
 * Saves responses on a task-bound Form Instance after re-checking
 * bound-instance authority. Delegates validation / upsert to PART 01A
 * (pinned-version fields, types, occurrence unique index, terminal guard).
 */
export async function saveMobileFormResponses(
  instanceId: string,
  userId: string,
  body: unknown,
  now: Date = new Date(),
): Promise<Record<string, never>> {
  await assertMobileBoundFormInstanceAuthority(instanceId, userId, now);
  return saveFormResponses(instanceId, userId, body);
}

/**
 * Completes or cancels a task-bound Form Instance after re-checking
 * bound-instance authority. Delegates lifecycle (required-field completeness,
 * DRAFT complete, terminal guards, timestamps) to PART 01A
 * `finishFormInstance`. Does not mutate the generated task.
 */
export async function finishMobileFormInstance(
  instanceId: string,
  userId: string,
  action: 'complete' | 'cancel',
  now: Date = new Date(),
): Promise<FormInstanceRow> {
  await assertMobileBoundFormInstanceAuthority(instanceId, userId, now);
  return finishFormInstance(instanceId, userId, action);
}

export const mobileFormInstanceService = {
  openFormInstanceForTask,
  assertMobileBoundFormInstanceAuthority,
  startMobileFormInstance,
  saveMobileFormResponses,
  finishMobileFormInstance,
};
