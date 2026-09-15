import { assetNotFoundError, assetRepository } from '../assets';
import {
  changedFieldNames,
  diffFields,
  recordAssetHistory,
} from '../asset-history';
import { AppError } from '../../shared/errors';
import {
  assetWarrantyActiveExistsError,
  assetWarrantyNotFoundError,
  assetWarrantyNumberAlreadyExistsError,
  assetWarrantyOverlapError,
  assetWarrantyStatusDateMismatchError,
} from './asset-warranty.errors';
import { assetWarrantyRepository } from './asset-warranty.repository';
import type {
  AssetWarrantyRecord,
  AssetWarrantyStatus,
  CreateAssetWarrantyInput,
  PublicAssetWarranty,
  UpdateAssetWarrantyInput,
  UpdateAssetWarrantyStatusInput,
} from './asset-warranty.types';
import {
  assertDateRange,
  type ValidationDetail,
} from './asset-warranty.validation';

/** Calendar dates are exposed as `YYYY-MM-DD`, never as instants. */
function toDateString(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return String(value).slice(0, 10);
}

/** Today in UTC as a `YYYY-MM-DD` calendar date. */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The authoritative "is this asset under warranty right now?" answer:
 * ACTIVE status AND today inside the coverage window. Clients consume this
 * instead of recomputing coverage locally.
 */
export function isCurrentlyCovered(
  record: Pick<AssetWarrantyRecord, 'status' | 'startDate' | 'endDate'>,
  onDate: string = today(),
): boolean {
  if (record.status !== 'ACTIVE') {
    return false;
  }

  const start = toDateString(record.startDate);
  const end = toDateString(record.endDate);
  return start <= onDate && onDate <= end;
}

export function toPublicAssetWarranty(
  record: AssetWarrantyRecord,
): PublicAssetWarranty {
  return {
    id: record.id,
    assetId: record.assetId,
    providerName: record.providerName,
    warrantyNumber: record.warrantyNumber,
    startDate: toDateString(record.startDate),
    endDate: toDateString(record.endDate),
    coverageDescription: record.coverageDescription,
    status: record.status,
    isCurrentlyCovered: isCurrentlyCovered(record),
  };
}

/**
 * The Asset registry (BE-05A) is the single source of Client / Building
 * context; the Warranty duplicates neither. Building isolation itself is
 * enforced at the API layer against the returned `buildingId`.
 */
async function requireAsset(assetId: string) {
  const asset = await assetRepository.findById(assetId);
  if (!asset) {
    throw assetNotFoundError();
  }
  return asset;
}

/**
 * Coverage state must agree with the coverage dates: a window that has
 * already closed cannot be registered or kept as ACTIVE, and a still-open
 * window cannot be labelled EXPIRED. INACTIVE (revoked / superseded
 * coverage) is deliberately unconstrained — it is an administrative state,
 * not a date-derived one.
 */
function assertStatusMatchesDates(
  status: AssetWarrantyStatus,
  startDate: string,
  endDate: string,
): void {
  const now = today();

  if (status === 'ACTIVE' && endDate < now) {
    throw assetWarrantyStatusDateMismatchError(
      'A warranty whose end date has passed cannot be ACTIVE; use EXPIRED.',
    );
  }

  if (status === 'EXPIRED' && endDate >= now) {
    throw assetWarrantyStatusDateMismatchError(
      'A warranty whose end date has not passed cannot be EXPIRED.',
    );
  }
}

/**
 * Registers warranty coverage for an Asset.
 *
 * Validation order (pinned by tests):
 *   1. unknown Asset                     → 404 ASSET_NOT_FOUND
 *   2. duplicate warranty number         → 409 ASSET_WARRANTY_NUMBER_ALREADY_EXISTS
 *   3. status contradicts the dates      → 400 ASSET_WARRANTY_STATUS_DATE_MISMATCH
 *   4. a second ACTIVE coverage          → 409 ASSET_WARRANTY_ACTIVE_EXISTS
 *   5. overlapping coverage window       → 409 ASSET_WARRANTY_OVERLAP
 *
 * The partial unique index `(asset_id) WHERE status = 'ACTIVE'` remains the
 * final authority for rule 4 — it also covers the race between the
 * pre-check and the INSERT. Historical (EXPIRED / INACTIVE) records are
 * unlimited.
 */
