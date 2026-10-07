import { AppError } from '../../shared/errors';
import { contextAccessService } from '../context-access';
import { buildingAccessDeniedError } from '../context-access/context-access.errors';
import {
  utilityMeterInactiveError,
  utilityMeterNotFoundError,
} from '../utility-meters/utility-meter.errors';
import { utilityMeterRepository } from '../utility-meters/utility-meter.repository';
import type { UtilityMeterRecord } from '../utility-meters/utility-meter.types';
import {
  utilityMeterHierarchyAlreadyExistsError,
  utilityMeterHierarchyBuildingMismatchError,
  utilityMeterHierarchyCircularError,
  utilityMeterHierarchyClientMismatchError,
  utilityMeterHierarchyNotFoundError,
  utilityMeterHierarchySelfReferenceError,
  utilityMeterHierarchyUtilityMismatchError,
} from './utility-meter-hierarchy.errors';
import { utilityMeterHierarchyRepository } from './utility-meter-hierarchy.repository';
import type {
  BindSubMeterInput,
  HierarchyMeterSummary,
  NewUtilityMeterHierarchy,
  PublicUtilityMeterHierarchy,
  UpdateUtilityMeterHierarchyInput,
  UtilityMeterHierarchyFilters,
  UtilityMeterHierarchyRecord,
} from './utility-meter-hierarchy.types';

/**
 * BE-18C — Main / Sub Meter hierarchy service.
 *
 * Owns only the relationship between two existing BE-18A Meters. It creates
 * no meters, copies no meter attributes, and computes nothing: no
 * aggregation, netting, allocation, reading or consumption logic lives here
 * (BE-18E / BE-18G own those later).
 *
 * BE-18B utility configuration stays opt-in — this part never requires a
 * Client to have configured a utility type. Compatibility is judged from the
 * two Meters' own `utilityType` values, which BE-18A already guarantees.
 *
 * Isolation: `clientId` is derived from the Meters, never accepted from the
 * caller, and every operation asserts the actor's explicit BE-02G Building
 * access to the Meters involved.
 */

function toSummary(record: UtilityMeterRecord): HierarchyMeterSummary {
  return {
    id: record.id,
    code: record.code,
    name: record.name,
    utilityType: record.utilityType,
    buildingId: record.buildingId,
    status: record.status,
  };
}

export function toPublicUtilityMeterHierarchy(
  record: UtilityMeterHierarchyRecord,
  meters: {
    mainMeter?: UtilityMeterRecord | null;
    subMeter?: UtilityMeterRecord | null;
  } = {},
): PublicUtilityMeterHierarchy {
  return {
    id: record.id,
    clientId: record.clientId,
    mainMeterId: record.mainMeterId,
    subMeterId: record.subMeterId,
    effectiveFrom: record.effectiveFrom
      ? record.effectiveFrom.toISOString()
      : null,
    effectiveUntil: record.effectiveUntil
      ? record.effectiveUntil.toISOString()
      : null,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    ...(meters.mainMeter === undefined
      ? {}
      : { mainMeter: meters.mainMeter ? toSummary(meters.mainMeter) : null }),
    ...(meters.subMeter === undefined
      ? {}
      : { subMeter: meters.subMeter ? toSummary(meters.subMeter) : null }),
  };
}

/** BE-02G — an actor may only operate inside an explicitly assigned Building. */
async function assertMeterAccess(
  actorUserId: string | undefined,
  meter: UtilityMeterRecord,
): Promise<void> {
  if (!actorUserId) {
    return;
  }
  if (
    !(await contextAccessService.canAccessBuilding(actorUserId, meter.buildingId))
  ) {
    throw buildingAccessDeniedError();
  }
}

async function loadMeter(id: string): Promise<UtilityMeterRecord> {
  const meter = await utilityMeterRepository.findById(id);
  if (!meter) {
    throw utilityMeterNotFoundError();
  }
  return meter;
}

