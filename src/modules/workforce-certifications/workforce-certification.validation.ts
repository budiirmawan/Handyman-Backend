import { AppError } from '../../shared/errors';
import { workforceCertificationInvalidFileReferenceError } from './workforce-certification.errors';
import {
  WORKFORCE_CERTIFICATION_STATUSES,
  WORKFORCE_CERTIFICATION_VERIFICATION_STATUSES,
  type CreateWorkforceCertificationInput,
  type DeactivateWorkforceCertificationInput,
  type ListExpiringWorkforceCertificationsFilter,
  type ListWorkforceCertificationsFilter,
  type UpdateWorkforceCertificationInput,
  type VerifyWorkforceCertificationInput,
  type WorkforceCertificationStatus,
  type WorkforceCertificationVerificationStatus,
} from './workforce-certification.types';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HM_EVIDENCE_REF_PATTERN =
  /^hm-ev:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SAFE_RELATIVE_STORAGE_KEY_PATTERN =
  /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

const UNSAFE_SCHEME_PATTERN =
  /^(javascript|data|file|vbscript|http|https|ftp):/i;

const CONTROL_OR_SPACE_PATTERN = /[\u0000-\u001F\u007F\s]/;

export function isSafeCertificationFileReference(value: string): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  if (
    trimmed.length < 1 ||
    trimmed.length > 512 ||
    trimmed !== value ||
    trimmed.includes('..') ||
    trimmed.includes('\\') ||
    trimmed.startsWith('/') ||
    CONTROL_OR_SPACE_PATTERN.test(trimmed)
  ) {
    return false;
  }

  if (HM_EVIDENCE_REF_PATTERN.test(trimmed)) {
    return true;
  }

  if (trimmed.includes('://') || UNSAFE_SCHEME_PATTERN.test(trimmed)) {
    return false;
  }

  return SAFE_RELATIVE_STORAGE_KEY_PATTERN.test(trimmed);
}

export function validateSafeCertificationFileReference(value: string): string {
  const trimmed = value.trim();
  if (!isSafeCertificationFileReference(trimmed)) {
    throw workforceCertificationInvalidFileReferenceError();
  }
  return trimmed;
}

function parseIsoTimestamp(
  value: unknown,
  field: string,
  details: string[],
): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    details.push(`${field} must be a valid ISO-8601 date string.`);
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    details.push(`${field} must be a valid ISO-8601 date string.`);
    return null;
  }
  return parsed.toISOString();
}

export function validateWorkforceIdParam(id: unknown): string {
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
    throw AppError.validation('Request validation failed.', [
      'workforceId must be a valid UUID.',
    ]);
  }
  return id;
}

export function validateCertificationIdParam(id: unknown): string {
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
    throw AppError.validation('Request validation failed.', [
      'certificationId must be a valid UUID.',
    ]);
  }
  return id;
}

