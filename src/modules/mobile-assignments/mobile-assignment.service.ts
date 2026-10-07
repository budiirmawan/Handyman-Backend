import { getPool } from '../../database';
import type { PaginationParams } from '../../shared/pagination';
import { contextAccessService } from '../context-access';
import { resolveCurrentShifts } from '../mobile-current-shift';
import type { MobileCurrentShift } from '../mobile-current-shift/mobile-current-shift.types';
import { permissionService } from '../permissions';
import { resolveTaskAvailableActions } from '../task-execution';
import { resolveWorkOrderAvailableActions } from '../work-order-actions';
import { safetyInspectionBindingAmbiguousError } from '../safety-inspection-bindings';
import { canCloseWorkOrder } from '../work-order-verification';
import type { WorkOrderStatus } from '../work-orders';
import { workforceRepository } from '../workforce/workforce.repository';
import type {
  MobileAssignmentFeedItem,
  MobileAssignmentProjectionMode,
  MobileAssignmentReference,
  MobileAssignmentShiftContext,
} from './mobile-assignment.types';

/**
 * BE-25C — Mobile assignment feed service.
 *
 * Composes the authenticated user's active Task and Work Order assignments
 * from the authoritative BE-07 / BE-08 tables. Every row is filtered by the
 * BE-02G accessible Building/Client set at the SQL layer; the feed is keyed to
 * the user's linked Workforce Profile (BE-25B identity) and their Team.
 *
 * `availableActions` is backend-authoritative: tasks resolve through
 * `resolveTaskAvailableActions` (the same authority the task execution
 * endpoints enforce) and work orders through `resolveWorkOrderAvailableActions`
 * (the same ACTION_RULES the execution endpoints enforce), gated on the
 * caller's manage permissions.
 */

type TaskAssignmentRow = {
  assignment_id: string;
  assignee_type: 'WORKFORCE' | 'TEAM';
  workforce_profile_id: string | null;
  team_id: string | null;
  assigned_by_user_id: string;
  assigned_at: Date;
  assignment_status: string;
  task_id: string;
  client_id: string;
  schedule_definition_id: string | null;
  occurrence_at: Date;
  target_type: string;
  target_id: string;
  building_id: string | null;
  task_status: string;
  started_at: Date | null;
  completed_at: Date | null;
  completed_by_user_id: string | null;
  completion_notes: string | null;
  generated_at: Date;
  building_code: string | null;
  building_name: string | null;
  /** Canonical BE-18 reading-due id when this task's generated task is the one
   * linked by `utility_reading_dues.generated_task_id`; null otherwise. */
  utility_reading_due_id: string | null;
  cleaning_area_id: string | null;
  /** Canonical ACTIVE patrol schedule binding id of the task's schedule
   * definition; null when the schedule is not a patrol. Non-null means the
   * generated task is a Patrol Execution. */
  active_patrol_binding_id: string | null;
  /** Canonical ACTIVE Safety Inspection binding id resolved by cardinality. */
  active_safety_inspection_binding_id: string | null;
  /** Count is returned by the aggregate so corruption is never winner-selected. */
  active_safety_inspection_binding_count: number;
};

type WorkOrderAssignmentRow = {
  assignment_id: string;
  assignee_type: 'WORKFORCE' | 'TEAM';
  workforce_profile_id: string | null;
  team_id: string | null;
  assigned_by_user_id: string;
  assigned_at: Date;
  assignment_status: string;
  work_order_id: string;
  client_id: string;
  building_id: string;
  work_order_number: string;
  title: string;
  description: string | null;
  work_type: string;
  priority: string;
  wo_status: string;
  started_at: Date | null;
  completed_at: Date | null;
  completed_by_user_id: string | null;
  completion_summary: string | null;
  completion_notes: string | null;
  created_at: Date;
  building_code: string;
  building_name: string;
  asset_id: string | null;
  asset_code: string | null;
  asset_name: string | null;
  fl_id: string | null;
  fl_code: string | null;
  fl_name: string | null;
};

const iso = (value: Date | null | undefined): string | null =>
  value instanceof Date ? value.toISOString() : null;

