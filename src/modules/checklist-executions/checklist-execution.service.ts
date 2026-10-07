import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import { AppError } from '../../shared/errors';
import { buildingAccessDeniedError, contextAccessService } from '../context-access';

/**
 * BE-07 checklist execution write logic extracted as the single shared
 * service used by BOTH the REST execution endpoints and the BE-25G offline
 * sync batch — the sync contract never re-implements business rules.
 */

export type ChecklistExecutionRow = {
  id: string;
  client_id: string;
  checklist_template_id: string;
  /** MOB-C04 PART 02A — authoritative generated-task binding (nullable). */
  generated_task_id: string | null;
  status: string;
  started_at: Date | null;
  completed_at: Date | null;
  /** R06 PART 01 — durable completion actor (authenticated userId). */
  completed_by_user_id: string | null;
  /** R06 PART 02 — assignment snapshot (assigned at creation; NOT executor). */
  assignee_type: string | null;
  assigned_workforce_profile_id: string | null;
  assigned_team_id: string | null;
  assignment_snapshot_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

function isValidResponseValue(type: string, value: unknown): boolean {
  if (type === 'CHECK' || type === 'BOOLEAN') {
    return typeof value === 'boolean';
  }
  if (type === 'NUMBER') {
    return typeof value === 'number';
  }
  // TEXT and SELECT both accept string values. SELECT membership is enforced
  // atomically in the INSERT below; TEXT values remain free-form.
  return typeof value === 'string';
}

function normalizeOptionCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.toUpperCase();
}

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseIsNa(entry: Record<string, unknown>): boolean {
  // Presence-based contract:
  //   - key ABSENT  → default false (backward compatible for old clients)
  //   - key PRESENT → MUST be a real boolean (true or false). Explicit null,
  //     strings, numbers, objects, arrays are rejected with no coercion.
  if (!Object.prototype.hasOwnProperty.call(entry, 'isNa')) return false;
  const v = entry.isNa;
  if (typeof v !== 'boolean') {
    throw AppError.badRequest('isNa must be a boolean.');
  }
  return v;
}

function parseNaNotes(v: unknown): string | null | 'INVALID' {
  if (v === undefined) return undefined as unknown as string | null; // sentinel: not supplied
  if (v === null) return null;
  if (typeof v !== 'string') return 'INVALID';
  const trimmed = v.trim();
  if (trimmed.length > 2048) return 'INVALID';
  return trimmed || null;
}

function normalizeNaNotesForWrite(
  incoming: unknown,
  existing: string | null | undefined,
  requireNote: boolean,
): string | null {
  // Returns validated na_notes string or null. Throws on policy violation.
  if (incoming === undefined) {
    // Not supplied: preserve existing only if it was previously N/A. Caller
    // decides when to pass existing vs null; here we treat undefined as
    // "preserve provided existing, else null".
    const preserved = existing ?? null;
    if (requireNote && !(preserved && preserved.trim().length > 0)) {
      throw AppError.badRequest('naNotes is required when naRequiresNote is enabled.');
    }
    return preserved;
  }
  if (incoming === null) {
    if (requireNote) {
      throw AppError.badRequest('naNotes is required when naRequiresNote is enabled.');
    }
    return null;
  }
  const parsed = parseNaNotes(incoming);
  if (parsed === 'INVALID') {
    throw AppError.badRequest('naNotes must be a string <= 2048 characters.');
  }
  if (requireNote && !(parsed && parsed.length > 0)) {
    throw AppError.badRequest('naNotes is required when naRequiresNote is enabled.');
  }
  return parsed as string | null;
}

/**
 * Loads a checklist execution and enforces the BE-02G accessible-Client scope
 * (the same authority the execution endpoints use).
 */
export async function loadChecklistExecutionRow(
  executionId: string,
  userId: string,
): Promise<ChecklistExecutionRow> {
  const result = await getPool().query<ChecklistExecutionRow>(
    'SELECT * FROM checklist_executions WHERE id = $1',
    [executionId],
  );
  const row = result.rows[0];
  if (!row) {
    throw AppError.notFound('Checklist execution not found.');
  }
  const clientIds = await contextAccessService.getAccessibleClientIds(userId);
  if (!clientIds.includes(row.client_id)) {
    throw buildingAccessDeniedError();
  }
  return row;
}