function assertEffectiveOrder(
  effectiveFrom: Date | null,
  effectiveUntil: Date | null,
): void {
  if (
    effectiveFrom !== null &&
    effectiveUntil !== null &&
    effectiveUntil < effectiveFrom
  ) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'effectiveUntil',
        message: 'effectiveUntil must be the same as or after effectiveFrom.',
      },
    ]);
  }
}

/**
 * Cross-validates both sides of a proposed binding.
 *
 * Order is deliberate and is what the focused tests pin down:
 *   1. unknown Main / Sub Meter    → 404 UTILITY_METER_NOT_FOUND
 *   2. self-reference              → 400 (cheap, id-only)
 *   3. no Building access          → 403 BUILDING_ACCESS_DENIED
 *   4. cross-Client pair           → 400 CLIENT_MISMATCH (before any state
 *                                        check, so a foreign Client's meter
 *                                        state is never observable)
 *   5. cross-Building pair         → 400 BUILDING_MISMATCH
 *   6. utility type mismatch       → 400 UTILITY_MISMATCH
 *   7. INACTIVE meter              → 400  (only when the result would be ACTIVE)
 *   8. circular hierarchy          → 400  (only when the result would be ACTIVE)
 */
async function assertBindable(
  mainMeter: UtilityMeterRecord,
  subMeter: UtilityMeterRecord,
  willBeActive: boolean,
): Promise<void> {
  if (mainMeter.id === subMeter.id) {
    throw utilityMeterHierarchySelfReferenceError();
  }

  if (mainMeter.clientId !== subMeter.clientId) {
    throw utilityMeterHierarchyClientMismatchError();
  }

  // A Meter belongs to exactly one Building (BE-18A), and a physical feed
  // does not cross buildings. Cross-building aggregation, if it is ever
  // needed, is a reporting concern rather than a meter relationship.
  if (mainMeter.buildingId !== subMeter.buildingId) {
    throw utilityMeterHierarchyBuildingMismatchError();
  }

  if (mainMeter.utilityType !== subMeter.utilityType) {
    throw utilityMeterHierarchyUtilityMismatchError();
  }

  if (!willBeActive) {
    return;
  }

  if (mainMeter.status !== 'ACTIVE') {
    throw utilityMeterInactiveError(
      'Inactive meters cannot be used as a main meter.',
    );
  }
  if (subMeter.status !== 'ACTIVE') {
    throw utilityMeterInactiveError(
      'Inactive meters cannot be bound as a sub meter.',
    );
  }

  // Walk the proposed Main Meter's ACTIVE ancestor chain. If the Sub Meter is
  // anywhere above it, the binding would close a loop — this catches the
  // direct A → B / B → A case and any deeper A → B → C → A cycle.
  const ancestorIds =
    await utilityMeterHierarchyRepository.listActiveAncestorIds(mainMeter.id);
  if (ancestorIds.includes(subMeter.id)) {
    throw utilityMeterHierarchyCircularError();
  }
}

/**
 * Binds a Sub Meter to a Main Meter.
 *
 * A Sub Meter has at most one ACTIVE Main Meter; re-binding it elsewhere
 * requires ending the current relationship first, so the previous row stays
 * in history rather than being overwritten.
 */
