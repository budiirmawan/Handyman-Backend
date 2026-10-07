import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  CreatePatrolChecklistBindingInput,
  PatrolChecklistBindingFilter,
  PatrolChecklistBindingRecord,
  PatrolChecklistBindingStatus,
  PublicPatrolChecklistExecution,
  UpdatePatrolChecklistBindingInput,
} from './patrol-checklist-binding.types';

type PatrolChecklistBindingRow = {
  id: string;
  client_id: string;
  building_id: string;
  patrol_route_id: string;
  start_security_post_id: string | null;
  checklist_template_id: string;
  status: PatrolChecklistBindingStatus;
  created_by_user_id: string;
  created_at: Date;
  updated_at: Date;
};

export type ChecklistTemplateRow = {
  id: string;
  client_id: string;
  code: string;
  name: string;
  status: string;
};

export type PatrolRouteRow = {
  id: string;
  client_id: string;
  building_id: string;
  code: string;
  name: string;
  status: string;
};

export type SecurityPostRow = {
  id: string;
  building_id: string;
  code: string;
  name: string;
  status: string;
};

export type ExecutionRow = {
  id: string;
  client_id: string;
  checklist_template_id: string;
  patrol_checklist_binding_id: string | null;
  status: string;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type ExecutionContextRow = {
  execution_id: string;
  execution_template_id: string;
  execution_status: string;
  execution_started_at: Date | null;
  execution_completed_at: Date | null;
  execution_created_at: Date;
  execution_updated_at: Date;
  patrol_checklist_binding_id: string | null;
  building_id: string | null;
  building_code: string | null;
  building_name: string | null;
  template_id: string | null;
  template_code: string | null;
  template_name: string | null;
  template_status: string | null;
  patrol_route_id: string | null;
  patrol_route_code: string | null;
  patrol_route_name: string | null;
  patrol_route_status: string | null;
  start_security_post_id: string | null;
  start_security_post_code: string | null;
  start_security_post_name: string | null;
};

function mapRow(row: PatrolChecklistBindingRow): PatrolChecklistBindingRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    patrolRouteId: row.patrol_route_id,
    startSecurityPostId: row.start_security_post_id,
    checklistTemplateId: row.checklist_template_id,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function create(
  input: {
    clientId: string;
    buildingId: string;
    patrolRouteId: string;
    startSecurityPostId: string | null;
    checklistTemplateId: string;
    status: PatrolChecklistBindingStatus;
    createdByUserId: string;
  },
): Promise<PatrolChecklistBindingRecord> {
  const result = await getPool().query<PatrolChecklistBindingRow>(
    `INSERT INTO patrol_checklist_bindings
       (id, client_id, building_id, patrol_route_id, start_security_post_id,
        checklist_template_id, status, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, client_id, building_id, patrol_route_id,
               start_security_post_id, checklist_template_id, status,
               created_by_user_id, created_at, updated_at`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.patrolRouteId,
      input.startSecurityPostId,
      input.checklistTemplateId,
      input.status,
      input.createdByUserId,
    ],
  );
  return mapRow(result.rows[0]);
}

