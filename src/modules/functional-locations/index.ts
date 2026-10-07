export {
  functionalLocationBuildingInactiveError,
  functionalLocationCodeAlreadyExistsError,
  functionalLocationNotFoundError,
  functionalLocationSpaceMismatchError,
} from './functional-location.errors';

export { functionalLocationRepository } from './functional-location.repository';

export {
  createFunctionalLocation,
  functionalLocationService,
  getFunctionalLocationById,
  listFunctionalLocationsByBuilding,
  toPublicFunctionalLocation,
  updateFunctionalLocation,
  updateFunctionalLocationStatus,
} from './functional-location.service';

export {
  FUNCTIONAL_LOCATION_STATUSES,
  isFunctionalLocationStatus,
} from './functional-location.types';

export {
  isValidFunctionalLocationCode,
  normalizeFunctionalLocationCode,
  parseCreateFunctionalLocationBody,
  parseFunctionalLocationBuildingIdParam,
  parseFunctionalLocationIdParam,
  parseSpaceIdQuery,
  parseUpdateFunctionalLocationBody,
  parseUpdateFunctionalLocationStatusBody,
} from './functional-location.validation';

export type {
  CreateFunctionalLocationInput,
  FunctionalLocationRecord,
  FunctionalLocationStatus,
  NewFunctionalLocation,
  PublicFunctionalLocation,
  UpdateFunctionalLocationInput,
  UpdateFunctionalLocationStatusInput,
} from './functional-location.types';

export type { ValidationDetail } from './functional-location.validation';
