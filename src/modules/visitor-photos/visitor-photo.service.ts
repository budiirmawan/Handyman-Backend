import {
  buildingAccessDeniedError,
  contextAccessService,
} from '../context-access';
import {
  visitorNotFoundError,
  visitorRepository,
  visitorService,
} from '../visitors';
import type { UpdateVisitorInput } from '../visitors';
import {
  visitorPhotoAlreadyReviewedError,
  visitorPhotoNotFoundError,
  visitorPhotoNothingToApplyError,
  visitorPhotoOcrNotProcessedError,
  visitorPhotoOcrNotRequestedError,
  visitorPhotoRemovedError,
} from './visitor-photo.errors';
import { visitorPhotoRepository } from './visitor-photo.repository';
import type {
  CreateVisitorPhotoInput,
  PublicVisitorPhoto,
  RecordVisitorPhotoOcrResultInput,
  ReviewVisitorPhotoInput,
  VisitorPhotoListFilters,
  VisitorPhotoRecord,
} from './visitor-photo.types';

/**
 * BE-13E — Visitor Photo / OCR Readiness service.
 *
 * Attaches photo / identity-document file REFERENCES (BE-07 evidence
 * convention — no binaries in PostgreSQL) to the shared BE-13A visitor
 * identity and records external OCR request/result METADATA. No custom
 * OCR/AI engine exists here.
 *
 * Review boundary (the critical rule): OCR-extracted identity fields
 * are STAGED on the photo row. They NEVER touch the authoritative
 * visitor master until an explicit APPLY review, which:
 *   - requires a PROCESSED OCR result,
 *   - is single-shot (UNREVIEWED → APPLIED | REJECTED),
 *   - records the reviewer + timestamp,
 *   - routes the actual identity change through the BE-13A visitor
 *     service so every identity rule (per-Client duplicate document
 *     409, identity-number-requires-type, …) still holds.
 * REJECT keeps the staged output for audit but never applies it.
 *
 * Access rule: Client-scoped via the photo's visitor (same
 * `canAccessClient` rule as BE-13A) — unknown and inaccessible rows
 * are denied identically.
 */

export async function attachVisitorPhoto(
  input: CreateVisitorPhotoInput,
  userId: string,
): Promise<PublicVisitorPhoto> {
  const visitor = await visitorRepository.findById(input.visitorId);
  if (!visitor) {
    throw visitorNotFoundError();
  }
  await assertClientAccess(userId, visitor.clientId);

  const record = await visitorPhotoRepository.create({
    ...input,
    clientId: visitor.clientId,
  });
  return toPublicVisitorPhoto(record);
}

export async function getVisitorPhoto(
  id: string,
  userId: string,
): Promise<PublicVisitorPhoto> {
  const record = await visitorPhotoRepository.findById(id);
  if (!record) {
    throw visitorPhotoNotFoundError();
  }
  await assertClientAccess(userId, record.clientId);
  return toPublicVisitorPhoto(record);
}

export async function listVisitorPhotos(
  visitorId: string,
  filters: VisitorPhotoListFilters,
  userId: string,
): Promise<PublicVisitorPhoto[]> {
  const visitor = await visitorRepository.findById(visitorId);
  if (!visitor) {
    throw visitorNotFoundError();
  }
  await assertClientAccess(userId, visitor.clientId);

  const records = await visitorPhotoRepository.listByVisitor(
    visitorId,
    filters,
  );
  return records.map(toPublicVisitorPhoto);
}

/**
 * Records external OCR result metadata (PENDING re-queue, PROCESSED
 * with staged extracted fields, or FAILED with an error). Never
 * touches the visitor master and resets nothing that was already
 * reviewed — a PROCESSED result can only be recorded while the photo
 * is still UNREVIEWED.
 */
export async function recordVisitorPhotoOcrResult(
  id: string,
  input: RecordVisitorPhotoOcrResultInput,
  userId: string,
): Promise<PublicVisitorPhoto> {
  const existing = await visitorPhotoRepository.findById(id);
  if (!existing) {
    throw visitorPhotoNotFoundError();
  }
  await assertClientAccess(userId, existing.clientId);

  if (existing.status === 'REMOVED') {
    throw visitorPhotoRemovedError();
  }
  if (existing.ocrStatus === 'NOT_REQUESTED') {
    throw visitorPhotoOcrNotRequestedError();
  }
  if (existing.reviewStatus !== 'UNREVIEWED') {
    throw visitorPhotoAlreadyReviewedError();
  }

  const processedAt =
    input.ocrStatus === 'PENDING'
      ? null
      : (input.ocrProcessedAt ?? new Date().toISOString());

  const updated = await visitorPhotoRepository.update(id, {
    ocrStatus: input.ocrStatus,
    ocrProvider:
      input.ocrProvider !== undefined
        ? input.ocrProvider
        : existing.ocrProvider,
    ocrError: input.ocrStatus === 'FAILED' ? (input.ocrError ?? null) : null,
    ocrProcessedAt: processedAt,
    extractedFullName:
      input.ocrStatus === 'PROCESSED' ? (input.extractedFullName ?? null) : null,
    extractedIdentityType:
      input.ocrStatus === 'PROCESSED'
        ? (input.extractedIdentityType ?? null)
        : null,
    extractedIdentityNumber:
      input.ocrStatus === 'PROCESSED'
        ? (input.extractedIdentityNumber ?? null)
        : null,
  });
  if (!updated) {
    throw visitorPhotoNotFoundError();
  }
  return toPublicVisitorPhoto(updated);
}

