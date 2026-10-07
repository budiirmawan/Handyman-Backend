import { AppError, ERROR_CODES } from '../../shared/errors';

const error = (
  code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
  message: string,
  statusCode: number,
): AppError => new AppError({ code, message, statusCode });

export const contractorContextInvalidError = (): AppError =>
  error(
    ERROR_CODES.CONTRACTOR_CONTEXT_INVALID,
    'Contractor context does not resolve to an existing Tenant or Vendor contractor.',
    400,
  );

export const contractorContextInactiveError = (): AppError =>
  error(
    ERROR_CODES.CONTRACTOR_CONTEXT_INACTIVE,
    'Contractor or its required operational relationship is inactive or outside its effective period.',
    400,
  );

export const contractorContextBuildingMismatchError = (): AppError =>
  error(
    ERROR_CODES.CONTRACTOR_CONTEXT_BUILDING_MISMATCH,
    'Contractor context does not belong to the requested Client and Building.',
    400,
  );

export const contractorContextBuildingRequiredError = (): AppError =>
  error(
    ERROR_CODES.CONTRACTOR_CONTEXT_BUILDING_REQUIRED,
    'buildingId is required to resolve a Vendor Contractor context.',
    400,
  );