export function validateCreateWorkforceCertificationInput(
  body: unknown,
): CreateWorkforceCertificationInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw AppError.validation('Request body must be a JSON object.');
  }

  const payload = body as Record<string, unknown>;
  const details: string[] = [];

  const rawNumber = payload.certificateNumber ?? payload.number;
  const rawName = payload.certificateName ?? payload.name;
  const rawIssuer = payload.issuingAuthority ?? payload.issuer;
  const rawIssueDate = payload.issueDate ?? payload.issuedAt;
  const rawExpiryDate =
    payload.expiryDate !== undefined
      ? payload.expiryDate
      : payload.expiresAt !== undefined
        ? payload.expiresAt
        : payload.validUntil;
  const rawFileReference =
    payload.fileReference !== undefined
      ? payload.fileReference
      : payload.storageReference;

  if (typeof rawNumber !== 'string') {
    details.push('certificateNumber is required and must be a string.');
  } else {
    const trimmed = rawNumber.trim();
    if (trimmed.length < 1 || trimmed.length > 128) {
      details.push('certificateNumber must be between 1 and 128 characters.');
    }
  }

  if (typeof rawName !== 'string') {
    details.push('certificateName is required and must be a string.');
  } else {
    const trimmed = rawName.trim();
    if (trimmed.length < 1 || trimmed.length > 255) {
      details.push('certificateName must be between 1 and 255 characters.');
    }
  }

  if (typeof rawIssuer !== 'string') {
    details.push('issuingAuthority is required and must be a string.');
  } else {
    const trimmed = rawIssuer.trim();
    if (trimmed.length < 1 || trimmed.length > 255) {
      details.push('issuingAuthority must be between 1 and 255 characters.');
    }
  }

  const issueDate = parseIsoTimestamp(rawIssueDate, 'issueDate', details);

  let expiryDate: string | null | undefined;
  if (rawExpiryDate !== undefined) {
    if (rawExpiryDate === null) {
      expiryDate = null;
    } else {
      const parsed = parseIsoTimestamp(rawExpiryDate, 'expiryDate', details);
      if (parsed) {
        expiryDate = parsed;
      }
    }
  }

  if (
    issueDate &&
    typeof expiryDate === 'string' &&
    new Date(expiryDate).getTime() < new Date(issueDate).getTime()
  ) {
    details.push('expiryDate must be greater than or equal to issueDate.');
  }

  let status: WorkforceCertificationStatus | undefined;
  if (payload.status !== undefined) {
    if (
      typeof payload.status !== 'string' ||
      !WORKFORCE_CERTIFICATION_STATUSES.includes(
        payload.status as WorkforceCertificationStatus,
      )
    ) {
      details.push(
        `status must be one of: ${WORKFORCE_CERTIFICATION_STATUSES.join(', ')}.`,
      );
    } else {
      status = payload.status as WorkforceCertificationStatus;
    }
  }

  // PART 02 — verification is a separate, deliberately granted authority.
  // Accepting `verificationStatus` on create/update would let a manage-only
  // actor mint or flip a VERIFIED attestation without ever exercising the
  // verification permission, so it is rejected outright instead of ignored.
  if (payload.verificationStatus !== undefined) {
    details.push(
      'verificationStatus cannot be set when creating a certification; use POST /workforce/:workforceId/certifications/:certificationId/verify.',
    );
  }

  let skillId: string | null | undefined;
  if (payload.skillId !== undefined) {
    if (payload.skillId === null) {
      skillId = null;
    } else if (
      typeof payload.skillId !== 'string' ||
      !UUID_PATTERN.test(payload.skillId)
    ) {
      details.push('skillId must be a valid UUID or null.');
    } else {
      skillId = payload.skillId;
    }
  }

  let documentId: string | null | undefined;
  if (payload.documentId !== undefined) {
    if (payload.documentId === null) {
      documentId = null;
    } else if (
      typeof payload.documentId !== 'string' ||
      !UUID_PATTERN.test(payload.documentId)
    ) {
      details.push('documentId must be a valid UUID or null.');
    } else {
      documentId = payload.documentId;
    }
  }

  let fileReference: string | null | undefined;
  if (rawFileReference !== undefined) {
    if (rawFileReference === null) {
      fileReference = null;
    } else if (typeof rawFileReference !== 'string') {
      details.push('fileReference must be a string or null.');
    } else {
      const trimmed = rawFileReference.trim();
      if (!isSafeCertificationFileReference(trimmed)) {
        if (details.length === 0) {
          throw workforceCertificationInvalidFileReferenceError();
        }
        details.push(
          'fileReference must be a safe relative storage key or canonical hm-ev://<uuid> reference.',
        );
      } else {
        fileReference = trimmed;
      }
    }
  }

  let notes: string | null | undefined;
  if (payload.notes !== undefined) {
    if (payload.notes === null) {
      notes = null;
    } else if (typeof payload.notes !== 'string') {
      details.push('notes must be a string or null.');
    } else {
      const trimmed = payload.notes.trim();
      if (trimmed.length > 2000) {
        details.push('notes must be at most 2000 characters.');
      } else {
        notes = trimmed.length > 0 ? trimmed : null;
      }
    }
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    certificateNumber: (rawNumber as string).trim(),
    certificateName: (rawName as string).trim(),
    issuingAuthority: (rawIssuer as string).trim(),
    issueDate: issueDate as string,
    ...(expiryDate !== undefined ? { expiryDate } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(skillId !== undefined ? { skillId } : {}),
    ...(documentId !== undefined ? { documentId } : {}),
    ...(fileReference !== undefined ? { fileReference } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
}

export function validateUpdateWorkforceCertificationInput(
  body: unknown,
): UpdateWorkforceCertificationInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw AppError.validation('Request body must be a JSON object.');
  }

  const payload = body as Record<string, unknown>;
  const details: string[] = [];
  const result: UpdateWorkforceCertificationInput = {};
  let hasUpdatableField = false;

  const rawNumber = payload.certificateNumber ?? payload.number;
  if (rawNumber !== undefined) {
    hasUpdatableField = true;
    if (typeof rawNumber !== 'string') {
      details.push('certificateNumber must be a string.');
    } else {
      const trimmed = rawNumber.trim();
      if (trimmed.length < 1 || trimmed.length > 128) {
        details.push('certificateNumber must be between 1 and 128 characters.');
      } else {
        result.certificateNumber = trimmed;
      }
    }
  }

  const rawName = payload.certificateName ?? payload.name;
  if (rawName !== undefined) {
    hasUpdatableField = true;
    if (typeof rawName !== 'string') {
      details.push('certificateName must be a string.');
    } else {
      const trimmed = rawName.trim();
      if (trimmed.length < 1 || trimmed.length > 255) {
        details.push('certificateName must be between 1 and 255 characters.');
      } else {
        result.certificateName = trimmed;
      }
    }
  }

  const rawIssuer = payload.issuingAuthority ?? payload.issuer;
  if (rawIssuer !== undefined) {
    hasUpdatableField = true;
    if (typeof rawIssuer !== 'string') {
      details.push('issuingAuthority must be a string.');
    } else {
      const trimmed = rawIssuer.trim();
      if (trimmed.length < 1 || trimmed.length > 255) {
        details.push('issuingAuthority must be between 1 and 255 characters.');
      } else {
        result.issuingAuthority = trimmed;
      }
    }
  }

  const rawIssueDate = payload.issueDate ?? payload.issuedAt;
  if (rawIssueDate !== undefined) {
    hasUpdatableField = true;
    const parsed = parseIsoTimestamp(rawIssueDate, 'issueDate', details);
    if (parsed) {
      result.issueDate = parsed;
    }
  }

  const rawExpiryDate =
    payload.expiryDate !== undefined
      ? payload.expiryDate
      : payload.expiresAt !== undefined
        ? payload.expiresAt
        : payload.validUntil;
  if (rawExpiryDate !== undefined) {
    hasUpdatableField = true;
    if (rawExpiryDate === null) {
      result.expiryDate = null;
    } else {
      const parsed = parseIsoTimestamp(rawExpiryDate, 'expiryDate', details);
      if (parsed) {
        result.expiryDate = parsed;
      }
    }
  }

  if (payload.status !== undefined) {
    hasUpdatableField = true;
    if (
      typeof payload.status !== 'string' ||
      !WORKFORCE_CERTIFICATION_STATUSES.includes(
        payload.status as WorkforceCertificationStatus,
      )
    ) {
      details.push(
        `status must be one of: ${WORKFORCE_CERTIFICATION_STATUSES.join(', ')}.`,
      );
    } else {
      result.status = payload.status as WorkforceCertificationStatus;
    }
  }

  // PART 02 — verification status is never part of metadata update; the
  // dedicated verify endpoint is the only way to record a decision.
  if (payload.verificationStatus !== undefined) {
    details.push(
      'verificationStatus cannot be updated here; use POST /workforce/:workforceId/certifications/:certificationId/verify.',
    );
  }

  if (payload.skillId !== undefined) {
    hasUpdatableField = true;
    if (payload.skillId === null) {
      result.skillId = null;
    } else if (
      typeof payload.skillId !== 'string' ||
      !UUID_PATTERN.test(payload.skillId)
    ) {
      details.push('skillId must be a valid UUID or null.');
    } else {
      result.skillId = payload.skillId;
    }
  }

  if (payload.documentId !== undefined) {
    hasUpdatableField = true;
    if (payload.documentId === null) {
      result.documentId = null;
    } else if (
      typeof payload.documentId !== 'string' ||
      !UUID_PATTERN.test(payload.documentId)
    ) {
      details.push('documentId must be a valid UUID or null.');
    } else {
      result.documentId = payload.documentId;
    }
  }

  const rawFileReference =
    payload.fileReference !== undefined
      ? payload.fileReference
      : payload.storageReference;
  if (rawFileReference !== undefined) {
    hasUpdatableField = true;
    if (rawFileReference === null) {
      result.fileReference = null;
    } else if (typeof rawFileReference !== 'string') {
      details.push('fileReference must be a string or null.');
    } else {
      const trimmed = rawFileReference.trim();
      if (!isSafeCertificationFileReference(trimmed)) {
        if (details.length === 0) {
          throw workforceCertificationInvalidFileReferenceError();
        }
        details.push(
          'fileReference must be a safe relative storage key or canonical hm-ev://<uuid> reference.',
        );
      } else {
        result.fileReference = trimmed;
      }
    }
  }

  if (payload.notes !== undefined) {
    hasUpdatableField = true;
    if (payload.notes === null) {
      result.notes = null;
    } else if (typeof payload.notes !== 'string') {
      details.push('notes must be a string or null.');
    } else {
      const trimmed = payload.notes.trim();
      if (trimmed.length > 2000) {
        details.push('notes must be at most 2000 characters.');
      } else {
        result.notes = trimmed.length > 0 ? trimmed : null;
      }
    }
  }

  if (!hasUpdatableField) {
    details.push('At least one updatable field must be provided.');
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return result;
}

export function validateVerifyWorkforceCertificationInput(
  body: unknown,
): VerifyWorkforceCertificationInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw AppError.validation('Request body must be a JSON object.');
  }

  const payload = body as Record<string, unknown>;
  const details: string[] = [];

  if (
    typeof payload.verificationStatus !== 'string' ||
    !WORKFORCE_CERTIFICATION_VERIFICATION_STATUSES.includes(
      payload.verificationStatus as WorkforceCertificationVerificationStatus,
    )
  ) {
    details.push(
      `verificationStatus must be one of: ${WORKFORCE_CERTIFICATION_VERIFICATION_STATUSES.join(', ')}.`,
    );
  }

  let notes: string | null | undefined;
  if (payload.notes !== undefined) {
    if (payload.notes === null) {
      notes = null;
    } else if (typeof payload.notes !== 'string') {
      details.push('notes must be a string or null.');
    } else {
      const trimmed = payload.notes.trim();
      if (trimmed.length > 2000) {
        details.push('notes must be at most 2000 characters.');
      } else {
        notes = trimmed.length > 0 ? trimmed : null;
      }
    }
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    verificationStatus:
      payload.verificationStatus as WorkforceCertificationVerificationStatus,
    ...(notes !== undefined ? { notes } : {}),
  };
}