export async function createAssetWarranty(
  input: CreateAssetWarrantyInput,
  actorUserId?: string | null,
): Promise<PublicAssetWarranty> {
  await requireAsset(input.assetId);

  const status = input.status ?? 'ACTIVE';

  const duplicateNumber =
    await assetWarrantyRepository.findByNumberForAsset(
      input.assetId,
      input.warrantyNumber,
    );
  if (duplicateNumber) {
    throw assetWarrantyNumberAlreadyExistsError();
  }

  assertStatusMatchesDates(status, input.startDate, input.endDate);

  if (status === 'ACTIVE') {
    const active = await assetWarrantyRepository.findActiveByAssetId(
      input.assetId,
    );
    if (active) {
      throw assetWarrantyActiveExistsError();
    }
  }

  if (status !== 'INACTIVE') {
    const overlapping = await assetWarrantyRepository.findOverlapping(
      input.assetId,
      input.startDate,
      input.endDate,
    );
    if (overlapping) {
      throw assetWarrantyOverlapError();
    }
  }

  try {
    const record = await assetWarrantyRepository.createWarranty({
      assetId: input.assetId,
      providerName: input.providerName,
      warrantyNumber: input.warrantyNumber,
      startDate: input.startDate,
      endDate: input.endDate,
      coverageDescription: input.coverageDescription ?? null,
      status,
    });

    await recordAssetHistory({
      assetId: input.assetId,
      eventType: 'WARRANTY_CREATED',
      actorUserId,
      summary: `Warranty ${record.warrantyNumber} registered`,
      metadata: {
        warrantyId: record.id,
        warrantyNumber: record.warrantyNumber,
        providerName: record.providerName,
        status: record.status,
      },
    });

    return toPublicAssetWarranty(record);
  } catch (error) {
    if (isOneActivePerAssetViolation(error)) {
      throw assetWarrantyActiveExistsError();
    }
    if (isWarrantyNumberViolation(error)) {
      throw assetWarrantyNumberAlreadyExistsError();
    }
    throw error;
  }
}

/**
 * The Asset's CURRENT coverage — the single ACTIVE record. A 404 here means
 * "this asset has no active coverage", which is distinct from an unknown
 * Asset (also 404, but ASSET_NOT_FOUND, checked first).
 */
export async function getCurrentAssetWarranty(
  assetId: string,
): Promise<PublicAssetWarranty> {
  await requireAsset(assetId);

  const record = await assetWarrantyRepository.findActiveByAssetId(assetId);
  if (!record) {
    throw assetWarrantyNotFoundError();
  }

  return toPublicAssetWarranty(record);
}

/** Full warranty history of an Asset, newest coverage first. */
export async function listAssetWarranties(
  assetId: string,
  status?: AssetWarrantyStatus,
): Promise<PublicAssetWarranty[]> {
  await requireAsset(assetId);

  const records = await assetWarrantyRepository.listByAssetId(assetId, status);
  return records.map(toPublicAssetWarranty);
}

export async function getAssetWarrantyById(
  assetId: string,
  warrantyId: string,
): Promise<PublicAssetWarranty> {
  await requireAsset(assetId);

  const record = await assetWarrantyRepository.findById(warrantyId);
  // A warranty of another Asset must not be reachable through this Asset.
  if (!record || record.assetId !== assetId) {
    throw assetWarrantyNotFoundError();
  }

  return toPublicAssetWarranty(record);
}

/**
 * Partially updates one warranty record.
 *
 * `assetId` is immutable. Cross-field rules are re-checked against the
 * MERGED result, so a partial update can never leave an inconsistent
 * record: dates stay ordered, status stays consistent with the window, at
 * most one ACTIVE coverage survives, and windows do not overlap.
 */