const TASK_ASSIGNMENT_SELECT = `
  SELECT
    a.id            AS assignment_id,
    a.assignee_type,
    a.workforce_profile_id,
    a.team_id,
    a.assigned_by_user_id,
    a.assigned_at,
    a.status        AS assignment_status,
    t.id            AS task_id,
    t.client_id,
    t.schedule_definition_id,
    t.occurrence_at,
    t.target_type,
    t.target_id,
    t.building_id,
    t.status        AS task_status,
    t.started_at,
    t.completed_at,
    t.completed_by_user_id,
    t.completion_notes,
    t.generated_at,
    b.code          AS building_code,
    b.name          AS building_name,
    urd.id          AS utility_reading_due_id,
    csb.cleaning_area_id AS cleaning_area_id,
    psb.id          AS active_patrol_binding_id,
    sib.active_safety_inspection_binding_id,
    sib.active_safety_inspection_binding_count
  FROM task_assignments a
  JOIN generated_tasks t ON t.id = a.task_id
  LEFT JOIN buildings b ON b.id = t.building_id
  LEFT JOIN utility_reading_dues urd ON urd.generated_task_id = t.id
  -- CR-BE-RN16-PATROL-FIELD-01 PART 01 — the canonical patrol marker. Reached
  -- only through the task's schedule definition and its ACTIVE patrol binding.
  -- Migration 0354 caps that binding at one per schedule definition, so this
  -- LEFT JOIN can never multiply the assignment rows (and the marker can never
  -- be ambiguous).
  LEFT JOIN patrol_schedule_bindings psb
    ON psb.schedule_definition_id = t.schedule_definition_id
   AND psb.status = 'ACTIVE'
  -- CR-BE-RN13-CLEANING-FIELD-01 PART 00 — canonical Cleaning Area, reached
  -- only through the task's schedule definition and its ACTIVE cleaning
  -- binding. Migration 0352 makes that binding at most one per schedule
  -- definition, so this LEFT JOIN can never multiply the assignment rows.
  LEFT JOIN cleaning_schedule_bindings csb
    ON csb.schedule_definition_id = t.schedule_definition_id
   AND csb.status = 'ACTIVE'
  -- CR-BE-RN19-SAFETY-INSPECTION-01 — aggregate before projecting the marker.
  -- The count is the cardinality guard; the id is exposed only when exactly
  -- one ACTIVE binding exists. No LIMIT, rows[0], or winner ordering is used.
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*)::INTEGER AS active_safety_inspection_binding_count,
      CASE WHEN COUNT(*) = 1 THEN MIN(sib_row.id) ELSE NULL END
        AS active_safety_inspection_binding_id
      FROM safety_inspection_bindings sib_row
     WHERE sib_row.schedule_definition_id = t.schedule_definition_id
       AND sib_row.status = 'ACTIVE'
  ) sib ON TRUE
`;

const TASK_ASSIGNMENT_SCOPE = `
  a.status = 'ACTIVE'
  AND (
    (a.assignee_type = 'WORKFORCE' AND a.workforce_profile_id = ANY($1::uuid[]))
    OR (a.assignee_type = 'TEAM' AND a.team_id = ANY($2::uuid[]))
  )
  AND (
    t.building_id = ANY($3::uuid[])
    OR (t.building_id IS NULL AND t.client_id = ANY($4::uuid[]))
  )
`;

const WORK_ORDER_ASSIGNMENT_SELECT = `
  SELECT
    a.id            AS assignment_id,
    a.assignee_type,
    a.workforce_profile_id,
    a.team_id,
    a.assigned_by_user_id,
    a.assigned_at,
    a.status        AS assignment_status,
    w.id            AS work_order_id,
    w.client_id,
    w.building_id,
    w.work_order_number,
    w.title,
    w.description,
    w.work_type,
    w.priority,
    w.status        AS wo_status,
    w.started_at,
    w.completed_at,
    w.completed_by_user_id,
    w.completion_summary,
    w.completion_notes,
    w.created_at,
    b.code          AS building_code,
    b.name          AS building_name,
    ast.id          AS asset_id,
    ast.asset_code,
    ast.asset_name,
    fl.id           AS fl_id,
    fl.code         AS fl_code,
    fl.name         AS fl_name
  FROM work_order_assignments a
  JOIN work_orders w ON w.id = a.work_order_id
  JOIN buildings b ON b.id = w.building_id
  LEFT JOIN assets ast ON ast.id = w.asset_id
  LEFT JOIN functional_locations fl ON fl.id = w.functional_location_id
`;

