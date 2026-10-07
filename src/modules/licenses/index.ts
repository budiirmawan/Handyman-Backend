export {
  licenseAlreadyActiveError,
  licenseNotFoundError,
} from './license.errors';

export { licenseRepository } from './license.repository';

export {
  createLicense,
  getLicenseById,
  getLicenseEffectiveState,
  isLicenseEffective,
  licenseService,
  listLicensesBySubscriptionId,
  toPublicLicense,
  updateLicenseStatus,
  validateLicensePeriod,
} from './license.service';

export {
  LICENSE_STATUSES,
  isLicenseStatus,
} from './license.types';

export {
  parseCreateLicenseBody,
  parseLicenseIdParam,
  parseLicenseSubscriptionIdParam,
  parseUpdateLicenseStatusBody,
} from './license.validation';

export type {
  CreateLicenseInput,
  LicenseEffectiveState,
  LicenseRecord,
  LicenseStatus,
  NewLicense,
  PublicLicense,
  UpdateLicenseStatusInput,
} from './license.types';

export type { ValidationDetail } from './license.validation';
