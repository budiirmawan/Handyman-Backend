/**
 * R11 PART 01 — Receiving Register read contract.
 *
 * Backend-owned, read-only, internal (no HTTP endpoint). Prepared for the
 * Reporting track (RECEIVING_REGISTER adapter lands in a later R11 PART);
 * never consumed by operational write flows. The receivings module stays
 * the sole receiving authority — this is a bounded read model over its
 * persisted facts, request-anchored, with no purchase-order inference and
 * no monetary field.
 */
export { receivingRegisterRepository } from './receiving-register.repository';
export {
  getReceivingRegister,
  parseReceivingRegisterQuery,
  receivingRegisterRange,
  receivingRegisterService,
} from './receiving-register.service';
export type {
  PublicReceivingRegister,
  PublicReceivingRegisterRow,
  ReceivingRegisterFilters,
} from './receiving-register.types';