const WORK_ORDER_ASSIGNMENT_SCOPE = `
  a.status = 'ACTIVE'
  AND (
    (a.assignee_type = 'WORKFORCE' AND a.workforce_profile_id = ANY($1::uuid[]))
    OR (a.assignee_type = 'TEAM' AND a.team_id = ANY($2::uuid[]))
  )
  AND w.building_id = ANY($3::uuid[])
`;

function toTaskItem(
  row: TaskAssignmentRow,
  canManageTasks: boolean,
): MobileAssignmentFeedItem {
  if (row.active_safety_inspection_binding_count > 1) {
    throw safetyInspectionBindingAmbiguousError();
  }

  const reference: MobileAssignmentReference = {
    // TASK side
    taskId: row.task_id,
    scheduleDefinitionId: row.schedule_definition_id,
    targetType: row.target_type,
    targetId: row.target_id,
    generatedAt: iso(row.generated_at),
    // RN-12 PART B — canonical BE-18 reading-due id, derived from the
    // generated-task → utility_reading_due relation only (never targetType/targetId).
    utilityReadingDueId: row.utility_reading_due_id ?? null,
    // CR-BE-RN13-CLEANING-FIELD-01 PART 00 — canonical Cleaning Area, derived
    // from the generated-task → ACTIVE cleaning_schedule_bindings relation
    // only (never targetType/targetId).
    cleaningAreaId: row.cleaning_area_id ?? null,
    // CR-BE-RN16-PATROL-FIELD-01 PART 01 — canonical Patrol Execution marker.
    // A Patrol Execution IS the generated task, so the id is the task id —
    // emitted only when the task's schedule definition carries exactly one
    // ACTIVE patrol schedule binding (migration 0354). Never inferred from
    // targetType / targetId / title / workType / securityPost.
    patrolExecutionId: row.active_patrol_binding_id ? row.task_id : null,
    // CR-BE-RN19-SAFETY-INSPECTION-01 — canonical Safety Inspection binding
    // marker, derived only from the generated task's schedule definition to
    // exactly one ACTIVE binding. The binding id is context only; taskId stays
    // the generated_tasks.id execution reference.
    safetyInspectionBindingId: row.active_safety_inspection_binding_id ?? null,
    // WORK_ORDER side (explicit nulls for a stable contract)
    workOrderId: null,
    workOrderNumber: null,
    title: null,
    description: null,
    workType: null,
    priority: null,
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    completedByUserId: row.completed_by_user_id,
    completionSummary: null,
    completionNotes: row.completion_notes,
    createdAt: null,
  };
  return {
    id: row.assignment_id,
    type: 'TASK',
    status: row.task_status,
    assignee: {
      assigneeType: row.assignee_type,
      workforceProfileId: row.workforce_profile_id,
      teamId: row.team_id,
      assignedByUserId: row.assigned_by_user_id,
      assignedAt: iso(row.assigned_at) ?? '',
      assignmentStatus: row.assignment_status,
    },
    context: {
      clientId: row.client_id,
      buildingId: row.building_id,
      buildingCode: row.building_code,
      buildingName: row.building_name,
      locations: [],
    },
    schedule: {
      occurrenceAt: iso(row.occurrence_at),
      dueAt: null,
    },
    reference,
    availableActions: canManageTasks
      ? resolveTaskAvailableActions(row.task_status)
      : [],
    shift: null, // MOB-C04 PART 01 — annotated below from the current-shift authority.
  };
}

