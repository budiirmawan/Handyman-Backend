import { AppError } from '../../shared/errors';
import { buildingNotFoundError, buildingRepository } from '../buildings';
import { isValidUuid } from '../clients';
import { ASSIGNEE_TYPES, isAssigneeType } from '../cleaning-assignments/cleaning-assignment.types';
import { contextAccessService } from '../context-access';
import { getScheduledOperationLineageRows } from './scheduled-operation-lineage.repository';
import type {
  GeneratedTaskStatus,
  PublicScheduledOperationLineage,
  ScheduledOperationLineageFilters,
} from './scheduled-operation-lineage.types';

/**
 * R10 PART 10 — Scheduled Operation Lineage service.
 *
 * Read-only. Internal backend read contract for Reporting consumption; there is
 * deliberately no HTTP endpoint, route, controller, Reporting dataset enum entry,
 * registry adapter, projection or OpenAPI surface in this PART.
 *
 * PERMISSION — the authoritative read permission for this dataset is the EXISTING
 * `task.read` (seeded in `foundation-access.seed` as `{ code: 'task.read', name: 'Read
 * Tasks' }`). It was source-verified rather than assumed, from four converging facts:
 *
 *   1. `src/modules/tasks/task.routes.ts` gates `GET /tasks` and `GET /tasks/:id` — the
 *      read routes over `generated_tasks` — with `requirePermission('task.read')`, while
 *      `task.manage` gates only generation. `generated_tasks` is this dataset's base row
 *      authority and its grain.
 *   2. `mobile-assignments` already reads `generated_tasks` under `task.read`, so this is
 *      an established grant for generated-task reads rather than a new interpretation.
 *   3. The Reporting export registry's convention is that `requiredReadPermission` is the
 *      permission governing the dataset's own base domain: `checklist.read` for the
 *      checklist-based datasets, `work_order.read` for the Work Order register and Work
 *      Order SLA, `finding.read` for the Finding register.
 *   4. The R10 PART 07/08 precedent resolves the same shape identically: the Work Order
 *      SLA dataset is built on `applied_slas`/`sla_clocks` yet is governed by the business
 *      subject's `work_order.read`, not by an SLA-specific grant.
 *
 * `schedule.read` was considered and REJECTED: it gates `GET /schedules`,
 * `GET /schedules/:id`, `GET /schedules/:id/recurrence` and `GET /schedules/:id/occurrences`
 * — the schedule-DEFINITION read model and the scheduler's occurrence preview. Schedule and
 * recurrence facts are LEFT-JOIN enrichment on this dataset's generated-task grain, not the
 * rows it returns, so the grain's own read gate governs. The per-report grants used by
 * `housekeeping_report.read`, `security_daily_activity.read` and `engineering.read` are
 * likewise rejected: each belongs to a different named report, and no
 * `scheduled_operation_lineage.read` exists. NO new permission is created, and nothing here
 * falls back to `reporting.read`, `lineage.read` or an admin grant.
 *
 * Consistent with the sibling register services, enforcement is a route/registry-layer
 * concern, so this service declares no gate of its own: it takes the authenticated `userId`
 * and applies the shared context-access pattern. The verified permission is documented here
 * for PART 11 to wire as `requiredReadPermission`.
 *
 * WHAT THIS SERVICE OWNS — caller query parsing and validation, authorized building-scope
 * resolution, the optional explicit `buildingId` existence check and access assertion,
 * date-window normalization, ONE envelope `asOf` instant, a single repository call and
 * public envelope construction.
 *
 * WHAT IT DELIBERATELY DOES NOT OWN — no scheduling logic, no recurrence calculation, no
 * task generation, no assignment selection rule, no executor derivation, no missed/overdue
 * calculation, no KPI logic and no execution lifecycle logic. The PART 09 repository remains
 * the row read-model authority: rows are returned exactly as it produced them, never
 * post-filtered, collapsed, deduplicated, re-sorted for business meaning, merged across the
 * checklist and form bindings, or enriched from another domain service.
 *
 * SCOPE — mirrors the sibling Work Order SLA / Work Order / Vendor Service / Finding
 * registers. An explicit `buildingId` is existence-checked and access-asserted, and the
 * repository scope becomes exactly that one Building. An omitted `buildingId` rolls the read
 * model up across exactly the Buildings the caller can reach. An empty authorized scope
 * returns a well-formed empty envelope WITHOUT querying, so an empty `ANY(...)` array is
 * never sent to PostgreSQL and cross-Building or cross-Client leakage is impossible.
 *
 * `buildingId` is therefore BOTH an access assertion and a narrowing filter, never a cosmetic
 * one. Every other identifier narrows only: `scheduleDefinitionId` and `generatedTaskId` in
 * particular can never create or widen Building authority, because the repository applies
 * them strictly inside the already-authorized `gt.building_id` scope.
 *
 * NULL-BUILDING — the PART 09 repository excludes `gt.building_id IS NULL` on purpose, and
 * this service MUST NOT compensate for that: it never adds client-scoped tasks, never
 * resolves a `clientId` instead, never unions NULL-building rows and never treats a missing
 * Building as globally visible. The task domain's own list route does widen with
 * `OR (building_id IS NULL AND client_id = ANY($2))`; that branch is not reproduced anywhere
 * in this module. This R10 dataset is building-scoped only.
 *
 * CLIENT SCOPE — no caller-provided `clientId` is accepted as a scope override and none is
 * part of the filter contract. Client lineage stays a row fact read from the authoritative
 * scoped records (`generated_tasks.client_id`), inherited from the authenticated context.
 *
 * FILTERS — exactly the eleven frozen by PART 09. `taskId` is NOT accepted and NO
 * `taskId = generatedTaskId` alias is created: PART 09 proved there is no `tasks` table and
 * no `generated_tasks.task_id` column, so `generatedTaskId` is the task identity and a second
 * alias would manufacture duplicate semantic identity without source authority. Unknown query
 * parameters are never forwarded — the returned object is constructed key by key, so anything
 * unrecognized is dropped rather than reaching the repository. No `page`, `limit`, `offset`,
 * `sort`, `search`, `missed`, `overdue`, `dueBefore`, `graceMinutes`, `executor` or
 * `completedBy` parameter exists.
 *
 * DATE WINDOW — UTC half-open `[dateFrom, dateTo)` over `generated_tasks.occurrence_at`, the
 * authority PART 09 froze. The repository owns the SQL predicate; this service only validates
 * and normalizes. Invalid dates are rejected, `dateFrom` must be strictly earlier than
 * `dateTo`, the two are never silently swapped, and no default reporting period is invented.
 * A date-only `dateTo` is inclusive of that whole UTC day. `createdAt` and `generatedAt` are
 * never offered as alternate period semantics.
 *
 * AS-OF — exactly one `asOf` instant is created per call and published as `envelope.asOf`.
 * Unlike the Work Order SLA register, this contract has NO current-time-derived field: every
 * value the repository returns is persisted. `asOf` is therefore envelope-consistency
 * metadata only — it is NOT passed to the repository (whose signature takes no instant), and
 * no missed, overdue, lateness or elapsed value is computed from it. Its existence is never
 * treated as permission to derive one.
 */

