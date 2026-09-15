import { AppError, ERROR_CODES } from '../../shared/errors';

const error = (
  code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
  message: string,
  statusCode: number,
): AppError => new AppError({ code, message, statusCode });

export const permitEquipmentNotFoundError = (): AppError =>
  error(ERROR_CODES.PERMIT_EQUIPMENT_NOT_FOUND, 'Permit Equipment entry not found.', 404);
export const permitEquipmentContextInvalidError = (): AppError =>
  error(ERROR_CODES.PERMIT_EQUIPMENT_CONTEXT_INVALID, 'Permit Equipment requires a matching Application and open validity.', 400);
export const permitEquipmentInvalidError = (): AppError =>
  error(ERROR_CODES.PERMIT_EQUIPMENT_INVALID, 'Asset or Equipment reference is invalid.', 400);
export const permitEquipmentInactiveError = (): AppError =>
  error(ERROR_CODES.PERMIT_EQUIPMENT_INACTIVE, 'Asset or Equipment Profile is inactive.', 400);
export const permitEquipmentContractorMismatchError = (): AppError =>
  error(ERROR_CODES.PERMIT_EQUIPMENT_CONTRACTOR_MISMATCH, 'Equipment Contractor context does not match the Permit Contractor.', 400);
export const permitEquipmentBuildingMismatchError = (): AppError =>
  error(ERROR_CODES.PERMIT_EQUIPMENT_BUILDING_MISMATCH, 'Equipment does not belong to the Permit Building.', 400);
export const permitEquipmentCertificationInvalidError = (): AppError =>
  error(ERROR_CODES.PERMIT_EQUIPMENT_CERTIFICATION_INVALID, 'Equipment Certification is invalid or does not cover the equipment validity period.', 400);
export const permitEquipmentInspectionInvalidError = (): AppError =>
  error(ERROR_CODES.PERMIT_EQUIPMENT_INSPECTION_INVALID, 'Equipment inspection reference is invalid or incomplete.', 400);
export const permitEquipmentAlreadyActiveError = (): AppError =>
  error(ERROR_CODES.PERMIT_EQUIPMENT_ALREADY_ACTIVE, 'Asset already has an ACTIVE entry on this Permit.', 409);
export const permitEquipmentInvalidValidityError = (): AppError =>
  error(ERROR_CODES.PERMIT_EQUIPMENT_INVALID_VALIDITY, 'Equipment validity must be ordered and contained within Permit validity.', 400);
export const permitEquipmentUpdateNotAllowedError = (): AppError =>
  error(ERROR_CODES.PERMIT_EQUIPMENT_UPDATE_NOT_ALLOWED, 'Only ACTIVE Equipment on an open Permit may be updated.', 400);
export const permitEquipmentDeactivateNotAllowedError = (): AppError =>
  error(ERROR_CODES.PERMIT_EQUIPMENT_DEACTIVATE_NOT_ALLOWED, 'Only ACTIVE Permit Equipment may be deactivated.', 400);