function toWorkOrderItem(
  row: WorkOrderAssignmentRow,
  canManageWorkOrders: boolean,
  canClose: boolean,
): MobileAssignmentFeedItem {
  const locations: MobileAssignmentFeedItem['context']['locations'] = [];
  if (row.asset_id && row.asset_code && row.asset_name) {
    locations.push({
      type: 'ASSET',
      id: row.asset_id,
      code: row.asset_code,
      name: row.asset_name,
    });
  }
  if (row.fl_id && row.fl_code && row.fl_name) {
    locations.push({
      type: 'FUNCTIONAL_LOCATION',
      id: row.fl_id,
      code: row.fl_code,
      name: row.fl_name,
    });
  }
  const reference: MobileAssignmentReference = {
    // TASK side (explicit nulls for a stable contract)
    taskId: null,
    scheduleDefinitionId: null,
    targetType: null,
    targetId: null,
    generatedAt: null,
    // WORK_ORDER items never originate from a utility reading due.
    utilityReadingDueId: null,
    // WORK_ORDER items are never cleaning executions.
    cleaningAreaId: null,
    // WORK_ORDER items are never patrol executions.
    patrolExecutionId: null,
    // WORK_ORDER items are never Safety Inspection tasks.
    safetyInspectionBindingId: null,
    // WORK_ORDER side
    workOrderId: row.work_order_id,
    workOrderNumber: row.work_order_number,
    title: row.title,
    description: row.description,
    workType: row.work_type,
    priority: row.priority,
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    completedByUserId: row.completed_by_user_id,
    completionSummary: row.completion_summary,
    completionNotes: row.completion_notes,
    createdAt: iso(row.created_at),
  };
  return {
    id: row.assignment_id,
    type: 'WORK_ORDER',
    status: row.wo_status,
    assignee: {
      assigneeType: row.assignee_type,
      workforceProfileId: row.workforce_profile_id,
      teamId: row.team_id,
      assignedByUserId: row.assigned_by_user_id,
      assignedAt: iso(row.assigned_at) ?? '',
      assignmentStatus: row.assignment_status,
    },
    context: {
      clientId: row.client_id,
      buildingId: row.building_id,
      buildingCode: row.building_code,
      buildingName: row.building_name,
      locations,
    },
    schedule: {
      occurrenceAt: null,
      dueAt: null,
    },
    reference,
    availableActions: canManageWorkOrders
      ? resolveWorkOrderAvailableActions(
          row.wo_status as WorkOrderStatus,
          true,
          true,
          canClose,
        )
      : [],
    shift: null, // MOB-C04 PART 01 — annotated below from the current-shift authority.
  };
}

/** Maps an authoritative current shift to the minimal item context. */
function toShiftContext(shift: MobileCurrentShift): MobileAssignmentShiftContext {
  return {
    assignmentId: shift.assignmentId,
    shiftId: shift.shiftId,
    code: shift.code,
    name: shift.name,
    startTime: shift.startTime,
    endTime: shift.endTime,
    securityPost: shift.securityPost,
  };
}

/**
 * MOB-C04 PART 01A — Service query options for `GET /mobile/assignments`.
 *
 * `mode` selects the projection:
 *   - `'default'`      — every accessible active assignment (BE-25C, unchanged).
 *   - `'currentShift'` — the now-live current-shift projection: only assignment
 *                        items whose Building is a Building the worker is
 *                        currently on shift at (per the authoritative
 *                        `/mobile/current-shift` authority). Empty when the
 *                        worker is not on shift at any assigned Building.
 *
 * `now` is injectable only for deterministic tests; the route always uses the
 * real current instant (same convention as the current-shift service).
 */
export type MobileAssignmentQueryOptions = {
  mode?: MobileAssignmentProjectionMode;
  now?: Date;
};

