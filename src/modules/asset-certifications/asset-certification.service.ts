import { assetNotFoundError, assetRepository } from '../assets';
import {
  changedFieldNames,
  diffFields,
  recordAssetHistory,
} from '../asset-history';
import { AppError } from '../../shared/errors';
import {
  assetCertificationActiveExistsError,
  assetCertificationNotFoundError,
  assetCertificationNumberAlreadyExistsError,
  assetCertificationOverlapError,
  assetCertificationStatusDateMismatchError,
} from './asset-certification.errors';
import { assetCertificationRepository } from './asset-certification.repository';
import type {
  AssetCertificationRecord,
  AssetCertificationStatus,
  CreateAssetCertificationInput,
  PublicAssetCertification,
  UpdateAssetCertificationInput,
  UpdateAssetCertificationStatusInput,
} from './asset-certification.types';
import {
  assertDateRange,
  type ValidationDetail,
} from './asset-certification.validation';

/** Calendar dates are exposed as `YYYY-MM-DD`, never as instants. */
function toDateString(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return String(value).slice(0, 10);
}

function toNullableDateString(value: Date | string | null): string | null {
  return value === null ? null : toDateString(value);
}

/** Today in UTC as a `YYYY-MM-DD` calendar date. */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The authoritative "is this certification in force right now?" answer:
 * ACTIVE status AND today inside the validity window. A NULL expiry means
 * perpetual, so it never lapses. Clients consume this instead of
 * recomputing compliance locally.
 */
export function isCurrentlyEffective(
  record: Pick<
    AssetCertificationRecord,
    'status' | 'issueDate' | 'expiryDate'
  >,
  onDate: string = today(),
): boolean {
  if (record.status !== 'ACTIVE') {
    return false;
  }

  const issued = toDateString(record.issueDate);
  if (issued > onDate) {
    return false;
  }

  const expiry = toNullableDateString(record.expiryDate);
  return expiry === null || onDate <= expiry;
}

export function toPublicAssetCertification(
  record: AssetCertificationRecord,
): PublicAssetCertification {
  return {
    id: record.id,
    assetId: record.assetId,
    certificationType: record.certificationType,
    certificateNumber: record.certificateNumber,
    issuingAuthority: record.issuingAuthority,
    issueDate: toDateString(record.issueDate),
    expiryDate: toNullableDateString(record.expiryDate),
    status: record.status,
    notes: record.notes,
    isCurrentlyEffective: isCurrentlyEffective(record),
  };
}

/**
 * The Asset registry (BE-05A) is the single source of Client / Building
 * context; the Certification duplicates neither. Building isolation itself
 * is enforced at the API layer against the returned `buildingId`.
 */
async function requireAsset(assetId: string) {
  const asset = await assetRepository.findById(assetId);
  if (!asset) {
    throw assetNotFoundError();
  }
  return asset;
}

/**
 * Certification state must agree with the dates: a certificate that has
 * already lapsed cannot be registered or kept as ACTIVE, and one still
 * within its validity window (or perpetual) cannot be labelled EXPIRED.
 * INACTIVE (revoked / superseded) is deliberately unconstrained — it is an
 * administrative state, not a date-derived one.
 */
function assertStatusMatchesDates(
  status: AssetCertificationStatus,
  expiryDate: string | null,
): void {
  const now = today();

  if (status === 'ACTIVE' && expiryDate !== null && expiryDate < now) {
    throw assetCertificationStatusDateMismatchError(
      'A certification whose expiry date has passed cannot be ACTIVE; use EXPIRED.',
    );
  }

  if (status === 'EXPIRED' && (expiryDate === null || expiryDate >= now)) {
    throw assetCertificationStatusDateMismatchError(
      'A certification whose expiry date has not passed cannot be EXPIRED.',
    );
  }
}

