/**
 * CR-BE-REPORT-READ-02 PART 01 — Finding Register read contract.
 *
 * Backend-owned, read-only, internal (no HTTP endpoint). Consumed by the
 * Reporting track; never by operational write flows.
 */
export { findingRegisterRepository } from './finding-register.repository';
export {
  findingRegisterRange,
  findingRegisterService,
  getFindingRegister,
  parseFindingRegisterQuery,
} from './finding-register.service';
export type {
  FindingRegisterFilters,
  PublicFindingRegister,
  PublicFindingRegisterRow,
} from './finding-register.types';
