import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import { AppError } from '../../shared/errors';
import { buildingAccessDeniedError, contextAccessService } from '../context-access';

/**
 * BE-07 form instance write logic extracted as the single shared service.
 *
 * MOB-C07 PART 01A — zero behavior change versus the previous inline route
 * handlers. Later mobile composition calls these functions after its own
 * authority chain; this service does not add task / assignment / shift /
 * Building / template-ACTIVE / version-selection rules.
 */

export type FormInstanceRow = {
  id: string;
  client_id: string;
  form_template_version_id: string;
  status: string;
  started_at: Date | null;
  completed_at: Date | null;
  /** R06 PART 04A — durable completion actor (authenticated userId). */
  completed_by_user_id?: string | null;
  /** R06 PART 04A — assignment snapshot captured at task-bound creation. */
  assignee_type?: string | null;
  assigned_workforce_profile_id?: string | null;
  assigned_team_id?: string | null;
  assignment_snapshot_at?: Date | null;
  created_at: Date;
  updated_at: Date;
  generated_task_id?: string | null;
  meter_reading_binding_id?: string | null;
  log_sheet_binding_id?: string | null;
};

/**
 * R06 PART 04A — resolved ACTIVE assignment facts handed to the task-bound
 * create command. These are ASSIGNMENT facts only — never an actual executor.
 */
export type AssignmentSnapshotInput = {
  assigneeType: 'WORKFORCE' | 'TEAM';
  workforceProfileId: string | null;
  teamId: string | null;
} | null;

function isValidResponseValue(type: string, value: unknown): boolean {
  if (value === null) return true;
  if (type === 'BOOLEAN' && typeof value !== 'boolean') return false;
  if (type === 'NUMBER' && typeof value !== 'number') return false;
  if (
    ['TEXT', 'TEXTAREA', 'DATE', 'DATETIME', 'SELECT'].includes(type) &&
    typeof value !== 'string'
  ) {
    return false;
  }
  return true;
}

/**
 * Loads a published form template version together with its owning Client.
 * Unpublished versions cannot create instances (existing generic rule).
 */
async function loadPublishedTemplateVersion(versionId: string): Promise<{
  id: string;
  client_id: string;
  status: string;
}> {
  const result = await getPool().query<{
    id: string;
    client_id: string;
    status: string;
  }>(
    `SELECT v.id, t.client_id, v.status
       FROM form_template_versions v
       JOIN form_templates t ON t.id = v.form_template_id
      WHERE v.id = $1`,
    [versionId],
  );
  const row = result.rows[0];
  if (!row) {
    throw AppError.notFound('Template version not found.');
  }
  if (row.status !== 'PUBLISHED') {
    throw AppError.badRequest('Only published template versions can create instances.');
  }
  return row;
}

/**
 * MOB-C07 PART 05 — Derive the authoritative Building of a task-bound Form
 * Instance from `generated_task_id`. Unbound generic/admin instances
 * (`generated_task_id` IS NULL) return null so existing Client-scoped
 * evidence/review behavior is preserved.
 *
 * Bound instances fail closed when the generated task is missing, is not
 * FORM_VERSION, the pinned version/client does not match, the parent
 * template Client does not match, or the task has no Building. Callers
 * still enforce BE-02G Building access on the returned id. Does not
 * require current shift, assignment, or form_instance.execute.
 */
export async function resolveBoundFormInstanceBuilding(
  instance: {
    client_id: string;
    form_template_version_id: string;
    generated_task_id?: string | null;
  },
): Promise<string | null> {
  if (!instance.generated_task_id) {
    return null;
  }

  const task = await getPool().query<{
    id: string;
    client_id: string;
    building_id: string | null;
    target_type: string;
    target_id: string;
  }>(
    `SELECT id, client_id, building_id, target_type, target_id
       FROM generated_tasks
      WHERE id = $1`,
    [instance.generated_task_id],
  );
  const row = task.rows[0];
  if (!row) {
    throw AppError.badRequest(
      'Bound form instance is inconsistent with the task.',
    );
  }
  if (row.target_type !== 'FORM_VERSION') {
    throw AppError.badRequest('Task is not a form-version task.');
  }
  if (
    row.target_id !== instance.form_template_version_id ||
    row.client_id !== instance.client_id
  ) {
    throw AppError.badRequest(
      'Bound form instance is inconsistent with the task.',
    );
  }

  const template = await getPool().query<{ client_id: string }>(
    `SELECT t.client_id
       FROM form_template_versions v
       JOIN form_templates t ON t.id = v.form_template_id
      WHERE v.id = $1`,
    [instance.form_template_version_id],
  );
  if (!template.rows[0] || template.rows[0].client_id !== instance.client_id) {
    throw AppError.badRequest(
      'Bound form instance is inconsistent with the task.',
    );
  }
  if (!row.building_id) {
    throw AppError.badRequest(
      'Bound form instance is inconsistent with the task.',
    );
  }
  return row.building_id;
}

