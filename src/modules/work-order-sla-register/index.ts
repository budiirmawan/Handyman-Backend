/**
 * R10 PART 07 — Work Order SLA Register read contract.
 *
 * Backend-owned, read-only, internal (no HTTP endpoint). Consumed by the Reporting
 * track; never by operational write flows.
 *
 * The public surface is the service entry point plus the public types, matching the
 * sibling register modules. The repository is deliberately NOT re-exported: it is the
 * service's own bounded read implementation, and callers — including the later
 * Reporting registry wiring — go through `getWorkOrderSlaRegister`, which owns scope
 * resolution, the frozen `asOf` instant and the envelope. Exporting the row reader
 * directly would invite a call that bypasses the fail-closed Building scope.
 *
 * No route, controller, permission, Reporting dataset enum entry, registry adapter,
 * OpenAPI surface or migration is added by this module.
 */
export {
  getWorkOrderSlaRegister,
  parseWorkOrderSlaRegisterQuery,
  workOrderSlaRegisterRange,
  workOrderSlaRegisterService,
} from './work-order-sla-register.service';
export type {
  PublicWorkOrderSlaRegister,
  PublicWorkOrderSlaRow,
  WorkOrderSlaRegisterFilters,
} from './work-order-sla-register.types';