export async function bindSubMeter(
  input: BindSubMeterInput,
  actorUserId?: string,
): Promise<PublicUtilityMeterHierarchy> {
  const status = input.status ?? 'ACTIVE';

  const mainMeter = await loadMeter(input.mainMeterId);
  if (input.mainMeterId === input.subMeterId) {
    throw utilityMeterHierarchySelfReferenceError();
  }
  const subMeter = await loadMeter(input.subMeterId);

  await assertMeterAccess(actorUserId, mainMeter);
  await assertMeterAccess(actorUserId, subMeter);

  await assertBindable(mainMeter, subMeter, status === 'ACTIVE');

  const effectiveFrom = input.effectiveFrom ?? null;
  const effectiveUntil = input.effectiveUntil ?? null;
  assertEffectiveOrder(effectiveFrom, effectiveUntil);

  if (status === 'ACTIVE') {
    const existing =
      await utilityMeterHierarchyRepository.findActiveBySubMeter(subMeter.id);
    if (existing) {
      throw utilityMeterHierarchyAlreadyExistsError(
        existing.mainMeterId === mainMeter.id
          ? 'This sub meter is already bound to this main meter.'
          : undefined,
      );
    }
  }

  const newHierarchy: NewUtilityMeterHierarchy = {
    clientId: subMeter.clientId,
    mainMeterId: mainMeter.id,
    subMeterId: subMeter.id,
    effectiveFrom,
    effectiveUntil,
    status,
  };

  try {
    const record = await utilityMeterHierarchyRepository.create(newHierarchy);
    return toPublicUtilityMeterHierarchy(record, { mainMeter, subMeter });
  } catch (error) {
    if (isActiveSubMeterUniqueViolation(error)) {
      throw utilityMeterHierarchyAlreadyExistsError();
    }
    throw error;
  }
}

export async function getUtilityMeterHierarchyById(
  id: string,
  actorUserId?: string,
): Promise<PublicUtilityMeterHierarchy> {
  const record = await utilityMeterHierarchyRepository.findById(id);
  if (!record) {
    throw utilityMeterHierarchyNotFoundError();
  }

  const subMeter = await loadMeter(record.subMeterId);
  await assertMeterAccess(actorUserId, subMeter);
  const mainMeter = await loadMeter(record.mainMeterId);

  return toPublicUtilityMeterHierarchy(record, { mainMeter, subMeter });
}

/** Sub Meters bound to a Main Meter, newest history last. */
export async function listSubMeters(
  mainMeterId: string,
  filters: UtilityMeterHierarchyFilters,
  actorUserId?: string,
): Promise<PublicUtilityMeterHierarchy[]> {
  const mainMeter = await loadMeter(mainMeterId);
  await assertMeterAccess(actorUserId, mainMeter);

  const records = await utilityMeterHierarchyRepository.listByMainMeter(
    mainMeterId,
    filters,
  );
  return enrich(records, mainMeter);
}

/**
 * Resolves the Main Meter of a Sub Meter.
 *
 * Returns the relationship rather than a bare id so the caller also sees its
 * status and effective window. `null` means the Sub Meter is currently a top
 * level meter — not an error.
 */
export async function resolveMainMeter(
  subMeterId: string,
  actorUserId?: string,
): Promise<PublicUtilityMeterHierarchy | null> {
  const subMeter = await loadMeter(subMeterId);
  await assertMeterAccess(actorUserId, subMeter);

  const record =
    await utilityMeterHierarchyRepository.findActiveBySubMeter(subMeterId);
  if (!record) {
    return null;
  }

  const mainMeter = await loadMeter(record.mainMeterId);
  return toPublicUtilityMeterHierarchy(record, { mainMeter, subMeter });
}

/** Every relationship ever recorded for a Sub Meter — the history view. */
export async function listSubMeterHistory(
  subMeterId: string,
  filters: UtilityMeterHierarchyFilters,
  actorUserId?: string,
): Promise<PublicUtilityMeterHierarchy[]> {
  const subMeter = await loadMeter(subMeterId);
  await assertMeterAccess(actorUserId, subMeter);

  const records = await utilityMeterHierarchyRepository.listBySubMeter(
    subMeterId,
    filters,
  );
  return enrich(records, subMeter);
}

/**
 * Updates a relationship: adjust its effective window, end it, or re-activate
 * it. The bound Meters themselves are immutable (enforced in validation).
 */
