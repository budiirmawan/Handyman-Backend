export {
  buildingAccessDeniedError,
  buildingContextRequiredError,
  invalidBuildingContextError,
} from './context-access.errors';

export {
  assertBuildingAccess,
  assertBuildingScopedResourceAccess,
  canAccessBuilding,
  canAccessBuildingScopedResource,
  canAccessClient,
  canAccessProperty,
  contextAccessService,
  getAccessibleBuildingIds,
  getAccessibleClientIds,
} from './context-access.service';
export type { BuildingScopedResourceRef } from './context-access.service';

export { requireBuildingAccess } from './context-access.middleware';
