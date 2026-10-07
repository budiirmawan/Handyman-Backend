/**
 * CR-BE-REPORT-READ-03 PART 01 — Work Order Register read contract.
 *
 * Backend-owned, read-only, internal (no HTTP endpoint). Consumed by the
 * Reporting track; never by operational write flows.
 */
export { workOrderRegisterRepository } from './work-order-register.repository';
export {
  getWorkOrderRegister,
  parseWorkOrderRegisterQuery,
  workOrderRegisterRange,
  workOrderRegisterService,
} from './work-order-register.service';
export type {
  PublicWorkOrderRegister,
  PublicWorkOrderRegisterRow,
  WorkOrderRegisterFilters,
} from './work-order-register.types';
