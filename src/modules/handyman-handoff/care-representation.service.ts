import { AppError } from '../../shared/errors';
import { resolveActiveCareActorPropertyScope } from '../handyman-care-actors/handyman-care-property-scope.service';
import { resolveHandoffContext } from './handoff-context.service';
import type { ResolvedHandoffContext } from './handoff-context.types';
import type { HandoffExchangeContextSnapshot } from './handoff-runtime.types';

/**
 * PART 03: a Customer Care property grant is independent of the represented
 * tenant, its effective occupancy, and the BM channel. The resolver derives
 * Property from Building; neither a claimed property nor Client-wide access
 * is sufficient. Legacy assertions never call this seam.
 */
export async function hasCarePropertyScope(
  careActorId: string,
  context: Pick<ResolvedHandoffContext, 'clientId' | 'buildingId'>,
): Promise<boolean> {
  return (await resolveActiveCareActorPropertyScope({
    careActorId,
    clientId: context.clientId,
    buildingId: context.buildingId,
  })) !== null;
}

/**
 * Before binding a care exchange, re-evaluate the SAME effective occupancy
 * identities already snapshotted in that exchange. A turnover or revocation
 * between acceptance and binding must not turn an old assertion into a new
 * occupant's authority. No additional occupancy/lease master is created.
 */
export async function isCurrentCareRepresentation(
  exchange: HandoffExchangeContextSnapshot,
): Promise<boolean> {
  if (exchange.actorType !== 'CUSTOMER_CARE' || !exchange.careActorId) {
    return false;
  }
  let current: ResolvedHandoffContext;
  try {
    current = await resolveHandoffContext({
      tenantCompanyId: exchange.tenantCompanyId,
      buildingId: exchange.buildingId,
      ...(exchange.tenantPicId ? { tenantPicId: exchange.tenantPicId } : {}),
      ...(exchange.spaceId ? { spaceId: exchange.spaceId } : {}),
    });
  } catch (error) {
    if (error instanceof AppError) return false;
    throw error;
  }
  return current.clientId === exchange.clientId &&
    current.tenantCompanyId === exchange.tenantCompanyId &&
    current.tenantPicId === exchange.tenantPicId &&
    current.buildingId === exchange.buildingId &&
    current.spaceId === exchange.spaceId &&
    current.tenantBuildingContextId === exchange.tenantBuildingContextId &&
    current.tenantSpaceRelationshipId === exchange.tenantSpaceRelationshipId &&
    await hasCarePropertyScope(exchange.careActorId, current);
}