export function validateListWorkforceCertificationsFilter(
  query: unknown,
): ListWorkforceCertificationsFilter {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    return {};
  }

  const params = query as Record<string, unknown>;
  const details: string[] = [];
  const filter: ListWorkforceCertificationsFilter = {};

  if (params.status !== undefined) {
    if (
      typeof params.status !== 'string' ||
      !WORKFORCE_CERTIFICATION_STATUSES.includes(
        params.status as WorkforceCertificationStatus,
      )
    ) {
      details.push(
        `status must be one of: ${WORKFORCE_CERTIFICATION_STATUSES.join(', ')}.`,
      );
    } else {
      filter.status = params.status as WorkforceCertificationStatus;
    }
  }

  if (params.verificationStatus !== undefined) {
    if (
      typeof params.verificationStatus !== 'string' ||
      !WORKFORCE_CERTIFICATION_VERIFICATION_STATUSES.includes(
        params.verificationStatus as WorkforceCertificationVerificationStatus,
      )
    ) {
      details.push(
        `verificationStatus must be one of: ${WORKFORCE_CERTIFICATION_VERIFICATION_STATUSES.join(', ')}.`,
      );
    } else {
      filter.verificationStatus =
        params.verificationStatus as WorkforceCertificationVerificationStatus;
    }
  }

  if (params.skillId !== undefined) {
    if (
      typeof params.skillId !== 'string' ||
      !UUID_PATTERN.test(params.skillId)
    ) {
      details.push('skillId must be a valid UUID.');
    } else {
      filter.skillId = params.skillId;
    }
  }

  if (params.currentOnly !== undefined) {
    if (params.currentOnly === true || params.currentOnly === 'true') {
      filter.currentOnly = true;
    } else if (
      params.currentOnly === false ||
      params.currentOnly === 'false'
    ) {
      filter.currentOnly = false;
    } else {
      details.push('currentOnly must be a boolean.');
    }
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return filter;
}