/**
 * Explicit review over staged OCR output.
 *
 * APPLY  — pushes the selected staged fields into the authoritative
 *          visitor identity THROUGH the BE-13A service (all identity
 *          rules and duplicate checks still apply; on failure the
 *          photo stays UNREVIEWED).
 * REJECT — marks the output rejected; the visitor master is untouched.
 */
export async function reviewVisitorPhoto(
  id: string,
  input: ReviewVisitorPhotoInput,
  userId: string,
): Promise<PublicVisitorPhoto> {
  const existing = await visitorPhotoRepository.findById(id);
  if (!existing) {
    throw visitorPhotoNotFoundError();
  }
  await assertClientAccess(userId, existing.clientId);

  if (existing.status === 'REMOVED') {
    throw visitorPhotoRemovedError();
  }
  if (existing.reviewStatus !== 'UNREVIEWED') {
    throw visitorPhotoAlreadyReviewedError();
  }
  if (existing.ocrStatus !== 'PROCESSED') {
    throw visitorPhotoOcrNotProcessedError();
  }

  if (input.decision === 'APPLY') {
    const applyFullName = input.applyFullName ?? true;
    const applyIdentity = input.applyIdentity ?? true;

    const visitorUpdate: UpdateVisitorInput = {};
    if (applyFullName && existing.extractedFullName) {
      visitorUpdate.fullName = existing.extractedFullName;
    }
    if (applyIdentity && existing.extractedIdentityNumber) {
      visitorUpdate.identityNumber = existing.extractedIdentityNumber;
      if (existing.extractedIdentityType) {
        visitorUpdate.identityType = existing.extractedIdentityType;
      }
    }

    if (Object.keys(visitorUpdate).length === 0) {
      throw visitorPhotoNothingToApplyError();
    }

    // Authoritative write goes through BE-13A — duplicate-document and
    // identity-type rules still hold; a failure leaves the photo
    // UNREVIEWED so the front desk can correct and retry.
    await visitorService.updateVisitor(
      existing.visitorId,
      visitorUpdate,
      userId,
    );
  }

  const updated = await visitorPhotoRepository.update(id, {
    reviewStatus: input.decision === 'APPLY' ? 'APPLIED' : 'REJECTED',
    reviewedByUserId: userId,
    reviewedAt: new Date().toISOString(),
  });
  if (!updated) {
    throw visitorPhotoNotFoundError();
  }
  return toPublicVisitorPhoto(updated);
}

/** Soft-removes a photo reference (the row is kept for audit). */
export async function removeVisitorPhoto(
  id: string,
  userId: string,
): Promise<PublicVisitorPhoto> {
  const existing = await visitorPhotoRepository.findById(id);
  if (!existing) {
    throw visitorPhotoNotFoundError();
  }
  await assertClientAccess(userId, existing.clientId);

  if (existing.status === 'REMOVED') {
    throw visitorPhotoRemovedError();
  }

  const updated = await visitorPhotoRepository.update(id, {
    status: 'REMOVED',
  });
  if (!updated) {
    throw visitorPhotoNotFoundError();
  }
  return toPublicVisitorPhoto(updated);
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

async function assertClientAccess(
  userId: string,
  clientId: string,
): Promise<void> {
  if (!(await contextAccessService.canAccessClient(userId, clientId))) {
    throw buildingAccessDeniedError();
  }
}

function toPublicVisitorPhoto(record: VisitorPhotoRecord): PublicVisitorPhoto {
  return {
    id: record.id,
    clientId: record.clientId,
    visitorId: record.visitorId,
    photoType: record.photoType,
    fileReference: record.fileReference,
    originalFileName: record.originalFileName,
    mimeType: record.mimeType,
    fileSize: record.fileSize,
    capturedAt: record.capturedAt ? record.capturedAt.toISOString() : null,
    ocrStatus: record.ocrStatus,
    ocrProvider: record.ocrProvider,
    ocrError: record.ocrError,
    ocrProcessedAt: record.ocrProcessedAt
      ? record.ocrProcessedAt.toISOString()
      : null,
    extractedFullName: record.extractedFullName,
    extractedIdentityType: record.extractedIdentityType,
    extractedIdentityNumber: record.extractedIdentityNumber,
    reviewStatus: record.reviewStatus,
    reviewedByUserId: record.reviewedByUserId,
    reviewedAt: record.reviewedAt ? record.reviewedAt.toISOString() : null,
    status: record.status,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export const visitorPhotoService = {
  attachVisitorPhoto,
  getVisitorPhoto,
  listVisitorPhotos,
  recordVisitorPhotoOcrResult,
  removeVisitorPhoto,
  reviewVisitorPhoto,
};
