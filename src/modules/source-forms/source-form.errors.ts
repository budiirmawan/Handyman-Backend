import { AppError, ERROR_CODES } from '../../shared/errors';
export const sourceFormNotFoundError = () => new AppError({code: ERROR_CODES.SOURCE_FORM_NOT_FOUND, message:'Source form not found.', statusCode:404});
export const sourceFormCodeAlreadyExistsError = () => new AppError({code: ERROR_CODES.SOURCE_FORM_CODE_ALREADY_EXISTS, message:'A source form with this code already exists for this client.', statusCode:409});
export const sourceFormInactiveError = () => new AppError({code: ERROR_CODES.SOURCE_FORM_INACTIVE, message:'Inactive source forms cannot have templates created.', statusCode:400});
