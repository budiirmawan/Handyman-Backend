export {
  vendorBuildingAlreadyRelatedError,
  vendorBuildingClientMismatchError,
  vendorBuildingInactiveError,
  vendorBuildingRelationshipNotFoundError,
} from './vendor-building.errors';

export { vendorBuildingRepository } from './vendor-building.repository';

export {
  assignBuildingToVendor,
  listBuildingVendors,
  listVendorBuildings,
  toPublicVendorBuildingRelationship,
  updateVendorBuildingRelationship,
  vendorBuildingService,
} from './vendor-building.service';

export {
  VENDOR_BUILDING_RELATIONSHIP_STATUSES,
  isVendorBuildingRelationshipStatus,
} from './vendor-building.types';

export {
  parseAssignVendorBuildingBody,
  parseBuildingIdParam,
  parseUpdateVendorBuildingBody,
  parseVendorIdParam,
} from './vendor-building.validation';

export type {
  AssignVendorBuildingInput,
  NewVendorBuildingRelationship,
  PublicVendorBuildingRelationship,
  UpdateVendorBuildingRelationshipInput,
  VendorBuildingRelationshipRecord,
  VendorBuildingRelationshipStatus,
} from './vendor-building.types';

export type { ValidationDetail } from './vendor-building.validation';
