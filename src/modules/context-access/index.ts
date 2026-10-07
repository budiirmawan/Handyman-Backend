export {
  buildingAccessDeniedError,
  buildingContextRequiredError,
  invalidBuildingContextError,
} from './context-access.errors';

export {
  assertBuildingAccess,
  canAccessBuilding,
  canAccessClient,
  canAccessProperty,
  contextAccessService,
  getAccessibleBuildingIds,
  getAccessibleClientIds,
} from './context-access.service';

export { requireBuildingAccess } from './context-access.middleware';
