import { areaRepository } from '../areas';
import { buildingRepository } from '../buildings';
import { floorRepository } from '../floors';
import { propertyRepository } from '../properties';
import { roomRepository } from '../rooms';
import { spaceRepository } from '../spaces';
import { tenantBuildingContextRepository } from '../tenant-building-contexts';
import {
  tenantCompanyNotFoundError,
  tenantCompanyRepository,
} from '../tenant-companies';
import { tenantPicRepository } from '../tenant-pics';
import { tenantSpaceRepository } from '../tenant-spaces';
import { userRepository } from '../users';
import {
  handoffContextInvalidError,
  handoffRequesterInvalidError,
  handoffSpaceMismatchError,
} from './handoff-context.errors';
import type {
  HandoffContextClaims,
  ResolvedHandoffContext,
} from './handoff-context.types';

/**
 * CR-HM-01 PART 02 — Trusted Handoff Context Resolver.
 *
 * Dedicated seam: converts already-authenticated/trusted handoff claims into
 * a validated canonical Handyman customer/building/unit context. This
 * service does NOT authenticate the BM origin (D1), does NOT decide the
 * session model (D2), and performs NO persistence side effects. Generic auth
 * and context-access semantics are reused unchanged — nothing in this module
 * makes an untrusted payload trusted.
 */

function isEffectiveNow(record: {
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
}): boolean {
  const now = Date.now();
  if (record.effectiveFrom && record.effectiveFrom.getTime() > now) return false;
  if (record.effectiveUntil && record.effectiveUntil.getTime() < now) return false;
  return true;
}

/** Physical space → building chain (same depth as tenant-space governance). */
async function resolveSpaceBuildingId(spaceId: string): Promise<string | null> {
  const space = await spaceRepository.findById(spaceId);
  if (!space) return null;
  const room = await roomRepository.findById(space.roomId);
  if (!room) return null;
  const area = await areaRepository.findById(room.areaId);
  if (!area) return null;
  const floor = await floorRepository.findById(area.floorId);
  return floor ? floor.buildingId : null;
}

export async function resolveHandoffContext(
  claims: HandoffContextClaims,
): Promise<ResolvedHandoffContext> {
  // Tenant/customer identity (existing TSR convention: unknown company 404).
  const company = await tenantCompanyRepository.findById(claims.tenantCompanyId);
  if (!company) throw tenantCompanyNotFoundError();
  if (company.status !== 'ACTIVE') throw handoffContextInvalidError();

  // Building context — unknown/foreign/inactive all collapse (no leak).
  const building = await buildingRepository.findById(claims.buildingId);
  if (!building || building.status !== 'ACTIVE') {
    throw handoffContextInvalidError();
  }

  // Client/tenant isolation: derived, never claimed.
  const property = await propertyRepository.findById(building.propertyId);
  if (!property || property.clientId !== company.clientId) {
    throw handoffContextInvalidError();
  }

  // Active tenant-building relationship (customer context != building
  // authorization: this proves context existence, not user access).
  const context = await tenantBuildingContextRepository.findActive(
    company.id,
    building.id,
  );
  if (!context || !isEffectiveNow(context)) {
    throw handoffContextInvalidError();
  }

  // Customer person + optional local user linkage (no session created).
  let tenantPicId: string | null = null;
  let resolvedUserId: string | null = null;
  if (claims.tenantPicId !== undefined) {
    const requester = await tenantPicRepository.findById(claims.tenantPicId);
    if (
      !requester ||
      requester.tenantCompanyId !== company.id ||
      requester.status !== 'ACTIVE'
    ) {
      throw handoffRequesterInvalidError();
    }
    tenantPicId = requester.id;
    if (requester.userId !== null) {
      const linkedUser = await userRepository.findById(requester.userId);
      if (!linkedUser) throw handoffRequesterInvalidError();
      resolvedUserId = linkedUser.id;
    }
  }

  // Unit/space authorization is a separate check from building context.
  let spaceId: string | null = null;
  let tenantSpaceRelationshipId: string | null = null;
  if (claims.spaceId !== undefined) {
    const actualBuildingId = await resolveSpaceBuildingId(claims.spaceId);
    if (actualBuildingId !== building.id) throw handoffSpaceMismatchError();
    const relationship =
      await tenantSpaceRepository.findActiveByTenantBuildingAndSpace(
        company.id,
        building.id,
        claims.spaceId,
      );
    if (!relationship || !isEffectiveNow(relationship)) {
      throw handoffSpaceMismatchError();
    }
    spaceId = claims.spaceId;
    tenantSpaceRelationshipId = relationship.id;
  }

  return {
    clientId: company.clientId,
    tenantCompanyId: company.id,
    tenantPicId,
    buildingId: building.id,
    spaceId,
    tenantBuildingContextId: context.id,
    tenantSpaceRelationshipId,
    resolvedUserId,
  };
}

export const handoffContextResolver = {
  resolveHandoffContext,
};
