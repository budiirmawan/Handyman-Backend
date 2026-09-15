/**
 * CR-BE-REPORT-READ-01 PART 01 — Vendor Service Register read contract.
 *
 * Backend-owned, read-only, internal (no HTTP endpoint). Consumed by the
 * Reporting track; never by operational write flows.
 */
export { vendorServiceRegisterRepository } from './vendor-service-register.repository';
export {
  getVendorServiceRegister,
  parseVendorServiceRegisterQuery,
  vendorServiceRegisterRange,
  vendorServiceRegisterService,
} from './vendor-service-register.service';
export type {
  PublicVendorServiceRegister,
  PublicVendorServiceRegisterRow,
  VendorServiceRegisterFilters,
} from './vendor-service-register.types';