/**
 * Saves checklist item responses (single object or array), with the exact
 * validation of the response endpoint: execution must exist and be scoped,
 * terminal executions are rejected, items must belong to the execution's
 * template, and values must match the item type. Returns the same empty
 * payload the endpoint returns.
 *
 * R05-G1B PART 02C adds explicit N/A authority: an entry may carry
 * isNa=true (default false) to mark the response as explicitly N/A; N/A
 * writes SQL NULL to value and result, sets is_na=true, and persists an
 * optional naNotes reason validated against item.na_requires_note.
 *
 * R06 PART 03B adds latest-response-writer authority: every successful
 * per-item mutation (INSERT and ON CONFLICT DO UPDATE, in all three
 * branches) persists `last_responded_by_user_id = userId` in the SAME
 * statement — a failed item never changes the actor, and each successful
 * earlier batch item keeps its own actor.
 */
export async function saveChecklistResponses(
  executionId: string,
  userId: string,
  body: unknown,
): Promise<Record<string, never>> {
  const execution = await loadChecklistExecutionRow(executionId, userId);

  if (execution.status === 'COMPLETED' || execution.status === 'CANCELLED') {
    throw AppError.badRequest('Terminal executions cannot be modified.');
  }

  const list = Array.isArray(body) ? body : [body];
  for (const rawEntry of list as unknown[]) {
    if (!isRec(rawEntry)) {
      throw AppError.badRequest('Response value does not match item type.');
    }
    const entry = rawEntry as Record<string, unknown>;
    const itemId = entry.itemId;
    if (typeof itemId !== 'string' || !itemId) {
      throw AppError.badRequest('Item does not belong to this template.');
    }
    const item = await getPool().query<{
      id: string;
      item_type: string;
      is_na_allowed: boolean;
      na_requires_note: boolean;
    }>(
      `SELECT id, item_type, is_na_allowed, na_requires_note
         FROM checklist_items WHERE id = $1 AND checklist_template_id = $2`,
      [itemId, execution.checklist_template_id],
    );
    if (!item.rowCount) {
      throw AppError.badRequest('Item does not belong to this template.');
    }
    const itemRow = item.rows[0];

    const isNa = parseIsNa(entry);

    if (!isNa) {
      // ===== NORMAL RESPONSE PATH =====
      if (!isValidResponseValue(itemRow.item_type, entry.value)) {
        throw AppError.badRequest('Response value does not match item type.');
      }
      if (entry.result !== undefined && entry.result !== null && typeof entry.result !== 'string') {
        throw AppError.badRequest('result must be a string or null.');
      }
      const naNotes: string | null = null; // normal path always clears na_notes

      if (itemRow.item_type === 'SELECT') {
        const code = normalizeOptionCode(entry.value);
        if (!code) {
          throw AppError.badRequest('Response value does not match item type.');
        }
        const resp = await getPool().query(
          `INSERT INTO checklist_item_responses
             (id, checklist_execution_id, checklist_item_id, value, result, notes, is_na, na_notes, last_responded_by_user_id)
           SELECT $1, $2, $3, $4::jsonb, $5, $6, false, NULL, $8
            WHERE EXISTS (
              SELECT 1 FROM checklist_item_options
               WHERE checklist_item_id = $3
                 AND code = $7
                 AND status = 'ACTIVE'
            )
           ON CONFLICT (checklist_execution_id, checklist_item_id)
           DO UPDATE SET value = EXCLUDED.value, result = EXCLUDED.result,
                         notes = EXCLUDED.notes,
                         is_na = false, na_notes = NULL,
                         last_responded_by_user_id = EXCLUDED.last_responded_by_user_id,
                         updated_at = NOW()
           RETURNING id`,
          [
            randomUUID(),
            execution.id,
            itemRow.id,
            JSON.stringify(code),
            entry.result ?? null,
            entry.notes ?? null,
            code,
            userId,
          ],
        );
        if (!resp.rowCount) {
          throw AppError.badRequest('Selected option is not valid for this item.');
        }
      } else {
        await getPool().query(
          `INSERT INTO checklist_item_responses
             (id, checklist_execution_id, checklist_item_id, value, result, notes, is_na, na_notes, last_responded_by_user_id)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, false, NULL, $7)
           ON CONFLICT (checklist_execution_id, checklist_item_id)
           DO UPDATE SET value = EXCLUDED.value, result = EXCLUDED.result,
                         notes = EXCLUDED.notes,
                         is_na = false, na_notes = NULL,
                         last_responded_by_user_id = EXCLUDED.last_responded_by_user_id,
                         updated_at = NOW()`,
          [
            randomUUID(),
            execution.id,
            itemRow.id,
            JSON.stringify(entry.value),
            entry.result ?? null,
            entry.notes ?? null,
            userId,
          ],
        );
      }
    } else {
      // ===== EXPLICIT N/A RESPONSE PATH =====
      if (!itemRow.is_na_allowed) {
        throw AppError.badRequest('N/A is not allowed for this item.');
      }
      // Value exclusivity: only undefined or null allowed.
      if (entry.value !== undefined && entry.value !== null) {
        throw AppError.badRequest('N/A responses must not include a value.');
      }
      // Result exclusivity: reject non-null result alongside N/A.
      if (entry.result !== undefined && entry.result !== null) {
        throw AppError.badRequest('N/A responses must not include a result.');
      }
      if (entry.notes !== undefined && entry.notes !== null && typeof entry.notes !== 'string') {
        throw AppError.badRequest('notes must be a string or null.');
      }

      // Determine existing na_notes for N/A→N/A preservation.
      let existingNaNotes: string | null = null;
      const prev = await getPool().query<{ is_na: boolean; na_notes: string | null }>(
        `SELECT is_na, na_notes FROM checklist_item_responses
          WHERE checklist_execution_id = $1 AND checklist_item_id = $2`,
        [execution.id, itemRow.id],
      );
      if (prev.rowCount && prev.rows[0].is_na) {
        existingNaNotes = prev.rows[0].na_notes;
      }

      // Parse incoming naNotes.
      let naNotesIncoming: unknown;
      if ('naNotes' in entry) naNotesIncoming = entry.naNotes;
      const naNotes = normalizeNaNotesForWrite(naNotesIncoming, existingNaNotes, itemRow.na_requires_note);

      // Persist N/A: value/result as SQL NULL (NOT jsonb null), is_na=true.
      await getPool().query(
        `INSERT INTO checklist_item_responses
           (id, checklist_execution_id, checklist_item_id, value, result, notes, is_na, na_notes, last_responded_by_user_id)
         VALUES ($1, $2, $3, NULL, NULL, $4, true, $5, $6)
         ON CONFLICT (checklist_execution_id, checklist_item_id)
         DO UPDATE SET value = NULL, result = NULL,
                       notes = EXCLUDED.notes,
                       is_na = true, na_notes = EXCLUDED.na_notes,
                       last_responded_by_user_id = EXCLUDED.last_responded_by_user_id,
                       updated_at = NOW()`,
        [
          randomUUID(),
          execution.id,
          itemRow.id,
          entry.notes ?? null,
          naNotes,
          userId,
        ],
      );
    }
  }

  return {};
}