export async function updateUtilityMeterHierarchy(
  id: string,
  input: UpdateUtilityMeterHierarchyInput,
  actorUserId?: string,
): Promise<PublicUtilityMeterHierarchy> {
  const existing = await utilityMeterHierarchyRepository.findById(id);
  if (!existing) {
    throw utilityMeterHierarchyNotFoundError();
  }

  const subMeter = await loadMeter(existing.subMeterId);
  await assertMeterAccess(actorUserId, subMeter);
  const mainMeter = await loadMeter(existing.mainMeterId);

  const nextStatus = input.status ?? existing.status;

  // Re-activating a superseded relationship must re-run every rule, including
  // the cycle walk — the hierarchy may have changed while it was inactive.
  if (nextStatus === 'ACTIVE' && existing.status !== 'ACTIVE') {
    await assertBindable(mainMeter, subMeter, true);

    const active = await utilityMeterHierarchyRepository.findActiveBySubMeter(
      existing.subMeterId,
    );
    if (active && active.id !== existing.id) {
      throw utilityMeterHierarchyAlreadyExistsError();
    }
  }

  // Merge against the stored record so a partial update cannot produce an
  // invalid window (e.g. moving only effectiveUntil behind the stored
  // effectiveFrom).
  const effectiveFrom =
    input.effectiveFrom === undefined ? existing.effectiveFrom : input.effectiveFrom;
  const effectiveUntil =
    input.effectiveUntil === undefined
      ? existing.effectiveUntil
      : input.effectiveUntil;
  assertEffectiveOrder(effectiveFrom, effectiveUntil);

  try {
    const record = await utilityMeterHierarchyRepository.update(id, input);
    if (!record) {
      throw utilityMeterHierarchyNotFoundError();
    }
    return toPublicUtilityMeterHierarchy(record, { mainMeter, subMeter });
  } catch (error) {
    if (isActiveSubMeterUniqueViolation(error)) {
      throw utilityMeterHierarchyAlreadyExistsError();
    }
    throw error;
  }
}

/**
 * Ends a relationship. The row is retained as history — BE-18C never hard
 * deletes a hierarchy record.
 */
export async function endUtilityMeterHierarchy(
  id: string,
  input: UpdateUtilityMeterHierarchyInput = {},
  actorUserId?: string,
): Promise<PublicUtilityMeterHierarchy> {
  return updateUtilityMeterHierarchy(
    id,
    { ...input, status: 'INACTIVE' },
    actorUserId,
  );
}

/** Batch-loads the counterpart Meter of each relationship for presentation. */
async function enrich(
  records: readonly UtilityMeterHierarchyRecord[],
  known: UtilityMeterRecord,
): Promise<PublicUtilityMeterHierarchy[]> {
  const wanted = new Set<string>();
  for (const record of records) {
    if (record.mainMeterId !== known.id) {
      wanted.add(record.mainMeterId);
    }
    if (record.subMeterId !== known.id) {
      wanted.add(record.subMeterId);
    }
  }

  const meters = new Map<string, UtilityMeterRecord>([[known.id, known]]);
  for (const id of wanted) {
    const meter = await utilityMeterRepository.findById(id);
    if (meter) {
      meters.set(id, meter);
    }
  }

  return records.map((record) =>
    toPublicUtilityMeterHierarchy(record, {
      mainMeter: meters.get(record.mainMeterId) ?? null,
      subMeter: meters.get(record.subMeterId) ?? null,
    }),
  );
}

/**
 * PostgreSQL unique-violation on the partial ACTIVE index — the race-condition
 * backstop behind the explicit duplicate pre-check.
 */
function isActiveSubMeterUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint === 'utility_meter_hierarchies_active_sub_unique'
  );
}

export const utilityMeterHierarchyService = {
  bindSubMeter,
  endUtilityMeterHierarchy,
  getUtilityMeterHierarchyById,
  listSubMeterHistory,
  listSubMeters,
  resolveMainMeter,
  toPublicUtilityMeterHierarchy,
  updateUtilityMeterHierarchy,
};