export type ValidationDetail = {
  field: string;
  message: string;
};

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `generated_tasks.status` has a TYPE authority (PART 09's `GeneratedTaskStatus`, sourced
 * from the CHECK constraint migration 0079 installed) but no runtime authority for the FULL
 * vocabulary, so this guard is typed against that authority and cannot drift silently —
 * the R08 `EXECUTION_REVIEW_CHILD_STATUSES` / R10 PART 07 `CLOCK_STATUSES` pattern.
 *
 * The existing `SCHEDULED_TASK_STATUSES` constants in `engineering-daily-operations` and
 * `shift-handovers` (`['OPEN', 'ASSIGNED']`) and `EXECUTABLE_TASK_STATUSES` in
 * `mobile-form-instances` (`['OPEN', 'ASSIGNED', 'IN_PROGRESS']`) are deliberately NOT
 * reused. Each is a module-private, purpose-specific SUBSET answering "which tasks are still
 * schedulable/executable", not the persisted status domain; adopting one here would make
 * COMPLETED, CANCELLED and IN_PROGRESS tasks silently unfilterable and so would narrow the
 * truth this read model reports. The status is never reinterpreted into a KPI meaning.
 */
const GENERATED_TASK_STATUSES: readonly GeneratedTaskStatus[] = [
  'OPEN',
  'ASSIGNED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
];

