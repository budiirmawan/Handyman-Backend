import { AppError } from '../../shared/errors';
import { contextAccessService } from '../context-access';
import { buildingAccessDeniedError } from '../context-access/context-access.errors';
import {
  resolveRoomBuildingId,
  spaceNotFoundError,
  spaceRepository,
} from '../spaces';
import type { SpaceRecord } from '../spaces';
import {
  tenantCompanyNotFoundError,
  tenantCompanyRepository,
} from '../tenant-companies';
import type { TenantCompanyRecord } from '../tenant-companies';
import { tenantSpaceRepository } from '../tenant-spaces';
import { utilityMeterNotFoundError } from '../utility-meters/utility-meter.errors';
import { utilityMeterRepository } from '../utility-meters/utility-meter.repository';
import type { UtilityMeterRecord } from '../utility-meters/utility-meter.types';
import {
  utilityMeterTenantAssignmentAlreadyExistsError,
  utilityMeterTenantAssignmentNotFoundError,
  utilityMeterTenantClientMismatchError,
  utilityMeterTenantContextUnavailableError,
  utilityMeterTenantSpaceMismatchError,
} from './utility-meter-tenant.errors';
import { utilityMeterTenantRepository } from './utility-meter-tenant.repository';
import type {
  AssignMeterToTenantInput,
  NewUtilityMeterTenantAssignment,
  PublicUtilityMeterTenantAssignment,
  TenantAssignmentMeterSummary,
  TenantAssignmentSpaceSummary,
  TenantAssignmentTenantSummary,
  UpdateUtilityMeterTenantAssignmentInput,
  UtilityMeterTenantAssignmentFilters,
  UtilityMeterTenantAssignmentRecord,
} from './utility-meter-tenant.types';

/**
 * BE-18D — Tenant Meter service.
 *
 * Binds an existing BE-18A Meter to an existing BE-14A Tenant Company at an
 * existing BE-04 Space. There is no separate Tenant Meter master: a tenant
 * meter is simply a Meter with a live tenant assignment.
 *
 * Authorities reused, never re-derived:
 *   - Meter identity and its Building        → BE-18A `utility_meters`
 *   - Tenant Company and its Client          → BE-14A `tenant_companies`
 *   - Which Tenant occupies which Space      → BE-14C `tenant_space_relationships`
 *   - Space → Room → ... → Building          → BE-04 hierarchy
 *   - Main/Sub hierarchy                     → BE-18C (never touched here)
 *
 * BE-18B utility configuration stays opt-in and is never consulted. No
 * reading, consumption, or billing logic lives here.
 *
 * Isolation: `clientId` / `buildingId` are derived from the Meter, never
 * accepted from the caller, and every operation asserts the actor's explicit
 * BE-02G Building access.
 */

function meterSummary(record: UtilityMeterRecord): TenantAssignmentMeterSummary {
  return {
    id: record.id,
    code: record.code,
    name: record.name,
    utilityType: record.utilityType,
    uomId: record.uomId,
    buildingId: record.buildingId,
    status: record.status,
  };
}

function tenantSummary(
  record: TenantCompanyRecord,
): TenantAssignmentTenantSummary {
  return {
    id: record.id,
    tenantCode: record.tenantCode,
    tenantName: record.tenantName,
    status: record.status,
  };
}

function spaceSummary(record: SpaceRecord): TenantAssignmentSpaceSummary {
  return {
    id: record.id,
    code: record.code,
    name: record.name,
    status: record.status,
  };
}

type AssignmentContext = {
  meter?: UtilityMeterRecord | null;
  tenantCompany?: TenantCompanyRecord | null;
  space?: SpaceRecord | null;
};

export function toPublicUtilityMeterTenantAssignment(
  record: UtilityMeterTenantAssignmentRecord,
  context: AssignmentContext = {},
): PublicUtilityMeterTenantAssignment {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    meterId: record.meterId,
    tenantCompanyId: record.tenantCompanyId,
    spaceId: record.spaceId,
    effectiveFrom: record.effectiveFrom
      ? record.effectiveFrom.toISOString()
      : null,
    effectiveUntil: record.effectiveUntil
      ? record.effectiveUntil.toISOString()
      : null,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    ...(context.meter === undefined
      ? {}
      : { meter: context.meter ? meterSummary(context.meter) : null }),
    ...(context.tenantCompany === undefined
      ? {}
      : {
          tenantCompany: context.tenantCompany
            ? tenantSummary(context.tenantCompany)
            : null,
        }),
    ...(context.space === undefined
      ? {}
      : { space: context.space ? spaceSummary(context.space) : null }),
  };
}