/**
 * PART 02 — optional deactivation reason.
 *
 * The reason is audit metadata only: it is written to the operational event and
 * never mutates `notes`, so the certificate's own recorded metadata stays
 * exactly as the issuer documented it.
 */
export function validateDeactivateWorkforceCertificationInput(
  body: unknown,
): DeactivateWorkforceCertificationInput {
  if (body === undefined || body === null) {
    return {};
  }
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw AppError.validation('Request body must be a JSON object.', [
      'Request body must be a JSON object.',
    ]);
  }

  const payload = body as Record<string, unknown>;
  if (payload.reason === undefined || payload.reason === null) {
    return {};
  }
  if (typeof payload.reason !== 'string') {
    throw AppError.validation('Request validation failed.', [
      'reason must be a string or null.',
    ]);
  }
  const reason = payload.reason.trim();
  if (reason.length > 500) {
    throw AppError.validation('Request validation failed.', [
      'reason must be at most 500 characters.',
    ]);
  }
  return { reason: reason.length > 0 ? reason : null };
}

export const EXPIRING_CERTIFICATION_DEFAULT_DAYS = 30;
export const EXPIRING_CERTIFICATION_MAX_DAYS = 365;

/**
 * PART 02 — expiry-watch filter.
 *
 * The Client scope is never a query parameter: it is derived server-side from
 * the caller's own access. `days` is bounded so one request can neither scan
 * the whole table nor ask for an unbounded window.
 */
