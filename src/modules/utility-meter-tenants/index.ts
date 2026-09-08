export {
  utilityMeterTenantAssignmentAlreadyExistsError,
  utilityMeterTenantAssignmentNotFoundError,
  utilityMeterTenantClientMismatchError,
  utilityMeterTenantContextUnavailableError,
  utilityMeterTenantSpaceMismatchError,
} from './utility-meter-tenant.errors';

export { utilityMeterTenantRepository } from './utility-meter-tenant.repository';

export {
  assignMeterToTenant,
  endUtilityMeterTenantAssignment,
  getUtilityMeterTenantAssignmentById,
  listAssignmentsByMeter,
  listAssignmentsBySpace,
  listAssignmentsByTenantCompany,
  resolveCurrentTenantAssignment,
  toPublicUtilityMeterTenantAssignment,
  updateUtilityMeterTenantAssignment,
  utilityMeterTenantService,
} from './utility-meter-tenant.service';

export {
  UTILITY_METER_TENANT_ASSIGNMENT_STATUSES,
  isUtilityMeterTenantAssignmentStatus,
} from './utility-meter-tenant.types';

export {
  parseAssignMeterToTenantBody,
  parseEndUtilityMeterTenantAssignmentBody,
  parseTenantAssignmentMeterIdParam,
  parseTenantAssignmentSpaceIdParam,
  parseTenantAssignmentTenantIdParam,
  parseUpdateUtilityMeterTenantAssignmentBody,
  parseUtilityMeterTenantAssignmentIdParam,
  parseUtilityMeterTenantAssignmentStatusQuery,
} from './utility-meter-tenant.validation';

export type {
  AssignMeterToTenantInput,
  NewUtilityMeterTenantAssignment,
  PublicUtilityMeterTenantAssignment,
  TenantAssignmentMeterSummary,
  TenantAssignmentSpaceSummary,
  TenantAssignmentTenantSummary,
  UpdateUtilityMeterTenantAssignmentInput,
  UtilityMeterTenantAssignmentFilters,
  UtilityMeterTenantAssignmentRecord,
  UtilityMeterTenantAssignmentStatus,
} from './utility-meter-tenant.types';

export type { ValidationDetail } from './utility-meter-tenant.validation';

export { createUtilityMeterTenantRouter } from './utility-meter-tenant.routes';