/**
 * Starts a checklist execution (DRAFT → IN_PROGRESS). Loads the execution with
 * the BE-02G accessible-Client scope and enforces the DRAFT-only lifecycle
 * rule. Returns the updated row.
 */
export async function startChecklistExecution(
  executionId: string,
  userId: string,
): Promise<ChecklistExecutionRow> {
  const execution = await loadChecklistExecutionRow(executionId, userId);
  if (execution.status !== 'DRAFT') {
    throw AppError.badRequest('Only draft executions can start.');
  }
  const updated = await getPool().query<ChecklistExecutionRow>(
    `UPDATE checklist_executions
        SET status = 'IN_PROGRESS', started_at = NOW(), updated_at = NOW()
      WHERE id = $1 RETURNING *`,
    [execution.id],
  );
  return updated.rows[0];
}

/**
 * Finishes a checklist execution (COMPLETE or CANCEL) with the exact rules of
 * the REST completion endpoint: loads the execution with the BE-02G scope,
 * rejects terminal executions, and on COMPLETE rejects when any required item
 * is still unanswered. Returns the updated row.
 *
 * R05-G1B PART 02C (completeness) is UNTOUCHED: the existing LEFT JOIN
 * r.id IS NULL rule treats ANY response row (including explicit N/A) as
 * satisfying required; no SQL change is made.
 *
 * R06 PART 01 (completion actor) — on a successful COMPLETE transition the
 * authenticated `userId` (the same actor used by the existing authorization /
 * scope path) is durably persisted as `completed_by_user_id` together with
 * `completed_at`, representing the same successful completion operation. The
 * actor is never set when validation / scope / transition fails, and CANCEL
 * leaves `completed_by_user_id` untouched (NULL). Terminal executions are
 * rejected up front, so the original completion actor can never be silently
 * overwritten.
 */
