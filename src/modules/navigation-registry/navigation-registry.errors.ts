import { AppError, ERROR_CODES } from '../../shared/errors';

export const navigationItemNotFoundError = () => new AppError({ code: ERROR_CODES.NAVIGATION_ITEM_NOT_FOUND, message: 'Navigation item not found.', statusCode: 404 });
export const navigationKeyAlreadyExistsError = () => new AppError({ code: ERROR_CODES.NAVIGATION_KEY_ALREADY_EXISTS, message: 'Navigation key already exists for the selected scope.', statusCode: 409 });
export const navigationParentNotFoundError = () => new AppError({ code: ERROR_CODES.NAVIGATION_PARENT_NOT_FOUND, message: 'Parent navigation key is not available in the selected scope.', statusCode: 400 });
export const navigationFeatureNotFoundError = () => new AppError({ code: ERROR_CODES.NAVIGATION_FEATURE_NOT_FOUND, message: 'Feature binding is not configured for the selected scope.', statusCode: 400 });
export const navigationHierarchyInvalidError = () => new AppError({ code: ERROR_CODES.NAVIGATION_HIERARCHY_INVALID, message: 'Navigation parent hierarchy is invalid.', statusCode: 400 });
