import { AppError, ERROR_CODES } from '../../shared/errors';

const error = (code: keyof typeof ERROR_CODES, message: string, statusCode: number) =>
  new AppError({ code: ERROR_CODES[code], message, statusCode });
export const buildingUtilityReconciliationNotFoundError = () =>
  error('BUILDING_UTILITY_RECONCILIATION_NOT_FOUND', 'Building utility reconciliation not found.', 404);
export const buildingUtilityReconciliationNoSourceError = () =>
  error('BUILDING_UTILITY_RECONCILIATION_NO_SOURCE', 'No authoritative ACTUAL-reading source consumption exists for this Building period.', 400);
export const buildingUtilityReconciliationUomMismatchError = () =>
  error('BUILDING_UTILITY_RECONCILIATION_UOM_MISMATCH', 'Reconciliation consumptions must use one matching UOM.', 400);
export const buildingUtilityReconciliationAreaMissingError = () =>
  error('BUILDING_UTILITY_RECONCILIATION_AREA_MISSING', 'No positive applicable area is configured on active Building Spaces.', 400);
export const buildingUtilityReconciliationDuplicateError = () =>
  error('BUILDING_UTILITY_RECONCILIATION_ALREADY_EXISTS', 'A reconciliation already exists for this Building, utility type, and period.', 409);
