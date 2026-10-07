import { AppError, ERROR_CODES } from '../../shared/errors';

export function esgWasteRecordNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.ESG_WASTE_RECORD_NOT_FOUND,
    message: 'ESG waste record not found.',
    statusCode: 404,
  });
}

export function esgWasteRecordNotActiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.ESG_WASTE_RECORD_NOT_ACTIVE,
    message: 'ESG waste record is not ACTIVE; deactivation is terminal in v1.',
    statusCode: 409,
  });
}

export function esgWasteRecordBuildingNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.ESG_WASTE_RECORD_BUILDING_NOT_FOUND,
    message: 'The referenced Building was not found.',
    statusCode: 404,
  });
}

export function esgWasteRecordBuildingInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.ESG_WASTE_RECORD_BUILDING_INACTIVE,
    message: 'The referenced Building is not ACTIVE.',
    statusCode: 400,
  });
}

export function esgWasteRecordFlocNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.ESG_WASTE_RECORD_FLOC_NOT_FOUND,
    message: 'The referenced Functional Location was not found.',
    statusCode: 404,
  });
}

export function esgWasteRecordFlocBuildingMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.ESG_WASTE_RECORD_FLOC_BUILDING_MISMATCH,
    message: 'The referenced Functional Location belongs to a different Building.',
    statusCode: 400,
  });
}

export function esgWasteRecordUomNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.ESG_WASTE_RECORD_UOM_NOT_FOUND,
    message: 'The referenced UOM was not found.',
    statusCode: 404,
  });
}

export function esgWasteRecordUomInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.ESG_WASTE_RECORD_UOM_INACTIVE,
    message: 'The referenced UOM is not ACTIVE.',
    statusCode: 400,
  });
}

export function esgWasteRecordUomClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.ESG_WASTE_RECORD_UOM_CLIENT_MISMATCH,
    message: 'The referenced UOM belongs to a different Client.',
    statusCode: 400,
  });
}

export function esgWasteRecordVendorNotFoundError(): AppError {
  return new AppError({
    code: ERROR_CODES.ESG_WASTE_RECORD_VENDOR_NOT_FOUND,
    message: 'The referenced Vendor was not found.',
    statusCode: 404,
  });
}

export function esgWasteRecordVendorInactiveError(): AppError {
  return new AppError({
    code: ERROR_CODES.ESG_WASTE_RECORD_VENDOR_INACTIVE,
    message: 'The referenced Vendor is not ACTIVE.',
    statusCode: 400,
  });
}

export function esgWasteRecordVendorClientMismatchError(): AppError {
  return new AppError({
    code: ERROR_CODES.ESG_WASTE_RECORD_VENDOR_CLIENT_MISMATCH,
    message: 'The referenced Vendor belongs to a different Client.',
    statusCode: 400,
  });
}
