import { getPool } from '../../database';
import type {
  SecurityDailyActivityChecklist,
  SecurityDailyActivityFinding,
  SecurityDailyActivityPatrol,
  SecurityDailyActivityPost,
  SecurityDailyActivityRoute,
} from './security-daily-activity.types';

export function operationalDateWindow(dateString: string): {
  start: Date;
  end: Date;
} {
  const [year, month, day] = dateString.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, day));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

type PatrolRow = {
  task_id: string;
  patrol_route_id: string;
  route_code: string;
  route_name: string;
  route_status: string;
  route_start_security_post_id: string | null;
  start_security_post_id: string | null;
  start_post_code: string | null;
  start_post_name: string | null;
  start_post_type: string | null;
  start_post_status: string | null;
  occurrence_at: Date;
  status: SecurityDailyActivityPatrol['status'];
  started_at: Date | null;
  completed_at: Date | null;
};

/**
 * Single query for the per-Building, per-operational-date window. Joins
 * the BE-07 generated_tasks row to the BE-12C binding, BE-12B route, and
 * optional BE-12A start post. Uses the existing
 * `tasks_building_idx`/`patrol_schedule_bindings_route_idx` for
 * efficient lookup.
 */
export async function listPatrols(
  buildingId: string,
  window: { start: Date; end: Date },
  filter: { securityPostId?: string } = {},
): Promise<SecurityDailyActivityPatrol[]> {
  const conditions = [
    'gt.building_id = $1',
    'gt.occurrence_at >= $2',
    'gt.occurrence_at < $3',
    'psb.status = \'ACTIVE\'',
    'pr.status = \'ACTIVE\'',
  ];
  const values: unknown[] = [buildingId, window.start, window.end];

  if (filter.securityPostId) {
    values.push(filter.securityPostId);
    conditions.push(
      `(psb.start_security_post_id = $${values.length} OR pr.start_security_post_id = $${values.length})`,
    );
  }

  const result = await getPool().query<PatrolRow>(
    `SELECT
       gt.id AS task_id,
       pr.id AS patrol_route_id,
       pr.code AS route_code,
       pr.name AS route_name,
       pr.status AS route_status,
       pr.start_security_post_id AS route_start_security_post_id,
       psb.start_security_post_id AS start_security_post_id,
       sp.code AS start_post_code,
       sp.name AS start_post_name,
       sp.post_type AS start_post_type,
       sp.status AS start_post_status,
       gt.occurrence_at AS occurrence_at,
       gt.status AS status,
       gt.started_at AS started_at,
       gt.completed_at AS completed_at
     FROM generated_tasks gt
     JOIN patrol_schedule_bindings psb
       ON psb.schedule_definition_id = gt.schedule_definition_id
     JOIN patrol_routes pr ON pr.id = psb.patrol_route_id
     LEFT JOIN security_posts sp ON sp.id = psb.start_security_post_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY gt.occurrence_at ASC`,
    values,
  );

  return result.rows.map((row): SecurityDailyActivityPatrol => {
    const route: SecurityDailyActivityRoute = {
      id: row.patrol_route_id,
      code: row.route_code,
      name: row.route_name,
      status: row.route_status as 'ACTIVE' | 'INACTIVE',
      startSecurityPostId: row.route_start_security_post_id,
    };
    const post: SecurityDailyActivityPost | null = row.start_security_post_id
      ? {
          id: row.start_security_post_id,
          code: row.start_post_code as string,
          name: row.start_post_name as string,
          postType: row.start_post_type as string,
          status: row.start_post_status as 'ACTIVE' | 'INACTIVE',
        }
      : null;
    return {
      id: row.task_id,
      patrolRouteId: row.patrol_route_id,
      patrolRoute: route,
      startSecurityPostId: row.start_security_post_id,
      startSecurityPost: post,
      status: row.status,
      operationalDate: row.occurrence_at.toISOString().slice(0, 10),
      occurrenceAt: row.occurrence_at.toISOString(),
      startedAt: row.started_at ? row.started_at.toISOString() : null,
      completedAt: row.completed_at ? row.completed_at.toISOString() : null,
    };
  });
}