/**
 * Registers a certification for an Asset.
 *
 * Validation order (pinned by tests):
 *   1. unknown Asset                        → 404 ASSET_NOT_FOUND
 *   2. duplicate certificate number         → 409 ASSET_CERTIFICATION_NUMBER_ALREADY_EXISTS
 *   3. status contradicts the dates         → 400 ASSET_CERTIFICATION_STATUS_DATE_MISMATCH
 *   4. a second ACTIVE of the same type     → 409 ASSET_CERTIFICATION_ACTIVE_EXISTS
 *   5. overlapping window of the same type  → 409 ASSET_CERTIFICATION_OVERLAP
 *
 * The partial unique index
 * `(asset_id, certification_type) WHERE status = 'ACTIVE'` remains the final
 * authority for rule 4. Different types may be ACTIVE concurrently, and
 * historical records are unlimited.
 */
export async function createAssetCertification(
  input: CreateAssetCertificationInput,
  actorUserId?: string | null,
): Promise<PublicAssetCertification> {
  await requireAsset(input.assetId);

  const status = input.status ?? 'ACTIVE';
  const expiryDate = input.expiryDate ?? null;

  const duplicateNumber =
    await assetCertificationRepository.findByNumberForAsset(
      input.assetId,
      input.certificateNumber,
    );
  if (duplicateNumber) {
    throw assetCertificationNumberAlreadyExistsError();
  }

  assertStatusMatchesDates(status, expiryDate);

  if (status === 'ACTIVE') {
    const active = await assetCertificationRepository.findActiveByType(
      input.assetId,
      input.certificationType,
    );
    if (active) {
      throw assetCertificationActiveExistsError();
    }
  }

  if (status !== 'INACTIVE') {
    const overlapping = await assetCertificationRepository.findOverlapping(
      input.assetId,
      input.certificationType,
      input.issueDate,
      expiryDate,
    );
    if (overlapping) {
      throw assetCertificationOverlapError();
    }
  }

  try {
    const record = await assetCertificationRepository.createCertification({
      assetId: input.assetId,
      certificationType: input.certificationType,
      certificateNumber: input.certificateNumber,
      issuingAuthority: input.issuingAuthority,
      issueDate: input.issueDate,
      expiryDate,
      status,
      notes: input.notes ?? null,
    });

    await recordAssetHistory({
      assetId: input.assetId,
      eventType: 'CERTIFICATION_CREATED',
      actorUserId,
      summary: `Certification ${record.certificateNumber} (${record.certificationType}) registered`,
      metadata: {
        certificationId: record.id,
        certificationType: record.certificationType,
        certificateNumber: record.certificateNumber,
        issuingAuthority: record.issuingAuthority,
        status: record.status,
      },
    });

    return toPublicAssetCertification(record);
  } catch (error) {
    if (isOneActivePerTypeViolation(error)) {
      throw assetCertificationActiveExistsError();
    }
    if (isCertificateNumberViolation(error)) {
      throw assetCertificationNumberAlreadyExistsError();
    }
    throw error;
  }
}

/** Full certification history of an Asset, newest issue first. */
export async function listAssetCertifications(
  assetId: string,
  filters?: { status?: AssetCertificationStatus; certificationType?: string },
): Promise<PublicAssetCertification[]> {
  await requireAsset(assetId);

  const records = await assetCertificationRepository.listByAssetId(
    assetId,
    filters,
  );
  return records.map(toPublicAssetCertification);
}

/**
 * The Asset's CURRENT / EFFECTIVE certifications: every ACTIVE record whose
 * validity window covers today (at most one per type). An ACTIVE record that
 * has not yet come into force is excluded — it is registered, not effective.
 */
export async function listCurrentAssetCertifications(
  assetId: string,
): Promise<PublicAssetCertification[]> {
  await requireAsset(assetId);

  const records = await assetCertificationRepository.listActiveByAssetId(
    assetId,
  );
  return records
    .filter((record) => isCurrentlyEffective(record))
    .map(toPublicAssetCertification);
}

export async function getAssetCertificationById(
  assetId: string,
  certificationId: string,
): Promise<PublicAssetCertification> {
  await requireAsset(assetId);

  const record = await assetCertificationRepository.findById(certificationId);
  // A certification of another Asset must not be reachable through this one.
  if (!record || record.assetId !== assetId) {
    throw assetCertificationNotFoundError();
  }

  return toPublicAssetCertification(record);
}