/**
 * Loads a form instance and enforces the BE-02G accessible-Client scope
 * (the same authority the generic execution endpoints use).
 */
export async function loadFormInstanceRow(
  instanceId: string,
  userId: string,
): Promise<FormInstanceRow> {
  const result = await getPool().query<FormInstanceRow>(
    'SELECT * FROM form_instances WHERE id = $1',
    [instanceId],
  );
  const row = result.rows[0];
  if (!row) {
    throw AppError.notFound('Form instance not found.');
  }
  const clientIds = await contextAccessService.getAccessibleClientIds(userId);
  if (!clientIds.includes(row.client_id)) {
    throw buildingAccessDeniedError();
  }
  return row;
}

/**
 * Creates a DRAFT form instance from a published template version.
 * Client scope is the version's owning Client (existing generic rule).
 */
export async function createFormInstance(
  versionId: string,
  userId: string,
): Promise<FormInstanceRow> {
  const version = await loadPublishedTemplateVersion(versionId);
  const clientIds = await contextAccessService.getAccessibleClientIds(userId);
  if (!clientIds.includes(version.client_id)) {
    throw buildingAccessDeniedError();
  }
  const created = await getPool().query<FormInstanceRow>(
    `INSERT INTO form_instances (id, client_id, form_template_version_id)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [randomUUID(), version.client_id, version.id],
  );
  return created.rows[0];
}

/**
 * Creates a DRAFT form instance bound to a generated task.
 *
 * Reuses the generic published-version + BE-02G Client-scope rules of
 * `createFormInstance`. `generated_task_id` is set server-side; callers must
 * already have established task authority. Unique-violation on the partial
 * generated-task index is thrown to the caller for get-or-create handling.
 *
 * R06 PART 04A — when `assignment` is present the authoritative ACTIVE
 * assignment facts are snapshotted onto the new instance in the SAME INSERT
 * (who/what was assigned at creation — never an executor). `null` leaves all
 * four snapshot fields NULL (unassigned creation).
 */
export async function createTaskBoundFormInstance(
  versionId: string,
  userId: string,
  generatedTaskId: string,
  assignment: AssignmentSnapshotInput,
): Promise<FormInstanceRow> {
  const version = await loadPublishedTemplateVersion(versionId);
  const clientIds = await contextAccessService.getAccessibleClientIds(userId);
  if (!clientIds.includes(version.client_id)) {
    throw buildingAccessDeniedError();
  }
  const created = await getPool().query<FormInstanceRow>(
    `INSERT INTO form_instances
       (id, client_id, form_template_version_id, generated_task_id,
        assignee_type, assigned_workforce_profile_id, assigned_team_id,
        assignment_snapshot_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      randomUUID(),
      version.client_id,
      version.id,
      generatedTaskId,
      assignment?.assigneeType ?? null,
      assignment?.workforceProfileId ?? null,
      assignment?.teamId ?? null,
      assignment ? new Date() : null,
    ],
  );
  return created.rows[0];
}

/**
 * Starts a form instance (DRAFT → IN_PROGRESS).
 */
