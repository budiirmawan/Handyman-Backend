/**
 * R10 PART 13 — Permit To Work Register read contract.
 *
 * Backend-owned, read-only, internal (no HTTP endpoint). Consumed by the Reporting track; never
 * by operational write flows and never by the PTW approval decision path.
 *
 * The public surface is the service entry point, the required `view` authority, the query parser
 * and range helper, plus the public types — matching the sibling R10 register modules.
 *
 * The repository is deliberately NOT re-exported. It is the service's own bounded read
 * implementation, and callers — including the later PART 14 Reporting registry wiring — go
 * through `getPermitToWorkRegister`, which owns the required view discriminator, query parsing,
 * fail-closed Building-scope resolution, date-window normalization and the envelope. Exporting
 * `getPermitToWorkLifecycleRows` / `getPermitToWorkApprovalRows` directly would invite a call
 * that bypasses the authorized `buildingIds` scope, which is the only thing standing between
 * this register and another client's or building's permits.
 *
 * The PTW status vocabularies (`PERMIT_APPLICATION_STATUSES`, `PERMIT_STATUSES`,
 * `PERMIT_APPROVAL_STATUSES`, `REVIEW_DECISIONS`) are likewise NOT re-exported: they are owned
 * and published by `permit-applications`, `permits`, `permit-approvals` and `reviews`, and this
 * module only consumes those authorities.
 *
 * PART 13 wires nothing else. No route, controller, permission, Reporting dataset enum entry,
 * registry adapter, projection, OpenAPI surface or migration is added here; PART 14 owns the
 * Reporting integration and must gate it with the existing `permit.read`.
 */
export {
  getPermitToWorkRegister,
  isPermitToWorkView,
  parsePermitToWorkRegisterQuery,
  permitToWorkRegisterRange,
  permitToWorkRegisterService,
  PERMIT_TO_WORK_VIEWS,
} from './permit-to-work-register.service';
export type {
  ParsedPermitToWorkApprovalQuery,
  ParsedPermitToWorkLifecycleQuery,
  ParsedPermitToWorkQuery,
  PermitToWorkView,
  PublicPermitToWorkApproval,
  PublicPermitToWorkLifecycle,
  PublicPermitToWorkRegister,
} from './permit-to-work-register.service';
export type {
  PermitReviewStatus,
  PermitToWorkApprovalFilters,
  PermitToWorkLifecycleFilters,
  PublicPermitToWorkApprovalRow,
  PublicPermitToWorkLifecycleRow,
} from './permit-to-work-register.types';