export async function findById(
  id: string,
): Promise<PatrolChecklistBindingRecord | null> {
  const result = await getPool().query<PatrolChecklistBindingRow>(
    `SELECT id, client_id, building_id, patrol_route_id,
            start_security_post_id, checklist_template_id, status,
            created_by_user_id, created_at, updated_at
     FROM patrol_checklist_bindings WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function list(
  filter: PatrolChecklistBindingFilter = {},
): Promise<PatrolChecklistBindingRecord[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filter.buildingId) {
    values.push(filter.buildingId);
    conditions.push(`building_id = $${values.length}`);
  }
  if (filter.patrolRouteId) {
    values.push(filter.patrolRouteId);
    conditions.push(`patrol_route_id = $${values.length}`);
  }
  if (filter.checklistTemplateId) {
    values.push(filter.checklistTemplateId);
    conditions.push(`checklist_template_id = $${values.length}`);
  }
  if (filter.status) {
    values.push(filter.status);
    conditions.push(`status = $${values.length}`);
  }

  const result = await getPool().query<PatrolChecklistBindingRow>(
    `SELECT id, client_id, building_id, patrol_route_id,
            start_security_post_id, checklist_template_id, status,
            created_by_user_id, created_at, updated_at
     FROM patrol_checklist_bindings
     ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
     ORDER BY created_at DESC`,
    values,
  );
  return result.rows.map(mapRow);
}

export async function listByBuildingIds(
  buildingIds: string[],
  filter: PatrolChecklistBindingFilter = {},
): Promise<PatrolChecklistBindingRecord[]> {
  if (buildingIds.length === 0) {
    return [];
  }
  const conditions = [`building_id = ANY($1::uuid[])`];
  const values: unknown[] = [buildingIds];

  if (filter.status) {
    values.push(filter.status);
    conditions.push(`status = $${values.length}`);
  }
  if (filter.patrolRouteId) {
    values.push(filter.patrolRouteId);
    conditions.push(`patrol_route_id = $${values.length}`);
  }
  if (filter.checklistTemplateId) {
    values.push(filter.checklistTemplateId);
    conditions.push(`checklist_template_id = $${values.length}`);
  }

  const result = await getPool().query<PatrolChecklistBindingRow>(
    `SELECT id, client_id, building_id, patrol_route_id,
            start_security_post_id, checklist_template_id, status,
            created_by_user_id, created_at, updated_at
     FROM patrol_checklist_bindings
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC`,
    values,
  );
  return result.rows.map(mapRow);
}

export async function update(
  id: string,
  input: UpdatePatrolChecklistBindingInput,
): Promise<PatrolChecklistBindingRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.startSecurityPostId !== undefined) {
    values.push(input.startSecurityPostId);
    sets.push(`start_security_post_id = $${values.length}`);
  }
  if (input.status !== undefined) {
    values.push(input.status);
    sets.push(`status = $${values.length}`);
  }

  if (sets.length === 0) {
    return findById(id);
  }

  values.push(id);
  const result = await getPool().query<PatrolChecklistBindingRow>(
    `UPDATE patrol_checklist_bindings
     SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $${values.length}
     RETURNING id, client_id, building_id, patrol_route_id,
               start_security_post_id, checklist_template_id, status,
               created_by_user_id, created_at, updated_at`,
    values,
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function findChecklistTemplate(
  templateId: string,
): Promise<ChecklistTemplateRow | null> {
  const result = await getPool().query<ChecklistTemplateRow>(
    `SELECT id, client_id, code, name, status
     FROM checklist_templates WHERE id = $1`,
    [templateId],
  );
  return result.rows[0] ?? null;
}

export async function findPatrolRoute(
  patrolRouteId: string,
): Promise<PatrolRouteRow | null> {
  const result = await getPool().query<PatrolRouteRow>(
    `SELECT id, client_id, building_id, code, name, status
     FROM patrol_routes WHERE id = $1`,
    [patrolRouteId],
  );
  return result.rows[0] ?? null;
}

export async function findSecurityPost(
  securityPostId: string,
): Promise<SecurityPostRow | null> {
  const result = await getPool().query<SecurityPostRow>(
    `SELECT id, building_id, code, name, status
     FROM security_posts WHERE id = $1`,
    [securityPostId],
  );
  return result.rows[0] ?? null;
}

/** Starts the shared BE-07 checklist execution for a binding. */
export async function insertExecution(input: {
  bindingId: string;
  clientId: string;
  checklistTemplateId: string;
}): Promise<ExecutionRow> {
  const result = await getPool().query<ExecutionRow>(
    `INSERT INTO checklist_executions
       (id, client_id, checklist_template_id, patrol_checklist_binding_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id, client_id, checklist_template_id,
               patrol_checklist_binding_id, status, started_at,
               completed_at, created_at, updated_at`,
    [
      randomUUID(),
      input.clientId,
      input.checklistTemplateId,
      input.bindingId,
    ],
  );
  return result.rows[0];
}

/**
 * Resolves the patrol checklist context of a checklist execution:
 * execution → its binding → Building / Template / Patrol Route / Start
 * Post. A single authoritative join — the context is never stored
 * separately.
 */
export async function findExecutionContext(
  executionId: string,
): Promise<ExecutionContextRow | null> {
  const result = await getPool().query<ExecutionContextRow>(
    `SELECT
       ce.id AS execution_id,
       ce.checklist_template_id AS execution_template_id,
       ce.status AS execution_status,
       ce.started_at AS execution_started_at,
       ce.completed_at AS execution_completed_at,
       ce.created_at AS execution_created_at,
       ce.updated_at AS execution_updated_at,
       pcb.id AS patrol_checklist_binding_id,
       b.id AS building_id,
       b.code AS building_code,
       b.name AS building_name,
       ct.id AS template_id,
       ct.code AS template_code,
       ct.name AS template_name,
       ct.status AS template_status,
       pr.id AS patrol_route_id,
       pr.code AS patrol_route_code,
       pr.name AS patrol_route_name,
       pr.status AS patrol_route_status,
       sp.id AS start_security_post_id,
       sp.code AS start_security_post_code,
       sp.name AS start_security_post_name
     FROM checklist_executions ce
     LEFT JOIN patrol_checklist_bindings pcb
       ON pcb.id = ce.patrol_checklist_binding_id
     LEFT JOIN buildings b ON b.id = pcb.building_id
     LEFT JOIN checklist_templates ct ON ct.id = pcb.checklist_template_id
     LEFT JOIN patrol_routes pr ON pr.id = pcb.patrol_route_id
     LEFT JOIN security_posts sp ON sp.id = pcb.start_security_post_id
     WHERE ce.id = $1`,
    [executionId],
  );
  return result.rows[0] ?? null;
}

export const patrolChecklistBindingRepository = {
  create,
  findById,
  findChecklistTemplate,
  findExecutionContext,
  findPatrolRoute,
  findSecurityPost,
  insertExecution,
  list,
  listByBuildingIds,
  update,
};