export async function startFormInstance(
  instanceId: string,
  userId: string,
): Promise<FormInstanceRow> {
  const instance = await loadFormInstanceRow(instanceId, userId);
  if (instance.status !== 'DRAFT') {
    throw AppError.badRequest('Only draft instances can be started.');
  }
  const updated = await getPool().query<FormInstanceRow>(
    `UPDATE form_instances
        SET status = 'IN_PROGRESS', started_at = NOW(), updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [instance.id],
  );
  return updated.rows[0];
}

/**
 * Saves form field responses (single object or array) with the exact
 * validation of the generic PUT endpoint: instance must exist and be scoped,
 * terminal instances are rejected, fields must belong to the instance version,
 * values must match the field type, and upsert uses the existing unique
 * (instance, field, coalesced occurrence) index. Returns the same empty
 * payload the endpoint returns.
 *
 * R06 PART 04B — every successful per-item mutation persists
 * `last_responded_by_user_id = userId` in the SAME INSERT ... ON CONFLICT
 * statement (latest response writer). A failed item never changes the actor,
 * and each successful earlier batch item keeps its own actor.
 */
export async function saveFormResponses(
  instanceId: string,
  userId: string,
  body: unknown,
): Promise<Record<string, never>> {
  const instance = await loadFormInstanceRow(instanceId, userId);
  if (instance.status === 'COMPLETED' || instance.status === 'CANCELLED') {
    throw AppError.badRequest('Terminal instances cannot be modified.');
  }

  const items = Array.isArray(body) ? body : [body ?? {}];
  for (const entry of items as Record<string, unknown>[]) {
    const field = await getPool().query<{ id: string; field_type: string }>(
      `SELECT *
         FROM form_template_version_fields
        WHERE id = $1
          AND version_section_id IN (
            SELECT id FROM form_template_version_sections WHERE version_id = $2
          )`,
      [entry.fieldId, instance.form_template_version_id],
    );
    if (!field.rowCount) {
      throw AppError.badRequest('Response field does not belong to this version.');
    }
    if (!isValidResponseValue(field.rows[0].field_type, entry.value)) {
      throw AppError.badRequest('Response value does not match field type.');
    }
    await getPool().query(
      `INSERT INTO form_responses
         (id, form_instance_id, version_field_id, value, last_responded_by_user_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (
         form_instance_id,
         version_field_id,
         (COALESCE(occurrence_id, '00000000-0000-0000-0000-000000000000'))
       )
       DO UPDATE SET value = EXCLUDED.value,
                     last_responded_by_user_id = EXCLUDED.last_responded_by_user_id,
                     updated_at = NOW()`,
      [randomUUID(), instance.id, field.rows[0].id, JSON.stringify(entry.value), userId],
    );
  }

  return {};
}

/**
 * Completes or cancels a form instance with the exact rules of the generic
 * REST finish endpoints. COMPLETE from DRAFT remains allowed when required
 * fields are present. Returns the updated row.
 *
 * R06 PART 04A — a successful COMPLETE transition records the authenticated
 * completion actor (`completed_by_user_id`) in the SAME UPDATE. CANCEL does
 * not write an actor. A later caller cannot overwrite the original actor
 * (the terminal guard rejects repeated completion).
 */
export async function finishFormInstance(
  instanceId: string,
  userId: string,
  action: 'complete' | 'cancel',
): Promise<FormInstanceRow> {
  const target = action === 'complete' ? 'COMPLETED' : 'CANCELLED';
  const instance = await loadFormInstanceRow(instanceId, userId);
  if (instance.status === 'COMPLETED' || instance.status === 'CANCELLED') {
    throw AppError.badRequest('Instance is already terminal.');
  }
  if (target === 'COMPLETED') {
    const missing = await getPool().query<{ n: number }>(
      `SELECT count(*)::int n
         FROM form_template_version_fields f
         JOIN form_template_version_sections s ON s.id = f.version_section_id
         LEFT JOIN form_responses r
           ON r.version_field_id = f.id AND r.form_instance_id = $1
        WHERE s.version_id = $2 AND f.required AND r.id IS NULL`,
      [instance.id, instance.form_template_version_id],
    );
    if (missing.rows[0].n) {
      throw AppError.badRequest('Required fields are missing.');
    }
  }
  if (target === 'COMPLETED') {
    const updated = await getPool().query<FormInstanceRow>(
      `UPDATE form_instances
          SET status = $1,
              completed_at = NOW(),
              completed_by_user_id = $2,
              updated_at = NOW()
        WHERE id = $3
        RETURNING *`,
      [target, userId, instance.id],
    );
    return updated.rows[0];
  }
  const updated = await getPool().query<FormInstanceRow>(
    `UPDATE form_instances
        SET status = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING *`,
    [target, instance.id],
  );
  return updated.rows[0];
}

export const formInstanceService = {
  loadFormInstanceRow,
  resolveBoundFormInstanceBuilding,
  createFormInstance,
  createTaskBoundFormInstance,
  startFormInstance,
  saveFormResponses,
  finishFormInstance,
};
