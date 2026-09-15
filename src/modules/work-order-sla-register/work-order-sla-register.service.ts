import { AppError } from '../../shared/errors';
import type { SlaClockStatus, SlaClockType } from '../applied-slas/applied-sla.types';
import { buildingNotFoundError, buildingRepository } from '../buildings';
import { isValidUuid } from '../clients';
import { contextAccessService } from '../context-access';
import {
  SLA_ESCALATION_ACTION_STATUSES,
  type SlaEscalationActionStatus,
} from '../sla-escalation-actions/sla-escalation-action.types';
import { getWorkOrderSlaRegisterRows } from './work-order-sla-register.repository';
import type {
  PublicWorkOrderSlaRegister,
  WorkOrderSlaRegisterFilters,
} from './work-order-sla-register.types';

/**
 * R10 PART 07 — Work Order SLA Register service.
 *
 * Read-only. Internal backend read contract for Reporting consumption; there is
 * deliberately no HTTP endpoint, route, controller, Reporting dataset enum entry,
 * registry adapter or OpenAPI surface in this PART.
 *
 * PERMISSION — the authoritative read permission for this register is the EXISTING
 * `work_order.read`, already seeded in `foundation-access.seed` and already used for
 * Work Order reporting and SLA reads elsewhere (the Reporting export registry's
 * WORK_ORDER_REGISTER adapter, `applied-sla.routes` for `/work-orders/:id/sla`, and
 * `sla-escalation-action.routes`). No new permission is created here. Consistent with
 * the sibling register services, enforcement is a route/registry-layer concern, so
 * this service takes the authenticated `userId` and applies the shared context-access
 * pattern instead of declaring its own gate.
 *
 * WHAT THIS SERVICE OWNS — caller filter parsing and validation, authorized
 * building-scope resolution, the optional explicit `buildingId` access assertion,
 * date-window normalization, ONE frozen `asOf` instant, a single repository call and
 * public envelope construction.
 *
 * WHAT IT DELIBERATELY DOES NOT OWN — no SLA policy decision, no breach derivation,
 * no pause business rule, no escalation transition, no KPI logic and no synthetic
 * status. The PART 06 repository remains the row read-model authority: rows are
 * returned exactly as it produced them, never post-filtered, recomputed, collapsed
 * per Work Order or re-sorted for business meaning.
 *
 * SCOPE — mirrors the sibling Work Order / Vendor Service / Finding registers and the
 * BE-23H read-model behaviour. An explicit `buildingId` is existence-checked and
 * access-asserted, and the repository scope becomes exactly that one Building. An
 * omitted `buildingId` rolls the register up across exactly the Buildings the caller
 * can reach. An empty authorized scope returns a well-formed empty register WITHOUT
 * querying, so cross-Building and cross-Client leakage is impossible and an empty
 * `ANY(...)` array is never sent to PostgreSQL.
 *
 * `buildingId` is therefore BOTH an access assertion and a narrowing filter, never a
 * cosmetic one. Every other identifier narrows only: `workOrderId` in particular can
 * never create or widen Building authority, because it is applied by the repository
 * strictly inside the already-authorized `applied_slas.building_id` scope.
 *
 * CLIENT SCOPE — no caller-provided `clientId` is accepted as a scope override, and
 * none is part of the PART 06 filter contract. Client scope stays inherited from the
 * authenticated context and from the repository's structurally-scoped rows.
 *
 * FILTERS — exactly the twelve frozen by PART 06. Unknown query parameters are not
 * forwarded: the returned object is constructed key by key, so anything unrecognized
 * is dropped rather than reaching the repository, which is the sibling registers'
 * strict-by-construction parser behaviour. Enum filters are validated against the
 * vocabularies' own runtime authorities and normalized to upper case, never
 * reinterpreted. No `page`, `limit`, `offset`, `sort`, `search`, `operationalType`,
 * `approachingBreach`, `severity` or `daysOverdue` parameter exists.
 *
 * DATE WINDOW — UTC half-open `[dateFrom, dateTo)` over `applied_slas.applied_at`;
 * the repository owns the SQL predicate and this service only validates and
 * normalizes. Invalid dates are rejected, `dateFrom` must be strictly earlier than
 * `dateTo`, the two are never silently swapped, and no default reporting period is
 * invented. A date-only `dateTo` is inclusive of that whole UTC day. No maximum-range
 * cap is added, because PART 07 freezes no such rule for this register.
 *
 * AS-OF — exactly one `asOf` instant is created per call and the SAME instant is
 * handed to the repository and published as `envelope.asOf`. This is required because
 * `isPaused`, `pauseCount`, `totalPausedMilliseconds` and
 * `effectiveElapsedMilliseconds` are CURRENT-ONLY read-time facts: every row of one
 * load must describe one instant, and the envelope must state truthfully which one.
 */

