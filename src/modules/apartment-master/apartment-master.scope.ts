import { buildingNotFoundError, buildingRepository } from '../buildings';
import { contextAccessService } from '../context-access';
import { propertyNotFoundError, propertyRepository } from '../properties';

/**
 * CR-HM-MASTER-IND-01 — one server-side Building scope resolver for the
 * apartment master surfaces.
 *
 * The caller NEVER supplies a Client: it is derived from Building → Property.
 * Access is the existing BE-02 assignment rule (`assertBuildingAccess`), so a
 * caller with a permission but no ACTIVE assignment to the exact Building is
 * denied with the standard non-enumerating BUILDING_ACCESS_DENIED (403).
 * An INACTIVE Building/Property is indistinguishable from a missing one.
 */
export async function resolveApartmentBuildingScope(input: {
  actorUserId: string;
  buildingId: string;
}): Promise<{ clientId: string; buildingId: string; propertyId: string }> {
  const building = await buildingRepository.findById(input.buildingId);
  if (!building) throw buildingNotFoundError();

  const property = await propertyRepository.findById(building.propertyId);
  if (!property) throw propertyNotFoundError();

  await contextAccessService.assertBuildingAccess(
    input.actorUserId,
    input.buildingId,
  );

  if (building.status !== 'ACTIVE' || property.status !== 'ACTIVE') {
    throw buildingNotFoundError();
  }

  return {
    clientId: property.clientId,
    buildingId: building.id,
    propertyId: property.id,
  };
}