export async function finishChecklistExecution(
  executionId: string,
  userId: string,
  action: 'complete' | 'cancel',
): Promise<ChecklistExecutionRow> {
  const target = action === 'complete' ? 'COMPLETED' : 'CANCELLED';
  const execution = await loadChecklistExecutionRow(executionId, userId);
  if (execution.status === 'COMPLETED' || execution.status === 'CANCELLED') {
    throw AppError.badRequest('Execution is already terminal.');
  }
  if (target === 'COMPLETED') {
    const missing = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM checklist_items i
         LEFT JOIN checklist_item_responses r
           ON r.checklist_item_id = i.id
          AND r.checklist_execution_id = $1
        WHERE i.checklist_template_id = $2 AND i.required AND r.id IS NULL`,
      [execution.id, execution.checklist_template_id],
    );
    if (missing.rows[0].n > 0) {
      throw AppError.badRequest('Required checklist items are missing.');
    }
  }
  if (target === 'COMPLETED') {
    const updated = await getPool().query<ChecklistExecutionRow>(
      `UPDATE checklist_executions
          SET status = $1,
              completed_at = NOW(),
              completed_by_user_id = $2,
              updated_at = NOW()
        WHERE id = $3
        RETURNING *`,
      [target, userId, execution.id],
    );
    return updated.rows[0];
  }
  const updated = await getPool().query<ChecklistExecutionRow>(
    `UPDATE checklist_executions
        SET status = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING *`,
    [target, execution.id],
  );
  return updated.rows[0];
}

/**
 * Authoritative field-work source context of a checklist execution (MOB-C05
 * PART 01). SOURCE CONTEXT ONLY — it grants no user authorization and requires
 * no current-shift / caller scope; a caller decides user authority separately.
 *
 * Resolves the exact authoritative chain:
 *   checklist_execution → generated_task_id → generated_tasks → building_id
 * and returns the execution's Client consistently (never a checklist-template /
 * occurrence / first-matching-task / title coincidence guess, and never a
 * client-supplied Building).
 *
 * Returns null (fail closed) when the execution cannot be resolved to an
 * authoritative field-work source:
 *   - execution does not exist,
 *   - execution is UNBOUND (`generated_task_id IS NULL` — a standalone/admin or
 *     domain-bound execution is not authoritative mobile field work),
 *   - the bound generated task is missing,
 *   - the bound generated task has no Building,
 *   - the bound generated task belongs to a different Client than the execution
 *     (forged / cross-Client binding).
 *
 * Historical/standalone bindings are never backfilled or guessed.
 */
export type AuthoritativeChecklistSourceContext = {
  /** `checklist_executions.id`. */
  sourceId: string;
  clientId: string;
  checklistTemplateId: string;
  status: string;
  /** `generated_tasks.id` the execution is exactly bound to. */
  taskId: string;
  /** `generated_tasks.building_id` — the authoritative Building. */
  buildingId: string;
};

export async function resolveAuthoritativeChecklistSourceContext(
  sourceId: string,
): Promise<AuthoritativeChecklistSourceContext | null> {
  const executionResult = await getPool().query<{
    id: string;
    client_id: string;
    checklist_template_id: string;
    generated_task_id: string | null;
    status: string;
  }>(
    `SELECT id, client_id, checklist_template_id, generated_task_id, status
       FROM checklist_executions
      WHERE id = $1`,
    [sourceId],
  );
  const execution = executionResult.rows[0];
  if (!execution) return null;
  // Unbound execution is not authoritative field work.
  if (!execution.generated_task_id) return null;

  const taskResult = await getPool().query<{
    id: string;
    client_id: string;
    building_id: string | null;
  }>(
    `SELECT id, client_id, building_id
       FROM generated_tasks
      WHERE id = $1`,
    [execution.generated_task_id],
  );
  const task = taskResult.rows[0];
  if (!task) return null; // Bound task missing → fail closed.
  if (!task.building_id) return null; // Bound task without Building → fail closed.
  // Cross-Client execution/task mismatch → fail closed (would be a forged binding).
  if (task.client_id !== execution.client_id) return null;

  return {
    sourceId: execution.id,
    clientId: execution.client_id,
    checklistTemplateId: execution.checklist_template_id,
    status: execution.status,
    taskId: task.id,
    buildingId: task.building_id,
  };
}

export const checklistExecutionService = {
  loadChecklistExecutionRow,
  resolveAuthoritativeChecklistSourceContext,
  saveChecklistResponses,
  startChecklistExecution,
  finishChecklistExecution,
};
