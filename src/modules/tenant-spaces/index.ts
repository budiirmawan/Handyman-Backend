export { tenantSpaceRepository } from './tenant-space.repository';
export {
  assignSpaceToTenant,
  getTenantSpaceRelationship,
  listBuildingTenantSpaces,
  listTenantSpaceRelationships,
  tenantSpaceService,
  updateTenantSpaceRelationship,
} from './tenant-space.service';
export {
  TENANT_SPACE_RELATIONSHIP_STATUSES,
  isTenantSpaceRelationshipStatus,
} from './tenant-space.types';
export {
  parseAssignTenantSpaceBody,
  parseTenantSpaceBuildingIdParam,
  parseTenantSpaceCompanyIdParam,
  parseTenantSpaceRelationshipIdParam,
  parseUpdateTenantSpaceBody,
} from './tenant-space.validation';
export type {
  AssignTenantSpaceInput,
  NewTenantSpaceRelationship,
  PublicTenantSpaceRelationship,
  TenantSpaceRelationshipRecord,
  TenantSpaceRelationshipStatus,
  UpdateTenantSpaceRelationshipInput,
} from './tenant-space.types';
