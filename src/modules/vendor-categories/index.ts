export {
  vendorCategoryClientMismatchError,
  vendorCategoryCodeAlreadyExistsError,
  vendorCategoryInactiveError,
  vendorCategoryNotFoundError,
} from './vendor-category.errors';

export { vendorCategoryRepository } from './vendor-category.repository';

export {
  createVendorCategory,
  getVendorCategoryById,
  listVendorCategoriesByClient,
  toPublicVendorCategory,
  updateVendorCategory,
  updateVendorCategoryStatus,
  vendorCategoryService,
} from './vendor-category.service';

export {
  VENDOR_CATEGORY_STATUSES,
  isVendorCategoryStatus,
} from './vendor-category.types';

export {
  isValidVendorCategoryCode,
  normalizeVendorCategoryCode,
  parseCreateVendorCategoryBody,
  parseUpdateVendorCategoryBody,
  parseUpdateVendorCategoryStatusBody,
  parseVendorCategoryClientIdParam,
  parseVendorCategoryIdParam,
} from './vendor-category.validation';

export type {
  CreateVendorCategoryInput,
  NewVendorCategory,
  PublicVendorCategory,
  UpdateVendorCategoryInput,
  UpdateVendorCategoryStatusInput,
  VendorCategoryRecord,
  VendorCategoryStatus,
} from './vendor-category.types';

export type { ValidationDetail } from './vendor-category.validation';