/** BE-02G — an actor may only operate inside an explicitly assigned Building. */
async function assertBuildingAccess(
  actorUserId: string | undefined,
  buildingId: string,
): Promise<void> {
  if (!actorUserId) {
    return;
  }
  if (!(await contextAccessService.canAccessBuilding(actorUserId, buildingId))) {
    throw buildingAccessDeniedError();
  }
}

async function assertClientAccess(
  actorUserId: string | undefined,
  clientId: string,
): Promise<void> {
  if (!actorUserId) {
    return;
  }
  if (!(await contextAccessService.canAccessClient(actorUserId, clientId))) {
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
 * Cross-validates the Meter / Tenant / Space triple.
 *
 * Order is deliberate and is what the focused tests pin down:
 *   1. unknown Meter                → 404 UTILITY_METER_NOT_FOUND
 *   2. no Building access           → 403 BUILDING_ACCESS_DENIED
 *   3. unknown Tenant Company       → 404 TENANT_COMPANY_NOT_FOUND
 *   4. Tenant of another Client     → 400 CLIENT_MISMATCH (before any state
 *                                         check, so a foreign Client's data
 *                                         is never observable)
 *   5. unknown Space                → 404 SPACE_NOT_FOUND
 *   6. Space in another Building    → 400 SPACE_MISMATCH
 *   7. Space not leased by Tenant   → 400 SPACE_MISMATCH (BE-14C authority)
 *   8. inactive meter/tenant/space  → 400 CONTEXT_UNAVAILABLE (ACTIVE only)
 */
async function assertAssignable(
  meter: UtilityMeterRecord,
  tenantCompanyId: string,
  spaceId: string,
  willBeActive: boolean,
): Promise<{ tenantCompany: TenantCompanyRecord; space: SpaceRecord }> {
  const tenantCompany = await tenantCompanyRepository.findById(tenantCompanyId);
  if (!tenantCompany) {
    throw tenantCompanyNotFoundError();
  }
  if (tenantCompany.clientId !== meter.clientId) {
    throw utilityMeterTenantClientMismatchError();
  }

  const space = await spaceRepository.findById(spaceId);
  if (!space) {
    throw spaceNotFoundError();
  }

  const spaceBuildingId = await resolveRoomBuildingId(space.roomId);
  if (spaceBuildingId !== meter.buildingId) {
    throw utilityMeterTenantSpaceMismatchError();
  }

  // BE-14C is the authority on who occupies a Space. A meter may only be
  // assigned to a tenant at a space that tenant actually leases — otherwise
  // BE-18D would silently invent a tenancy that BE-14 never recorded.
  const tenancy = await tenantSpaceRepository.findActiveByTenantBuildingAndSpace(
    tenantCompanyId,
    meter.buildingId,
    spaceId,
  );
  if (!tenancy) {
    throw utilityMeterTenantSpaceMismatchError(
      'The space is not currently leased by this tenant company.',
    );
  }

  if (willBeActive) {
    if (meter.status !== 'ACTIVE') {
      throw utilityMeterTenantContextUnavailableError(
        'Inactive meters cannot be assigned to a tenant.',
      );
    }
    if (tenantCompany.status !== 'ACTIVE') {
      throw utilityMeterTenantContextUnavailableError(
        'Inactive tenant companies cannot be assigned a meter.',
      );
    }
    if (space.status !== 'ACTIVE') {
      throw utilityMeterTenantContextUnavailableError(
        'Inactive spaces cannot be assigned a meter.',
      );
    }
  }

  return { tenantCompany, space };
}

/**
 * Assigns a Meter to a Tenant Company at a Space.
 *
 * A Meter has at most one ACTIVE tenant assignment; re-assigning it requires
 * ending the current one first, so the previous row stays in history rather
 * than being overwritten.
 */
export async function assignMeterToTenant(
  input: AssignMeterToTenantInput,
  actorUserId?: string,
): Promise<PublicUtilityMeterTenantAssignment> {
  const status = input.status ?? 'ACTIVE';

  const meter = await loadMeter(input.meterId);
  await assertBuildingAccess(actorUserId, meter.buildingId);

  const { tenantCompany, space } = await assertAssignable(
    meter,
    input.tenantCompanyId,
    input.spaceId,
    status === 'ACTIVE',
  );

  const effectiveFrom = input.effectiveFrom ?? null;
  const effectiveUntil = input.effectiveUntil ?? null;
  assertEffectiveOrder(effectiveFrom, effectiveUntil);

  if (status === 'ACTIVE') {
    const existing = await utilityMeterTenantRepository.findActiveByMeter(
      meter.id,
    );
    if (existing) {
      throw utilityMeterTenantAssignmentAlreadyExistsError(
        existing.tenantCompanyId === input.tenantCompanyId
          ? 'This meter is already assigned to this tenant company.'
          : undefined,
      );
    }
  }

  const newAssignment: NewUtilityMeterTenantAssignment = {
    clientId: meter.clientId,
    buildingId: meter.buildingId,
    meterId: meter.id,
    tenantCompanyId: tenantCompany.id,
    spaceId: space.id,
    effectiveFrom,
    effectiveUntil,
    status,
  };

  try {
    const record = await utilityMeterTenantRepository.create(newAssignment);
    // A live tenant assignment is the authoritative declaration that this
    // physical meter serves a Tenant. Existing clients that predate the
    // explicit PART 11 purpose field remain compatible.
    if (status === 'ACTIVE' && meter.purpose !== 'TENANT') {
      await utilityMeterRepository.setPurpose(meter.id, 'TENANT');
      meter.purpose = 'TENANT';
    }
    return toPublicUtilityMeterTenantAssignment(record, {
      meter,
      tenantCompany,
      space,
    });
  } catch (error) {
    if (isActiveMeterUniqueViolation(error)) {
      throw utilityMeterTenantAssignmentAlreadyExistsError();
    }
    throw error;
  }
}

export async function getUtilityMeterTenantAssignmentById(
  id: string,
  actorUserId?: string,
): Promise<PublicUtilityMeterTenantAssignment> {
  const record = await utilityMeterTenantRepository.findById(id);
  if (!record) {
    throw utilityMeterTenantAssignmentNotFoundError();
  }
  await assertBuildingAccess(actorUserId, record.buildingId);
  return enrichOne(record);
}

/** Every assignment ever recorded for a Meter — the history view. */
export async function listAssignmentsByMeter(
  meterId: string,
  filters: UtilityMeterTenantAssignmentFilters,
  actorUserId?: string,
): Promise<PublicUtilityMeterTenantAssignment[]> {
  const meter = await loadMeter(meterId);
  await assertBuildingAccess(actorUserId, meter.buildingId);

  const records = await utilityMeterTenantRepository.listByMeter(
    meterId,
    filters,
  );
  return enrich(records);
}

/**
 * Assignments of a Tenant Company, restricted at the database level to the
 * Buildings the actor can access.
 */
export async function listAssignmentsByTenantCompany(
  tenantCompanyId: string,
  filters: UtilityMeterTenantAssignmentFilters,
  actorUserId?: string,
): Promise<PublicUtilityMeterTenantAssignment[]> {
  const tenantCompany = await tenantCompanyRepository.findById(tenantCompanyId);
  if (!tenantCompany) {
    throw tenantCompanyNotFoundError();
  }
  await assertClientAccess(actorUserId, tenantCompany.clientId);

  const buildingIds = actorUserId
    ? await contextAccessService.getAccessibleBuildingIds(actorUserId)
    : null;

  const records = await utilityMeterTenantRepository.listByTenantCompany(
    tenantCompanyId,
    buildingIds,
    filters,
  );
  return enrich(records);
}

export async function listAssignmentsBySpace(
  spaceId: string,
  filters: UtilityMeterTenantAssignmentFilters,
  actorUserId?: string,
): Promise<PublicUtilityMeterTenantAssignment[]> {
  const space = await spaceRepository.findById(spaceId);
  if (!space) {
    throw spaceNotFoundError();
  }
  const buildingId = await resolveRoomBuildingId(space.roomId);
  await assertBuildingAccess(actorUserId, buildingId);

  const records = await utilityMeterTenantRepository.listBySpace(
    spaceId,
    filters,
  );
  return enrich(records);
}

/**
 * Resolves the current Tenant Meter context of a Meter.
 *
 * `null` means the Meter is currently not assigned to any tenant — a common,
 * valid state (e.g. a landlord/common-area meter), not an error.
 */
export async function resolveCurrentTenantAssignment(
  meterId: string,
  actorUserId?: string,
): Promise<PublicUtilityMeterTenantAssignment | null> {
  const meter = await loadMeter(meterId);
  await assertBuildingAccess(actorUserId, meter.buildingId);

  const record = await utilityMeterTenantRepository.findActiveByMeter(meterId);
  if (!record) {
    return null;
  }
  return enrichOne(record, meter);
}

/**
 * Updates an assignment: adjust its effective window, end it, or re-activate
 * it. The Meter / Tenant / Space triple is immutable (enforced in validation).
 */
export async function updateUtilityMeterTenantAssignment(
  id: string,
  input: UpdateUtilityMeterTenantAssignmentInput,
  actorUserId?: string,
): Promise<PublicUtilityMeterTenantAssignment> {
  const existing = await utilityMeterTenantRepository.findById(id);
  if (!existing) {
    throw utilityMeterTenantAssignmentNotFoundError();
  }
  await assertBuildingAccess(actorUserId, existing.buildingId);

  const nextStatus = input.status ?? existing.status;

  // Ending an ACTIVE assignment without an explicit date closes the window
  // now, matching the BE-14C tenant/space convention.
  const effectiveInput: UpdateUtilityMeterTenantAssignmentInput = { ...input };
  if (
    nextStatus === 'INACTIVE' &&
    existing.status === 'ACTIVE' &&
    input.effectiveUntil === undefined
  ) {
    effectiveInput.effectiveUntil = new Date();
  }

  // Re-activating a superseded assignment must re-run every rule — the
  // tenancy may have ended while it was inactive.
  if (nextStatus === 'ACTIVE' && existing.status !== 'ACTIVE') {
    const meter = await loadMeter(existing.meterId);
    await assertAssignable(
      meter,
      existing.tenantCompanyId,
      existing.spaceId,
      true,
    );

    const active = await utilityMeterTenantRepository.findActiveByMeter(
      existing.meterId,
    );
    if (active && active.id !== existing.id) {
      throw utilityMeterTenantAssignmentAlreadyExistsError();
    }
  }

  // Merge against the stored record so a partial update cannot produce an
  // invalid window.
  const effectiveFrom =
    effectiveInput.effectiveFrom === undefined
      ? existing.effectiveFrom
      : effectiveInput.effectiveFrom;
  const effectiveUntil =
    effectiveInput.effectiveUntil === undefined
      ? existing.effectiveUntil
      : effectiveInput.effectiveUntil;
  assertEffectiveOrder(effectiveFrom, effectiveUntil);

  try {
    const record = await utilityMeterTenantRepository.update(id, effectiveInput);
    if (!record) {
      throw utilityMeterTenantAssignmentNotFoundError();
    }
    return enrichOne(record);
  } catch (error) {
    if (isActiveMeterUniqueViolation(error)) {
      throw utilityMeterTenantAssignmentAlreadyExistsError();
    }
    throw error;
  }
}

/**
 * Ends an assignment. The row is retained as history — BE-18D never hard
 * deletes a tenant assignment.
 */
export async function endUtilityMeterTenantAssignment(
  id: string,
  input: UpdateUtilityMeterTenantAssignmentInput = {},
  actorUserId?: string,
): Promise<PublicUtilityMeterTenantAssignment> {
  return updateUtilityMeterTenantAssignment(
    id,
    { ...input, status: 'INACTIVE' },
    actorUserId,
  );
}

async function enrichOne(
  record: UtilityMeterTenantAssignmentRecord,
  knownMeter?: UtilityMeterRecord,
): Promise<PublicUtilityMeterTenantAssignment> {
  const [meter, tenantCompany, space] = await Promise.all([
    knownMeter
      ? Promise.resolve(knownMeter)
      : utilityMeterRepository.findById(record.meterId),
    tenantCompanyRepository.findById(record.tenantCompanyId),
    spaceRepository.findById(record.spaceId),
  ]);
  return toPublicUtilityMeterTenantAssignment(record, {
    meter,
    tenantCompany,
    space,
  });
}

/** Batch-loads reference context for a list of assignments. */
async function enrich(
  records: readonly UtilityMeterTenantAssignmentRecord[],
): Promise<PublicUtilityMeterTenantAssignment[]> {
  if (records.length === 0) {
    return [];
  }

  const meters = new Map<string, UtilityMeterRecord>();
  const tenants = new Map<string, TenantCompanyRecord>();
  const spaces = new Map<string, SpaceRecord>();

  for (const id of new Set(records.map((record) => record.meterId))) {
    const meter = await utilityMeterRepository.findById(id);
    if (meter) {
      meters.set(id, meter);
    }
  }
  for (const id of new Set(records.map((record) => record.tenantCompanyId))) {
    const tenant = await tenantCompanyRepository.findById(id);
    if (tenant) {
      tenants.set(id, tenant);
    }
  }
  for (const id of new Set(records.map((record) => record.spaceId))) {
    const space = await spaceRepository.findById(id);
    if (space) {
      spaces.set(id, space);
    }
  }

  return records.map((record) =>
    toPublicUtilityMeterTenantAssignment(record, {
      meter: meters.get(record.meterId) ?? null,
      tenantCompany: tenants.get(record.tenantCompanyId) ?? null,
      space: spaces.get(record.spaceId) ?? null,
    }),
  );
}

/**
 * PostgreSQL unique-violation on the partial ACTIVE index — the race-condition
 * backstop behind the explicit duplicate pre-check.
 */
function isActiveMeterUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint ===
      'utility_meter_tenant_assignments_active_meter_unique'
  );
}

export const utilityMeterTenantService = {
  assignMeterToTenant,
  endUtilityMeterTenantAssignment,
  getUtilityMeterTenantAssignmentById,
  listAssignmentsByMeter,
  listAssignmentsBySpace,
  listAssignmentsByTenantCompany,
  resolveCurrentTenantAssignment,
  toPublicUtilityMeterTenantAssignment,
  updateUtilityMeterTenantAssignment,
};