export async function updateAssetWarranty(
  assetId: string,
  warrantyId: string,
  input: UpdateAssetWarrantyInput,
  actorUserId?: string | null,
): Promise<PublicAssetWarranty> {
  await requireAsset(assetId);

  const existing = await assetWarrantyRepository.findById(warrantyId);
  if (!existing || existing.assetId !== assetId) {
    throw assetWarrantyNotFoundError();
  }

  const nextStartDate = input.startDate ?? toDateString(existing.startDate);
  const nextEndDate = input.endDate ?? toDateString(existing.endDate);
  const nextStatus = input.status ?? existing.status;

  const details: ValidationDetail[] = [];
  assertDateRange(nextStartDate, nextEndDate, details);
  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  if (
    input.warrantyNumber !== undefined &&
    input.warrantyNumber !== existing.warrantyNumber
  ) {
    const duplicateNumber =
      await assetWarrantyRepository.findByNumberForAsset(
        assetId,
        input.warrantyNumber,
      );
    if (duplicateNumber) {
      throw assetWarrantyNumberAlreadyExistsError();
    }
  }

  assertStatusMatchesDates(nextStatus, nextStartDate, nextEndDate);

  if (nextStatus === 'ACTIVE') {
    const active = await assetWarrantyRepository.findActiveByAssetId(assetId);
    if (active && active.id !== warrantyId) {
      throw assetWarrantyActiveExistsError();
    }
  }

  if (nextStatus !== 'INACTIVE') {
    const overlapping = await assetWarrantyRepository.findOverlapping(
      assetId,
      nextStartDate,
      nextEndDate,
      warrantyId,
    );
    if (overlapping) {
      throw assetWarrantyOverlapError();
    }
  }

  try {
    const record = await assetWarrantyRepository.updateWarranty(
      warrantyId,
      input,
    );

    const changes = diffFields(
      existing as unknown as Record<string, unknown>,
      input as Record<string, unknown>,
    );
    if (Object.keys(changes).length > 0) {
      await recordAssetHistory({
        assetId,
        eventType: 'WARRANTY_UPDATED',
        actorUserId,
        summary: `Warranty ${existing.warrantyNumber} updated: ${changedFieldNames(changes).join(', ')}`,
        metadata: { warrantyId, ...changes },
      });
    }

    return toPublicAssetWarranty(record as AssetWarrantyRecord);
  } catch (error) {
    if (isOneActivePerAssetViolation(error)) {
      throw assetWarrantyActiveExistsError();
    }
    if (isWarrantyNumberViolation(error)) {
      throw assetWarrantyNumberAlreadyExistsError();
    }
    throw error;
  }
}

/**
 * Changes coverage state only (ACTIVE / EXPIRED / INACTIVE). Superseding
 * coverage is never a delete: the record is retained as warranty history.
 * No claim processing is triggered.
 */
export async function updateAssetWarrantyStatus(
  assetId: string,
  warrantyId: string,
  input: UpdateAssetWarrantyStatusInput,
  actorUserId?: string | null,
): Promise<PublicAssetWarranty> {
  return updateAssetWarranty(
    assetId,
    warrantyId,
    { status: input.status },
    actorUserId,
  );
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23505' && candidate.constraint === constraint;
}

function isOneActivePerAssetViolation(error: unknown): boolean {
  return isUniqueViolation(error, 'asset_warranties_one_active_per_asset');
}

function isWarrantyNumberViolation(error: unknown): boolean {
  return isUniqueViolation(error, 'asset_warranties_asset_number_unique');
}

export const assetWarrantyService = {
  createAssetWarranty,
  getAssetWarrantyById,
  getCurrentAssetWarranty,
  isCurrentlyCovered,
  listAssetWarranties,
  toPublicAssetWarranty,
  updateAssetWarranty,
  updateAssetWarrantyStatus,
};