export function validateListExpiringWorkforceCertificationsFilter(
  query: unknown,
): ListExpiringWorkforceCertificationsFilter {
  const params =
    query && typeof query === 'object' && !Array.isArray(query)
      ? (query as Record<string, unknown>)
      : {};
  const details: string[] = [];

  let days = EXPIRING_CERTIFICATION_DEFAULT_DAYS;
  if (params.days !== undefined) {
    const raw = Array.isArray(params.days) ? params.days[0] : params.days;
    const parsed =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string' && /^-?\d+$/.test(raw.trim())
          ? Number(raw.trim())
          : Number.NaN;
    if (
      !Number.isInteger(parsed) ||
      parsed < 1 ||
      parsed > EXPIRING_CERTIFICATION_MAX_DAYS
    ) {
      details.push(
        `days must be an integer between 1 and ${EXPIRING_CERTIFICATION_MAX_DAYS}.`,
      );
    } else {
      days = parsed;
    }
  }

  let workforceProfileId: string | undefined;
  if (params.workforceProfileId !== undefined) {
    if (
      typeof params.workforceProfileId !== 'string' ||
      !UUID_PATTERN.test(params.workforceProfileId)
    ) {
      details.push('workforceProfileId must be a valid UUID.');
    } else {
      workforceProfileId = params.workforceProfileId;
    }
  }

  let verificationStatus: WorkforceCertificationVerificationStatus | undefined;
  if (params.verificationStatus !== undefined) {
    if (
      typeof params.verificationStatus !== 'string' ||
      !WORKFORCE_CERTIFICATION_VERIFICATION_STATUSES.includes(
        params.verificationStatus as WorkforceCertificationVerificationStatus,
      )
    ) {
      details.push(
        `verificationStatus must be one of: ${WORKFORCE_CERTIFICATION_VERIFICATION_STATUSES.join(', ')}.`,
      );
    } else {
      verificationStatus =
        params.verificationStatus as WorkforceCertificationVerificationStatus;
    }
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    days,
    ...(workforceProfileId !== undefined ? { workforceProfileId } : {}),
    ...(verificationStatus !== undefined ? { verificationStatus } : {}),
  };
}