/**
 * Partially updates one certification record.
 *
 * `assetId` is immutable. Cross-field rules are re-checked against the
 * MERGED result, so a partial update can never leave an inconsistent
 * record: dates stay ordered, status stays consistent with the expiry, at
 * most one ACTIVE per type survives, and windows of the same type do not
 * overlap.
 */
export async function updateAssetCertification(
  assetId: string,
  certificationId: string,
  input: UpdateAssetCertificationInput,
  actorUserId?: string | null,
): Promise<PublicAssetCertification> {
  await requireAsset(assetId);

  const existing = await assetCertificationRepository.findById(
    certificationId,
  );
  if (!existing || existing.assetId !== assetId) {
    throw assetCertificationNotFoundError();
  }

  const nextType = input.certificationType ?? existing.certificationType;
  const nextIssueDate = input.issueDate ?? toDateString(existing.issueDate);
  const nextExpiryDate =
    input.expiryDate === undefined
      ? toNullableDateString(existing.expiryDate)
      : input.expiryDate;
  const nextStatus = input.status ?? existing.status;

  const details: ValidationDetail[] = [];
  assertDateRange(nextIssueDate, nextExpiryDate, details);
  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  if (
    input.certificateNumber !== undefined &&
    input.certificateNumber !== existing.certificateNumber
  ) {
    const duplicateNumber =
      await assetCertificationRepository.findByNumberForAsset(
        assetId,
        input.certificateNumber,
      );
    if (duplicateNumber) {
      throw assetCertificationNumberAlreadyExistsError();
    }
  }

  assertStatusMatchesDates(nextStatus, nextExpiryDate);

  if (nextStatus === 'ACTIVE') {
    const active = await assetCertificationRepository.findActiveByType(
      assetId,
      nextType,
    );
    if (active && active.id !== certificationId) {
      throw assetCertificationActiveExistsError();
    }
  }

  if (nextStatus !== 'INACTIVE') {
    const overlapping = await assetCertificationRepository.findOverlapping(
      assetId,
      nextType,
      nextIssueDate,
      nextExpiryDate,
      certificationId,
    );
    if (overlapping) {
      throw assetCertificationOverlapError();
    }
  }

  try {
    const record = await assetCertificationRepository.updateCertification(
      certificationId,
      input,
    );

    const changes = diffFields(
      existing as unknown as Record<string, unknown>,
      input as Record<string, unknown>,
    );
    if (Object.keys(changes).length > 0) {
      await recordAssetHistory({
        assetId,
        eventType: 'CERTIFICATION_UPDATED',
        actorUserId,
        summary: `Certification ${existing.certificateNumber} updated: ${changedFieldNames(changes).join(', ')}`,
        metadata: { certificationId, ...changes },
      });
    }

    return toPublicAssetCertification(record as AssetCertificationRecord);
  } catch (error) {
    if (isOneActivePerTypeViolation(error)) {
      throw assetCertificationActiveExistsError();
    }
    if (isCertificateNumberViolation(error)) {
      throw assetCertificationNumberAlreadyExistsError();
    }
    throw error;
  }
}

/**
 * Changes certification state only (ACTIVE / EXPIRED / INACTIVE).
 * Superseding a certificate is never a delete: the record is retained as
 * certification history. No inspection or renewal workflow is triggered.
 */
export async function updateAssetCertificationStatus(
  assetId: string,
  certificationId: string,
  input: UpdateAssetCertificationStatusInput,
  actorUserId?: string | null,
): Promise<PublicAssetCertification> {
  return updateAssetCertification(
    assetId,
    certificationId,
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

function isOneActivePerTypeViolation(error: unknown): boolean {
  return isUniqueViolation(error, 'asset_certifications_one_active_per_type');
}

function isCertificateNumberViolation(error: unknown): boolean {
  return isUniqueViolation(error, 'asset_certifications_asset_number_unique');
}

export const assetCertificationService = {
  createAssetCertification,
  getAssetCertificationById,
  isCurrentlyEffective,
  listAssetCertifications,
  listCurrentAssetCertifications,
  toPublicAssetCertification,
  updateAssetCertification,
  updateAssetCertificationStatus,
};
