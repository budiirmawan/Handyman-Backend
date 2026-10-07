export {
  vendorLicenseAlreadyActiveError,
  vendorLicenseDocumentMismatchError,
  vendorLicenseNotFoundError,
  vendorLicenseStatusDateMismatchError,
} from './vendor-license.errors';

export { vendorLicenseRepository } from './vendor-license.repository';

export {
  createVendorLicense,
  getVendorLicenseById,
  listCurrentVendorLicenses,
  listVendorLicensesByVendor,
  resolveExpiryStatus,
  toPublicVendorLicense,
  updateVendorLicense,
  vendorLicenseService,
} from './vendor-license.service';

export {
  VENDOR_LICENSE_EXPIRY_STATUSES,
  VENDOR_LICENSE_RECORD_TYPES,
  VENDOR_LICENSE_STATUSES,
  isVendorLicenseRecordType,
  isVendorLicenseStatus,
} from './vendor-license.types';

export {
  parseCreateVendorLicenseBody,
  parseUpdateVendorLicenseBody,
  parseVendorLicenseIdParam,
  parseVendorLicenseVendorIdParam,
} from './vendor-license.validation';

export type {
  CreateVendorLicenseInput,
  NewVendorLicense,
  PublicVendorLicense,
  UpdateVendorLicenseInput,
  VendorLicenseExpiryStatus,
  VendorLicenseRecord,
  VendorLicenseRecordType,
  VendorLicenseStatus,
} from './vendor-license.types';

export type { ValidationDetail } from './vendor-license.validation';
