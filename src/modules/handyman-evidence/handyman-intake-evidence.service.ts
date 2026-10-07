import { randomUUID } from 'node:crypto';
import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  createEvidenceStorage,
  evidenceStorageKey,
} from '../evidence/storage';
import {
  computeEvidenceSha256,
} from '../evidence/evidence-integrity';
import { buildingAccessDeniedError, contextAccessService } from '../context-access';
import { handymanServiceRequestRepository } from '../handyman-requests';
import {
  handymanIntakeEvidenceNotIntakeError,
  handymanServiceRequestNotFoundError,
} from './handyman-intake-evidence.errors';
import { handymanIntakeEvidenceRepository } from './handyman-intake-evidence.repository';
import {
  HANDYMAN_INTAKE_FILE_NAME_MAX_LENGTH,
  HANDYMAN_INTAKE_MAX_FILE_BYTES,
  HANDYMAN_INTAKE_PHOTO_MIME_TYPES,
  HANDYMAN_INTAKE_VIDEO_MIME_TYPES,
  isHandymanIntakeEvidenceKind,
  type HandymanIntakeEvidenceRecord,
  type PublicHandymanIntakeEvidence,
  type RecordHandymanIntakeEvidenceInput,
} from './handyman-intake-evidence.types';

/**
 * CR-HM-02 PART 04 — Handyman request-intake evidence service
 * (frozen D1/D2).
 *
 * Bounded PHOTO + VIDEO intake evidence attached to an EXISTING Handyman
 * request (parent admission `HANDYMAN_REQUEST`, migration 0379), persisted
 * through the shared evidence engine with the existing storage abstraction,
 * server-side SHA-256 integrity metadata, safe file-metadata handling, and
 * the engine's default retention state ('ACTIVE' + the shared retention
 * machinery — VIDEO receives no special treatment).
 *
 * Authority: the Handyman request is the only context authority — client /
 * company / building / space are NEVER accepted from the caller. Recording
 * evidence never mutates the request's business lifecycle (status stays
 * INTAKE; nothing on the request row is touched).
 *
 * Stage: INTAKE only. No BEFORE/DURING/AFTER/QC/DEFECT/RECTIFICATION/
 * MATERIAL/BAST/WARRANTY vocabulary exists here (CR-HM-10 closure).
 * Photo reuses the existing safe PHOTO MIME semantics; VIDEO is bounded to
 * the explicit Handyman policy below and never leaks into other parents.
 */

function toPublic(
  record: HandymanIntakeEvidenceRecord,
): PublicHandymanIntakeEvidence {
  return {
    ...record,
    capturedAt: record.capturedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
  };
}

function allowedMimeFor(kind: 'PHOTO' | 'VIDEO'): readonly string[] {
  return kind === 'PHOTO'
    ? HANDYMAN_INTAKE_PHOTO_MIME_TYPES
    : HANDYMAN_INTAKE_VIDEO_MIME_TYPES;
}

export async function recordHandymanIntakeEvidence(
  input: RecordHandymanIntakeEvidenceInput,
  actorUserId: string,
): Promise<PublicHandymanIntakeEvidence> {
  // 0) Structural validation (no context fields exist in input by design).
  if (!isValidUuid(input.handymanRequestId)) {
    throw AppError.validation('Evidence validation failed.', [
      {
        field: 'handymanRequestId',
        message: 'handymanRequestId must be a valid UUID.',
      },
    ]);
  }
  if (!isHandymanIntakeEvidenceKind(input.evidenceKind)) {
    throw AppError.validation('Evidence validation failed.', [
      {
        field: 'evidenceKind',
        message: 'evidenceKind must be PHOTO or VIDEO.',
      },
    ]);
  }

  // 1) Authoritative parent: the Handyman request must exist, be INTAKE,
  //    and the actor must be able to access its derived Client scope.
  const request = await handymanServiceRequestRepository.findById(
    undefined,
    input.handymanRequestId,
  );
  if (!request) throw handymanServiceRequestNotFoundError();
  if (request.status !== 'INTAKE') {
    throw handymanIntakeEvidenceNotIntakeError();
  }
  if (
    !(await contextAccessService.canAccessClient(
      actorUserId,
      request.clientId,
    ))
  ) {
    throw buildingAccessDeniedError();
  }

  // 2) Bounded kind policy (PHOTO = existing safe semantics; VIDEO =
  //    explicit Handyman allowlist, frozen D2).
  const allowed = allowedMimeFor(input.evidenceKind);
  if (typeof input.mimeType !== 'string' || !allowed.includes(input.mimeType)) {
    throw AppError.badRequest(
      `Evidence kind ${input.evidenceKind} does not accept MIME type ${input.mimeType}.`,
    );
  }

  // 3) Safe file metadata + shared storage-size policy (50 MB for both).
  const fileName =
    typeof input.fileName === 'string' ? input.fileName.trim() : '';
  if (
    fileName.length < 1 ||
    fileName.length > HANDYMAN_INTAKE_FILE_NAME_MAX_LENGTH
  ) {
    throw AppError.validation('Evidence validation failed.', [
      {
        field: 'fileName',
        message: `fileName is required (1-${HANDYMAN_INTAKE_FILE_NAME_MAX_LENGTH} characters).`,
      },
    ]);
  }
  if (!Buffer.isBuffer(input.content) || input.content.length < 1) {
    throw AppError.validation('Evidence validation failed.', [
      { field: 'content', message: 'content bytes are required.' },
    ]);
  }
  if (input.content.length > HANDYMAN_INTAKE_MAX_FILE_BYTES) {
    throw AppError.badRequest('Uploaded file exceeds the 50 MB limit.');
  }

  // 4) Server-side integrity hash of the exact bytes that go to storage —
  //    the same pattern as the shared evidence file API. The storage key
  //    derives from the new evidence id only (never caller-shaped paths).
  const evidenceId = randomUUID();
  const key = evidenceStorageKey(evidenceId);
  const contentSha256 = computeEvidenceSha256(input.content);
  const storage = createEvidenceStorage();
  await storage.put(key, {
    buffer: input.content,
    mimeType: input.mimeType,
  });

  const record = await handymanIntakeEvidenceRepository.insertEvidence(
    undefined,
    {
      id: evidenceId,
      clientId: request.clientId,
      handymanRequestId: request.id,
      evidenceKind: input.evidenceKind,
      fileReference: key,
      originalFileName: fileName,
      mimeType: input.mimeType,
      fileSize: input.content.length,
      submittedByUserId: actorUserId,
      contentSha256,
    },
  );
  return toPublic(record);
}

/** Intake evidence attached to one Handyman request (bounded read). */
export async function listHandymanIntakeEvidence(
  handymanRequestId: string,
  actorUserId: string,
): Promise<PublicHandymanIntakeEvidence[]> {
  if (!isValidUuid(handymanRequestId)) {
    throw AppError.validation('Evidence validation failed.', [
      {
        field: 'handymanRequestId',
        message: 'handymanRequestId must be a valid UUID.',
      },
    ]);
  }
  const request = await handymanServiceRequestRepository.findById(
    undefined,
    handymanRequestId,
  );
  if (!request) throw handymanServiceRequestNotFoundError();
  if (
    !(await contextAccessService.canAccessClient(
      actorUserId,
      request.clientId,
    ))
  ) {
    throw buildingAccessDeniedError();
  }
  const records = await handymanIntakeEvidenceRepository.listForRequest(
    undefined,
    request.id,
  );
  return records.map(toPublic);
}

export const handymanIntakeEvidenceService = {
  recordHandymanIntakeEvidence,
  listHandymanIntakeEvidence,
};