export async function listMobileAssignments(
  userId: string,
  pagination: PaginationParams | null,
  options: MobileAssignmentQueryOptions = {},
): Promise<{ items: MobileAssignmentFeedItem[]; total: number }> {
  const mode = options.mode ?? 'default';
  const now = options.now ?? new Date();
  const [buildingIds, clientIds, profile, permissions] = await Promise.all([
    contextAccessService.getAccessibleBuildingIds(userId),
    contextAccessService.getAccessibleClientIds(userId),
    workforceRepository.findByUserId(userId),
    permissionService.resolvePermissionsForUser(userId),
  ]);

  const canManageTasks = permissions.includes('task.manage');
  const canManageWorkOrders = permissions.includes('work_order.manage');

  // MOB-C04 PART 01 — Shift context. Reuses the authoritative
  // `/mobile/current-shift` derivation (BE-03E roster + BE-02F/G accessible
  // Building set + Building-timezone wall-clock) so the feed never invents an
  // "active shift": a worker is on a shift only because the backend current
  // shift authority returned it at `now`. It is an annotation in default mode;
  // in `currentShift` mode it is the filter (below).
  const current = await resolveCurrentShifts(userId, now);
  const shiftForBuilding = new Map<string, MobileCurrentShift>();
  for (const shift of current.shifts) {
    if (shift.buildingId && !shiftForBuilding.has(shift.buildingId)) {
      shiftForBuilding.set(shift.buildingId, shift);
    }
  }

  const items: MobileAssignmentFeedItem[] = [];

  if (profile) {
    const profileIds = [profile.id];
    const teamIds = profile.teamId ? [profile.teamId] : [];

    const tasks = await getPool().query<TaskAssignmentRow>(
      `SELECT task_items.* FROM (
         ${TASK_ASSIGNMENT_SELECT}
         WHERE ${TASK_ASSIGNMENT_SCOPE}
         ORDER BY t.occurrence_at, a.id
       ) task_items`,
      [profileIds, teamIds, buildingIds, clientIds],
    );
    for (const row of tasks.rows) {
      items.push(toTaskItem(row, canManageTasks));
    }

    const workOrders = await getPool().query<WorkOrderAssignmentRow>(
      `SELECT wo_items.* FROM (
         ${WORK_ORDER_ASSIGNMENT_SELECT}
         WHERE ${WORK_ORDER_ASSIGNMENT_SCOPE}
         ORDER BY w.created_at, a.id
       ) wo_items`,
      [profileIds, teamIds, buildingIds],
    );
    const workOrderItems = await Promise.all(
      workOrders.rows.map(async (row) => {
        const canClose =
          canManageWorkOrders && row.wo_status === 'COMPLETED'
            ? await canCloseWorkOrder(row.work_order_id)
            : false;
        return toWorkOrderItem(row, canManageWorkOrders, canClose);
      }),
    );
    items.push(...workOrderItems);
  }

  // MOB-C04 PART 01 — Annotate each item with the authoritative current shift
  // whose Building equals the item's Building. Items whose Building has no
  // active shift (worker not currently on shift there, no Building, or no
  // valid timezone) keep `shift: null`.
  for (const item of items) {
    const buildingId = item.context.buildingId;
    const shift = buildingId ? shiftForBuilding.get(buildingId) : undefined;
    item.shift = shift ? toShiftContext(shift) : null;
  }

  // MOB-C04 PART 01A — Shift projection. In `currentShift` mode, BE-02G is
  // the isolation floor (already applied above) and the current-shift
  // authority is the gate: return only items whose Building the worker is
  // currently on shift at (shift !== null). With no current shift the set is
  // empty and the projection returns 200 data: []. Default mode keeps every
  // accessible active assignment (BE-25C, unchanged).
  const feed = mode === 'currentShift'
    ? items.filter((item) => item.shift !== null)
    : items;

  // Deterministic feed order: earliest work first (task occurrence / work
  // order creation), nulls last, tie-broken by type then assignment id.
  feed.sort((a, b) => {
    const at = a.schedule.occurrenceAt ?? a.reference.createdAt ?? null;
    const bt = b.schedule.occurrenceAt ?? b.reference.createdAt ?? null;
    if (at !== null && bt !== null) {
      const diff = at.localeCompare(bt);
      if (diff !== 0) return diff;
    } else if (at !== null) {
      return -1;
    } else if (bt !== null) {
      return 1;
    }
    return a.id.localeCompare(b.id);
  });

  const total = feed.length;
  if (pagination) {
    return {
      items: feed.slice(pagination.offset, pagination.offset + pagination.limit),
      total,
    };
  }
  return { items: feed, total };
}

