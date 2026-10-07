import type { PoolClient } from 'pg';
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
  tx?: Pick<PoolClient, 'query'>,
): Promise<boolean> {
  return (await resolveActiveCareActorPropertyScope({
    careActorId,
    clientId: context.clientId,
    buildingId: context.buildingId,
  }, tx)) !== null;
}

/**
 * Before binding a care exchange, re-evaluate the SAME effective occupancy
 * identities already snapshotted in that exchange. A turnover or revocation
 * between acceptance and binding must not turn an old assertion into a new
 * occupant's authority. No additional occupancy/lease master is created.
 */
export async function isCurrentCareRepresentation(
  exchange: HandoffExchangeContextSnapshot,
  tx?: Pick<PoolClient, 'query'>,
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
  if (current.clientId !== exchange.clientId ||
      current.tenantCompanyId !== exchange.tenantCompanyId ||
      current.tenantPicId !== exchange.tenantPicId ||
      current.buildingId !== exchange.buildingId ||
      current.spaceId !== exchange.spaceId ||
      current.tenantBuildingContextId !== exchange.tenantBuildingContextId ||
      current.tenantSpaceRelationshipId !== exchange.tenantSpaceRelationshipId) {
    return false;
  }
  if (tx) {
    // The existing resolver above owns occupancy validity. Hold read locks on
    // exactly its resolved identities until the enclosing request transaction
    // commits, so a concurrent turnover cannot invalidate them mid-create.
    // clock_timestamp() avoids transaction-start-time freshness drift.
    const building = await tx.query(
      `SELECT 1 FROM tenant_building_contexts
        WHERE id = $1 AND tenant_company_id = $2 AND building_id = $3
          AND status = 'ACTIVE'
          AND (effective_from IS NULL OR effective_from <= clock_timestamp())
          AND (effective_until IS NULL OR effective_until >= clock_timestamp())
        FOR SHARE`,
      [exchange.tenantBuildingContextId, exchange.tenantCompanyId, exchange.buildingId],
    );
    if (building.rowCount !== 1) return false;
    if (exchange.spaceId) {
      if (!exchange.tenantSpaceRelationshipId) return false;
      const space = await tx.query(
        `SELECT 1 FROM tenant_space_relationships
          WHERE id = $1 AND tenant_company_id = $2 AND building_id = $3
            AND space_id = $4 AND status = 'ACTIVE'
            AND (effective_from IS NULL OR effective_from <= clock_timestamp())
            AND (effective_until IS NULL OR effective_until >= clock_timestamp())
          FOR SHARE`,
        [exchange.tenantSpaceRelationshipId, exchange.tenantCompanyId,
          exchange.buildingId, exchange.spaceId],
      );
      if (space.rowCount !== 1) return false;
    }
  }
  return hasCarePropertyScope(exchange.careActorId, current, tx);
}
