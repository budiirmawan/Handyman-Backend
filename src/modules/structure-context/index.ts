export { hierarchyInconsistentError } from './structure-context.errors';

export {
  resolveAreaContext,
  resolveBuildingContext,
  resolveBuildingHierarchy,
  resolveFloorContext,
  resolveFunctionalLocationContext,
  resolveRoomContext,
  resolveSpaceContext,
  structureContextService,
  validateBuildingHierarchy,
} from './structure-context.service';

export type {
  AreaHierarchy,
  AreaNode,
  BuildingHierarchy,
  FloorHierarchy,
  FloorNode,
  FunctionalLocationNode,
  HierarchyValidationResult,
  OperationalContext,
  RoomHierarchy,
  RoomNode,
  SpaceHierarchy,
  StructureNode,
} from './structure-context.types';