export type ValidationDetail = {
  field: string;
  message: string;
};

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The owning domain publishes the clock vocabularies as TYPES only — there is no
 * runtime `SlaClockType` / `SlaClockStatus` authority to import. These minimal guards
 * are typed against that authority so they cannot drift silently, following the R08
 * `EXECUTION_REVIEW_CHILD_STATUSES` precedent.
 *
 * `SLA_ESCALATION_CLOCK_TYPES` is deliberately NOT reused for `clockType`: it is the
 * escalation-POLICY matching vocabulary and additionally contains `'ANY'`, which can
 * never be a persisted `sla_clocks.clock_type`.
 */
const CLOCK_TYPES: readonly SlaClockType[] = ['RESPONSE', 'RESOLUTION'];
const CLOCK_STATUSES: readonly SlaClockStatus[] = ['RUNNING', 'SATISFIED', 'TERMINATED'];

function isSlaClockType(value: unknown): value is SlaClockType {
  return typeof value === 'string' && (CLOCK_TYPES as readonly string[]).includes(value);
}

function isSlaClockStatus(value: unknown): value is SlaClockStatus {
  return typeof value === 'string' && (CLOCK_STATUSES as readonly string[]).includes(value);
}

/** Reuses the escalation ledger's OWN runtime authority; nothing is restated. */
function isSlaEscalationActionStatus(value: unknown): value is SlaEscalationActionStatus {
  return (
    typeof value === 'string' &&
    (SLA_ESCALATION_ACTION_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Parses and validates caller query input into the frozen PART 06 filter contract.
 *
 * Only the twelve frozen filters are read, and the result is built key by key, so an
 * unknown parameter can never reach the repository.
 */
export function parseWorkOrderSlaRegisterQuery(
  query: Record<string, unknown>,
): WorkOrderSlaRegisterFilters {
  const details: ValidationDetail[] = [];

  const buildingId = readOptionalUuid(query.buildingId, 'buildingId', details);
  const workOrderId = readOptionalUuid(query.workOrderId, 'workOrderId', details);

  const clockType = readOptionalEnum(
    query.clockType,
    'clockType',
    isSlaClockType,
    `clockType must be one of: ${CLOCK_TYPES.join(', ')}.`,
    details,
  );
  const clockStatus = readOptionalEnum(
    query.clockStatus,
    'clockStatus',
    isSlaClockStatus,
    `clockStatus must be one of: ${CLOCK_STATUSES.join(', ')}.`,
    details,
  );
  const escalationStatus = readOptionalEnum(
    query.escalationStatus,
    'escalationStatus',
    isSlaEscalationActionStatus,
    `escalationStatus must be one of: ${SLA_ESCALATION_ACTION_STATUSES.join(', ')}.`,
    details,
  );

  // Boolean filters accept only true/false, per the Reporting query convention
  // (workforce-reporting `readBoolean`): a real boolean arrives as 'true'/'false'
  // through readSingleParam, and anything else is a validation error rather than a
  // silent coercion.
  const breached = readOptionalBoolean(query.breached, 'breached', details);
  const paused = readOptionalBoolean(query.paused, 'paused', details);

  // Free-text narrowing over the applied-SLA snapshot columns. Validated as strings
  // rather than against the live Work Order enums on purpose: PART 06 filters the
  // immutable `applied_slas.work_order_work_type` / `work_order_priority` snapshot,
  // not the live `work_orders` columns, so a legacy snapshot value must stay
  // filterable. Both narrow only, strictly inside the authorized Building scope.
  const definitionCode = readSingleParam(query.definitionCode);
  const workType = readSingleParam(query.workType);
  const priority = readSingleParam(query.priority);

  const dateFromRaw = readSingleParam(query.dateFrom);
  const dateToRaw = readSingleParam(query.dateTo);
  const dateFrom = dateFromRaw
    ? readOptionalDate(dateFromRaw, 'dateFrom', details)
    : undefined;
  const dateTo = dateToRaw ? readOptionalDate(dateToRaw, 'dateTo', details) : undefined;

  // The window is half-open, so an equal or reversed pair is rejected rather than
  // silently swapped or quietly widened into an inclusive range.
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
    ...(workOrderId === undefined ? {} : { workOrderId }),
    ...(clockType === undefined ? {} : { clockType }),
    ...(clockStatus === undefined ? {} : { clockStatus }),
    ...(breached === undefined ? {} : { breached }),
    ...(paused === undefined ? {} : { paused }),
    ...(escalationStatus === undefined ? {} : { escalationStatus }),
    ...(definitionCode ? { definitionCode: definitionCode.trim() } : {}),
    ...(workType ? { workType: workType.trim() } : {}),
    ...(priority ? { priority: priority.trim() } : {}),
    ...(dateFromRaw ? { dateFrom: dateFromRaw.trim() } : {}),
    ...(dateToRaw ? { dateTo: dateToRaw.trim() } : {}),
  };
}

/**
 * Converts the register window into a half-open `[start, end)` range over
 * `applied_slas.applied_at`. A date-only `dateTo` is inclusive of that whole UTC day.
 * Mirrors `workOrderRegisterRange` / `vendorServiceRegisterRange` and BE-23H.
 */
export function workOrderSlaRegisterRange(filters: WorkOrderSlaRegisterFilters): {
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
 * An explicit `buildingId` must exist AND be accessible, and then becomes the entire
 * scope. Otherwise the scope is exactly the Buildings the caller can access. Scope is
 * never inferred from anything the caller supplies other than `buildingId`, and never
 * from `workOrderId`.
 */
async function resolveScope(
  filters: WorkOrderSlaRegisterFilters,
  userId: string,
): Promise<{ start: Date | null; end: Date | null; buildingIds: string[] }> {
  const range = workOrderSlaRegisterRange(filters);

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
 * Reads the Work Order SLA Register for one caller.
 *
 * Calls the PART 06 repository exactly once, and not at all when the authorized scope
 * is empty.
 */
export async function getWorkOrderSlaRegister(
  filters: WorkOrderSlaRegisterFilters,
  userId: string,
): Promise<PublicWorkOrderSlaRegister> {
  const { start, end, buildingIds } = await resolveScope(filters, userId);

  // ONE frozen read-time instant for the whole call. The repository receives this
  // exact Date and the envelope publishes this exact ISO string, so the four
  // CURRENT-ONLY fields describe one instant and `asOf` never lies about which.
  const asOf = new Date();

  const base = {
    buildingId: filters.buildingId ?? null,
    // The authorized/narrowed scope actually used for this read — never inferred from
    // the rows that came back.
    buildingScope: buildingIds,
    dateFrom: filters.dateFrom ?? null,
    dateTo: filters.dateTo ?? null,
    asOf: asOf.toISOString(),
  };

  // Fail closed: no accessible Buildings yields a well-formed empty register rather
  // than a 403, an empty ANY(...) array, a widened scope or a null envelope.
  if (buildingIds.length === 0) {
    return { ...base, rows: [] };
  }

  const rows = await getWorkOrderSlaRegisterRows(buildingIds, filters, start, end, asOf);

  // Rows are the repository's output verbatim: no post-filtering, no SLA
  // recomputation, no clock collapsing and no business re-sorting here.
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

function readOptionalEnum(
  value: unknown,
  field: string,
  isValid: (candidate: unknown) => boolean,
  message: string,
  details: ValidationDetail[],
): string | undefined {
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

/**
 * Accepts only true/false. Follows the Reporting query convention
 * (`workforce-reporting.readBoolean`): HTTP query values arrive as strings, so
 * `'true'`/`'false'` are the wire forms of the real booleans, and every other value
 * is rejected rather than coerced.
 */
function readOptionalBoolean(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): boolean | undefined {
  const raw = readSingleParam(value);
  if (raw === undefined || raw === '') {
    return undefined;
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  details.push({ field, message: `${field} must be true or false.` });
  return undefined;
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

export const workOrderSlaRegisterService = {
  getWorkOrderSlaRegister,
  parseWorkOrderSlaRegisterQuery,
  workOrderSlaRegisterRange,
};