function isGeneratedTaskStatus(value: unknown): value is GeneratedTaskStatus {
  return (
    typeof value === 'string' &&
    (GENERATED_TASK_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Parses and validates caller query input into the frozen PART 09 filter contract.
 *
 * Only the eleven frozen filters are read, and the result is built key by key, so an unknown
 * parameter — including `taskId` and `clientId` — can never reach the repository.
 */
export function parseScheduledOperationLineageQuery(
  query: Record<string, unknown>,
): ScheduledOperationLineageFilters {
  const details: ValidationDetail[] = [];

  // Seven identifiers, all UUID-validated and all narrowing-only.
  const buildingId = readOptionalUuid(query.buildingId, 'buildingId', details);
  const scheduleDefinitionId = readOptionalUuid(
    query.scheduleDefinitionId,
    'scheduleDefinitionId',
    details,
  );
  const generatedTaskId = readOptionalUuid(query.generatedTaskId, 'generatedTaskId', details);
  const checklistExecutionId = readOptionalUuid(
    query.checklistExecutionId,
    'checklistExecutionId',
    details,
  );
  const formInstanceId = readOptionalUuid(query.formInstanceId, 'formInstanceId', details);
  const assignedWorkforceProfileId = readOptionalUuid(
    query.assignedWorkforceProfileId,
    'assignedWorkforceProfileId',
    details,
  );
  const assignedTeamId = readOptionalUuid(query.assignedTeamId, 'assignedTeamId', details);

  // The assignment vocabulary reuses the owning domain's OWN runtime authority
  // (`cleaning-assignments`), so no second vocabulary is restated here.
  const assigneeType = readOptionalEnum(
    query.assigneeType,
    'assigneeType',
    isAssigneeType,
    `assigneeType must be one of: ${ASSIGNEE_TYPES.join(', ')}.`,
    details,
  );

  // Generated-task status uses the typed guard above over PART 09's type authority.
  const status = readOptionalEnum(
    query.status,
    'status',
    isGeneratedTaskStatus,
    `status must be one of: ${GENERATED_TASK_STATUSES.join(', ')}.`,
    details,
  );

  const dateFromRaw = readSingleParam(query.dateFrom);
  const dateToRaw = readSingleParam(query.dateTo);
  const dateFrom = dateFromRaw
    ? readOptionalDate(dateFromRaw, 'dateFrom', details)
    : undefined;
  const dateTo = dateToRaw ? readOptionalDate(dateToRaw, 'dateTo', details) : undefined;

  // The window is half-open, so an equal or reversed pair is rejected rather than silently
  // swapped or quietly widened into an inclusive range.
  if (dateFrom && dateTo && dateFrom.getTime() >= dateTo.getTime()) {
    details.push({
      field: 'dateFrom',
      message: 'dateFrom must be earlier than dateTo.',
    });
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(buildingId === undefined ? {} : { buildingId }),
    ...(scheduleDefinitionId === undefined ? {} : { scheduleDefinitionId }),
    ...(generatedTaskId === undefined ? {} : { generatedTaskId }),
    ...(status === undefined ? {} : { status }),
    ...(checklistExecutionId === undefined ? {} : { checklistExecutionId }),
    ...(formInstanceId === undefined ? {} : { formInstanceId }),
    ...(assigneeType === undefined ? {} : { assigneeType }),
    ...(assignedWorkforceProfileId === undefined ? {} : { assignedWorkforceProfileId }),
    ...(assignedTeamId === undefined ? {} : { assignedTeamId }),
    ...(dateFromRaw ? { dateFrom: dateFromRaw.trim() } : {}),
    ...(dateToRaw ? { dateTo: dateToRaw.trim() } : {}),
  };
}

/**
 * Converts the window into a half-open `[start, end)` range over
 * `generated_tasks.occurrence_at`. A date-only `dateTo` is inclusive of that whole UTC day.
 * Mirrors `workOrderSlaRegisterRange` / `workOrderRegisterRange` and BE-23H.
 */
export function scheduledOperationLineageRange(filters: ScheduledOperationLineageFilters): {
  start: Date | null;
  end: Date | null;
} {
  const start = filters.dateFrom ? new Date(filters.dateFrom) : null;
  let end: Date | null = null;
  if (filters.dateTo) {
    const to = new Date(filters.dateTo);
    end = DATE_ONLY.test(filters.dateTo) ? new Date(to.getTime() + 86400000) : to;
  }
  return { start, end };
}

/**
 * Resolves the authorized Building scope, failing closed.
 *
 * An explicit `buildingId` must exist AND be accessible, and then becomes the entire scope.
 * Otherwise the scope is exactly the Buildings the caller can access. Scope is never inferred
 * from anything the caller supplies other than `buildingId`, and never from
 * `scheduleDefinitionId`, `generatedTaskId` or a binding id. A NULL-building generated task is
 * never re-admitted through a client scope.
 */
async function resolveScope(
  filters: ScheduledOperationLineageFilters,
  userId: string,
): Promise<{ start: Date | null; end: Date | null; buildingIds: string[] }> {
  const range = scheduledOperationLineageRange(filters);

  if (filters.buildingId) {
    const building = await buildingRepository.findById(filters.buildingId);
    if (!building) {
      throw buildingNotFoundError();
    }
    await contextAccessService.assertBuildingAccess(userId, filters.buildingId);
    return { start: range.start, end: range.end, buildingIds: [filters.buildingId] };
  }

  const buildingIds = await contextAccessService.getAccessibleBuildingIds(userId);
  return { start: range.start, end: range.end, buildingIds };
}

/**
 * Reads the Scheduled Operation Lineage model for one caller.
 *
 * Calls the PART 09 repository exactly once, and not at all when the authorized scope is
 * empty.
 */
export async function getScheduledOperationLineage(
  filters: ScheduledOperationLineageFilters,
  userId: string,
): Promise<PublicScheduledOperationLineage> {
  const { start, end, buildingIds } = await resolveScope(filters, userId);

  // ONE instant per call, published as envelope metadata only. The PART 09 repository takes
  // no instant and derives no current-time fact, so this is never passed to it and no missed,
  // overdue, lateness or elapsed value is computed from it.
  const asOf = new Date();

  const base = {
    buildingId: filters.buildingId ?? null,
    // The authorized/narrowed scope actually supplied to the repository — never derived from
    // the rows that came back.
    buildingScope: buildingIds,
    dateFrom: filters.dateFrom ?? null,
    dateTo: filters.dateTo ?? null,
    asOf: asOf.toISOString(),
  };

  // Fail closed: no accessible Buildings yields a well-formed empty envelope rather than a
  // 403, an empty ANY(...) array, a widened scope or a null envelope.
  if (buildingIds.length === 0) {
    return { ...base, rows: [] };
  }

  const rows = await getScheduledOperationLineageRows(buildingIds, filters, start, end);

  // Rows are the repository's output verbatim: no post-filtering, no collapsing or
  // deduplication by schedule/task/binding/assignment, no merged execution identifier, no
  // assignment selection, no executor inference and no business re-sorting here.
  return { ...base, rows };
}

function readOptionalDate(
  raw: string,
  field: string,
  details: ValidationDetail[],
): Date | undefined {
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    details.push({
      field,
      message: `${field} must be a valid ISO-8601 date or datetime.`,
    });
    return undefined;
  }
  return parsed;
}

function readOptionalUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  const raw = readSingleParam(value);
  if (raw === undefined || raw === '') {
    return undefined;
  }
  if (!isValidUuid(raw.trim())) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return raw.trim().toLowerCase();
}

/**
 * Normalizes an enum filter to upper case and validates it against the vocabulary's OWN
 * authority. Generic over the guard so the parsed value keeps its literal type and no cast
 * is needed where the filter object is built.
 */
function readOptionalEnum<T extends string>(
  value: unknown,
  field: string,
  isValid: (candidate: unknown) => candidate is T,
  message: string,
  details: ValidationDetail[],
): T | undefined {
  const raw = readSingleParam(value);
  if (raw === undefined || raw === '') {
    return undefined;
  }
  const normalized = raw.trim().toUpperCase();
  if (!isValid(normalized)) {
    details.push({ field, message });
    return undefined;
  }
  return normalized;
}

function readSingleParam(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return undefined;
  }
  return String(value);
}

export const scheduledOperationLineageService = {
  getScheduledOperationLineage,
  parseScheduledOperationLineageQuery,
  scheduledOperationLineageRange,
};
