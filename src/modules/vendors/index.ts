export {
  vendorCodeAlreadyExistsError,
  vendorInactiveError,
  vendorNotFoundError,
} from './vendor.errors';

export { vendorRepository } from './vendor.repository';

export {
  createVendor,
  getVendorById,
  listVendorsByClient,
  toPublicVendor,
  updateVendor,
  updateVendorStatus,
  vendorService,
} from './vendor.service';

export { VENDOR_STATUSES, isVendorStatus } from './vendor.types';

export {
  isValidVendorCode,
  normalizeVendorCode,
  parseCreateVendorBody,
  parseUpdateVendorBody,
  parseUpdateVendorStatusBody,
  parseVendorClientIdParam,
  parseVendorIdParam,
} from './vendor.validation';

export type {
  CreateVendorInput,
  NewVendor,
  PublicVendor,
  UpdateVendorInput,
  UpdateVendorStatusInput,
  VendorRecord,
  VendorStatus,
} from './vendor.types';

export type { ValidationDetail } from './vendor.validation';
