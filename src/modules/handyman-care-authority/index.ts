export {
  careAuthorityDeniedError,
  careIdentityNotAcceptedError,
} from './handyman-care-authority.errors';

export {
  assertBuildingCareAuthority,
  buildingCareAuthorityService,
  DECISION_AUTHORITY_BLOCKED,
  GENERIC_TENANT_COMPANY_MANAGE_PERMISSION,
  HANDYMAN_CARE_BUILDING_PERMISSION,
  NON_ACCEPTED_IDENTITY_FIELDS,
  resolveBuildingCareAuthority,
} from './handyman-care-authority.service';

export {
  assertNoSuppliedRecordingIdentity,
  parseBuildingIdParam,
  parseOptionalClientIdParam,
} from './handyman-care-authority.validation';

export {
  CARE_AUTHORITY_ROLE,
  CARE_IDENTITY_SOURCES,
} from './handyman-care-authority.types';

export type {
  BuildingCareAuthority,
  CareAuthorityCapabilities,
  CareAuthorityRole,
  CareBuildingScope,
  CareIdentitySource,
  PublicBuildingCareAuthority,
  ResolveBuildingCareAuthorityInput,
} from './handyman-care-authority.types';
