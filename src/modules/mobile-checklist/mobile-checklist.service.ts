import { getPool } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { contextAccessService } from '../context-access';
import type {
  MobileChecklistEvidenceRequirement,
  MobileChecklistExecution,
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
  item_type: 'CHECK' | 'BOOLEAN' | 'TEXT' | 'NUMBER';
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
    getPool().query<TaskRow>(
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

export const mobileChecklistService = { getMobileChecklistExecution };