type ChecklistRow = {
  execution_id: string;
  binding_id: string;
  route_id: string;
  template_id: string;
  template_code: string;
  template_name: string;
  status: SecurityDailyActivityChecklist['status'];
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
};

/**
 * One query for the operational-date window. Pulls every checklist
 * execution started from a patrol checklist binding whose route is in
 * the building and whose execution `created_at` (or, more usefully, the
 * underlying patrol execution's `occurrence_at`) falls inside the
 * window. To avoid an N+1 join we anchor on the patrol execution date
 * window through the binding's patrol route + the BE-07 execution date.
 *
 * We use the BE-07 execution's `created_at` (Date-aware, UTC) for the
 * window — that timestamp is the closest authoritative proxy for "this
 * checklist was started on this operational day". A patrol-checklist
 * started before the window is still considered "today's" if it has not
 * yet completed by midnight UTC of the next day, so we OR both bounds
 * and let the caller filter.
 */
export async function listChecklists(
  buildingId: string,
  window: { start: Date; end: Date },
  filter: { securityPostId?: string } = {},
): Promise<SecurityDailyActivityChecklist[]> {
  const conditions = [
    'pcb.building_id = $1',
    'ce.created_at >= $2',
    'ce.created_at < $3',
    'pcb.status = \'ACTIVE\'',
    'ce.status <> \'CANCELLED\'',
  ];
  const values: unknown[] = [buildingId, window.start, window.end];

  if (filter.securityPostId) {
    values.push(filter.securityPostId);
    conditions.push(`pcb.start_security_post_id = $${values.length}`);
  }

  const result = await getPool().query<ChecklistRow>(
    `SELECT
       ce.id AS execution_id,
       pcb.id AS binding_id,
       pcb.patrol_route_id AS route_id,
       pcb.checklist_template_id AS template_id,
       ct.code AS template_code,
       ct.name AS template_name,
       ce.status AS status,
       ce.started_at AS started_at,
       ce.completed_at AS completed_at,
       ce.created_at AS created_at
     FROM checklist_executions ce
     JOIN patrol_checklist_bindings pcb
       ON pcb.id = ce.patrol_checklist_binding_id
     JOIN checklist_templates ct
       ON ct.id = pcb.checklist_template_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY ce.created_at ASC`,
    values,
  );

  return result.rows.map((row): SecurityDailyActivityChecklist => {
    const operationalDate = row.created_at.toISOString().slice(0, 10);
    return {
      id: row.execution_id,
      checklistTemplateId: row.template_id,
      checklistTemplateCode: row.template_code,
      checklistTemplateName: row.template_name,
      patrolChecklistBindingId: row.binding_id,
      patrolRouteId: row.route_id,
      status: row.status,
      startedAt: row.started_at ? row.started_at.toISOString() : null,
      completedAt: row.completed_at ? row.completed_at.toISOString() : null,
      operationalDate,
      createdAt: row.created_at.toISOString(),
    };
  });
}

type FindingRow = {
  id: string;
  finding_number: string;
  title: string;
  status: SecurityDailyActivityFinding['status'];
  classification_id: string | null;
  severity_id: string | null;
  created_at: Date;
  reported_by_user_id: string;
};

export async function listOpenFindings(
  buildingId: string,
): Promise<SecurityDailyActivityFinding[]> {
  const result = await getPool().query<FindingRow>(
    `SELECT id, finding_number, title, status, classification_id,
            severity_id, created_at, reported_by_user_id
     FROM findings
     WHERE building_id = $1 AND status = 'OPEN'
     ORDER BY created_at DESC`,
    [buildingId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    findingNumber: row.finding_number,
    title: row.title,
    status: row.status,
    classificationId: row.classification_id,
    severityId: row.severity_id,
    createdAt: row.created_at.toISOString(),
    reportedByUserId: row.reported_by_user_id,
    availableActions: [], // Filled in by the service after the join.
  }));
}

export const securityDailyActivityRepository = {
  listChecklists,
  listOpenFindings,
  listPatrols,
};