/**
 * CR-BE-RN21-NOTIFICATION-NAV-01 — every mobile WORK_ORDER assignment the
 * authenticated user can see for ONE canonical Work Order.
 *
 * WHY THIS EXISTS
 * ---------------
 * `GET /notifications/{id}/navigation-target` must hand the client the SAME
 * `MobileAssignment` object the FieldWork feed publishes — never a second
 * assignment DTO, and never a client-side scan of `/mobile/assignments`
 * looking for a match. This function is the Work Order half of the feed
 * applied to a single Work Order:
 *
 *   · the SAME projection  (`WORK_ORDER_ASSIGNMENT_SELECT` + `toWorkOrderItem`)
 *   · the SAME visibility (`WORK_ORDER_ASSIGNMENT_SCOPE`: ACTIVE assignment,
 *     the caller's own Workforce Profile or Team, Building access, plus the
 *     `work_order.manage` gate the feed applies to `availableActions` and the
 *     `work-order-verification` CLOSE check)
 *   · the SAME evidence requirements (`GET /mobile/assignments` requires
 *     `task.read` + `work_order.read`; the notification route requires
 *     `work_order.read`)
 *
 * CARDINALITY IS RETURNED, NOT RESOLVED
 * -------------------------------------
 * A Work Order can legitimately carry more than one ACTIVE assignment visible
 * to the same user (a WORKFORCE assignment AND a TEAM assignment, or several
 * assignment rows). This function returns the WHOLE array so the caller — the
 * navigation resolver — decides: exactly one is navigable, none means no
 * target, and more than one is a bounded conflict. No `LIMIT 1`, no `rows[0]`
 * and no ordering-based winner selection exists here on purpose.
 */
export async function findMobileWorkOrderAssignmentsByWorkOrderId(
  userId: string,
  workOrderId: string,
  options: MobileAssignmentQueryOptions = {},
): Promise<MobileAssignmentFeedItem[]> {
  const now = options.now ?? new Date();
  const [buildingIds, profile, permissions] = await Promise.all([
    contextAccessService.getAccessibleBuildingIds(userId),
    workforceRepository.findByUserId(userId),
    permissionService.resolvePermissionsForUser(userId),
  ]);

  if (!profile) {
    // No linked Workforce Profile (BE-25B identity) means no assignment can be
    // assigned to this user at all — the same reason the feed yields no
    // WORK_ORDER items for them.
    return [];
  }

  const canManageWorkOrders = permissions.includes('work_order.manage');
  const profileIds = [profile.id];
  const teamIds = profile.teamId ? [profile.teamId] : [];

  const workOrders = await getPool().query<WorkOrderAssignmentRow>(
    `SELECT wo_items.* FROM (
       ${WORK_ORDER_ASSIGNMENT_SELECT}
       WHERE ${WORK_ORDER_ASSIGNMENT_SCOPE}
         AND w.id = $4
       ORDER BY w.created_at, a.id
     ) wo_items`,
    [profileIds, teamIds, buildingIds, workOrderId],
  );

  const items = await Promise.all(
    workOrders.rows.map(async (row) => {
      const canClose =
        canManageWorkOrders && row.wo_status === 'COMPLETED'
          ? await canCloseWorkOrder(row.work_order_id)
          : false;
      return toWorkOrderItem(row, canManageWorkOrders, canClose);
    }),
  );

  // The feed annotates every item with the authoritative current-shift context.
  // Reproduced here so the returned assignment is byte-identical in shape to
  // the feed's — never a reduced projection.
  const current = await resolveCurrentShifts(userId, now);
  const shiftForBuilding = new Map<string, MobileCurrentShift>();
  for (const shift of current.shifts) {
    if (shift.buildingId && !shiftForBuilding.has(shift.buildingId)) {
      shiftForBuilding.set(shift.buildingId, shift);
    }
  }
  for (const item of items) {
    const buildingId = item.context.buildingId;
    const shift = buildingId ? shiftForBuilding.get(buildingId) : undefined;
    item.shift = shift ? toShiftContext(shift) : null;
  }

  return items;
}

export const mobileAssignmentService = {
  findMobileWorkOrderAssignmentsByWorkOrderId,
  listMobileAssignments,
};
