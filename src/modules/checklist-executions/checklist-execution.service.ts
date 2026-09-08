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
  status: string;
  started_at: Date | null;
  completed_at: Date | null;
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
  return typeof value === 'string';
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
  for (const entry of list as Record<string, unknown>[]) {
    const item = await getPool().query<{
      id: string;
      item_type: string;
    }>(
      'SELECT * FROM checklist_items WHERE id = $1 AND checklist_template_id = $2',
      [entry?.itemId, execution.checklist_template_id],
    );
    if (!item.rowCount) {
      throw AppError.badRequest('Item does not belong to this template.');
    }
    if (!isValidResponseValue(item.rows[0].item_type, entry?.value)) {
      throw AppError.badRequest('Response value does not match item type.');
    }
    await getPool().query(
      `INSERT INTO checklist_item_responses
         (id, checklist_execution_id, checklist_item_id, value, result, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (checklist_execution_id, checklist_item_id)
       DO UPDATE SET value = EXCLUDED.value, result = EXCLUDED.result,
                     notes = EXCLUDED.notes, updated_at = NOW()`,
      [
        randomUUID(),
        execution.id,
        item.rows[0].id,
        JSON.stringify(entry?.value),
        entry?.result ?? null,
        entry?.notes ?? null,
      ],
    );
  }

  return {};
}

export const checklistExecutionService = {
  loadChecklistExecutionRow,
  saveChecklistResponses,
};
