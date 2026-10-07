export {
  propertyCodeAlreadyExistsError,
  propertyInactiveError,
  propertyNotFoundError,
} from './property.errors';

export { propertyRepository } from './property.repository';

export {
  createProperty,
  getPropertyById,
  listProperties,
  listPropertiesByClient,
  propertyService,
  toPublicProperty,
  updatePropertyStatus,
} from './property.service';

export {
  PROPERTY_STATUSES,
  isPropertyStatus,
} from './property.types';

export {
  isValidPropertyCode,
  normalizePropertyCode,
  parseCreatePropertyBody,
  parsePropertyClientIdParam,
  parsePropertyIdParam,
  parseUpdatePropertyStatusBody,
} from './property.validation';

export type {
  CreatePropertyInput,
  NewProperty,
  PropertyRecord,
  PropertyStatus,
  PublicProperty,
  UpdatePropertyStatusInput,
} from './property.types';

export type { ValidationDetail } from './property.validation';
