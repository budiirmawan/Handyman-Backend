import { AppError, ERROR_CODES } from '../../shared/errors';
const error = (code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES], message: string, statusCode: number) =>
  new AppError({ code, message, statusCode });
export const permitEvidencePermitInvalidError = () =>
  error(ERROR_CODES.PERMIT_EVIDENCE_PERMIT_INVALID, 'Permit evidence context is invalid.', 400);
export const permitEvidenceContextMismatchError = () =>
  error(ERROR_CODES.PERMIT_EVIDENCE_CONTEXT_MISMATCH, 'Evidence Contractor or Building context does not match the Permit.', 400);
export const permitEvidenceRequirementInvalidError = () =>
  error(ERROR_CODES.PERMIT_EVIDENCE_REQUIREMENT_INVALID, 'Evidence Requirement does not belong to this Permit.', 400);
export const permitEvidenceTypeMismatchError = () =>
  error(ERROR_CODES.PERMIT_EVIDENCE_TYPE_MISMATCH, 'Evidence type or MIME type does not match the requirement.', 400);
export const permitEvidenceCountViolationError = () =>
  error(ERROR_CODES.PERMIT_EVIDENCE_COUNT_VIOLATION, 'Evidence count exceeds the configured maximum.', 400);
export const permitEvidenceNotFoundError = () =>
  error(ERROR_CODES.PERMIT_EVIDENCE_NOT_FOUND, 'Permit Evidence not found.', 404);
export const permitEvidenceAlreadyRemovedError = () =>
  error(ERROR_CODES.PERMIT_EVIDENCE_ALREADY_REMOVED, 'Permit Evidence is already removed.', 409);
export const permitEvidenceRequirementAlreadyExistsError = () =>
  error(ERROR_CODES.PERMIT_EVIDENCE_REQUIREMENT_ALREADY_EXISTS, 'An active Permit Evidence Requirement of this type already exists.', 409);
