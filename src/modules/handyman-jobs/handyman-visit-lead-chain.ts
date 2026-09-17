import { contextAccessService } from '../context-access';
import { buildingAccessDeniedError } from '../context-access/context-access.errors';
import { handymanWorkCrewRepository } from '../handyman-work-crews';
import { vendorWorkforceRepository } from '../vendor-workforce';
import { workforceRepository } from '../workforce';
import { handymanJobRepository } from './handyman-job.repository';

/**
 * CR-HM-BE-06 RUN 1 — the field-actor seam (BE-03C/BE-06F reuse).
 *
 * Resolves an AUTHENTICATED USER to their ACTIVE vendor workforce binding
 * ids through the existing workforce foundations only:
 *
 *   users.id → BE-03C workforce profile (findByUserId)
 *            → BE-06F vendor workforce bindings (ACTIVE)
 *
 * The caller intersects these binding ids with the governed crew authority
 * (ACTIVE crew membership with the LEAD_WORKER role — composition at
 * arrival time, or the frozen presence snapshot afterwards). NO hardcoded
 * RBAC role names are involved anywhere in this chain, helpers never
 * authenticate (they simply have no user → profile link), and no worker
 * identity is ever taken on faith from the client: an arbitrary user id
 * resolves to nothing unless the existing workforce foundations say so.
 */
export async function resolveFieldActorActiveBindingIds(
  actorUserId: string,
): Promise<string[]> {
  const profile = await workforceRepository.findByUserId(actorUserId);
  if (!profile || profile.status !== 'ACTIVE') {
    return [];
  }
  const bindings = await vendorWorkforceRepository.listByWorkforceProfileId(
    profile.id,
  );
  return bindings
    .filter((binding) => binding.status === 'ACTIVE')
    .map((binding) => binding.id);
}

/**
 * CR-HM-BE-06 RUN 3 — shared field-execution READ access (the Run-2 work
 * session read doctrine, factored for the arrival-history and presence
 * reads). Authorization is DATA SCOPE, not a lifecycle or composition
 * decision:
 *
 *   1. staff client scope through the existing BE-02G building-assignment
 *      access idiom (`contextAccessService.canAccessClient`), OR
 *   2. the actor is one of the involved recorders of the visit's field
 *      facts (arrival/presence attribution ids passed in by the caller), OR
 *   3. the actor resolves through the governed chain (user → BE-03C
 *      profile → ACTIVE BE-06F binding) onto the CURRENT composition's
 *      ACTIVE Lead Worker binding.
 *
 * No hardcoded RBAC role names; helpers never authenticate (no user link →
 * the chain resolves to nothing); denied actors get the existing 403
 * BUILDING_ACCESS_DENIED. This function never mutates, never gates a
 * lifecycle transition and never decides execution authority — the Run-1/2
 * services remain the sole owners of those decisions.
 */

/** The visit facts a field-execution read scope needs (structural). */
export type HandymanVisitExecutionReadScope = {
  clientId: string;
  handymanJobId: string;
};

export async function assertHandymanVisitExecutionReadAccess(
  visit: HandymanVisitExecutionReadScope,
  actorUserId: string,
  involvedActorUserIds: readonly string[],
): Promise<void> {
  if (await contextAccessService.canAccessClient(actorUserId, visit.clientId)) {
    return;
  }
  if (involvedActorUserIds.includes(actorUserId)) {
    return;
  }
  const actorBindingIds = await resolveFieldActorActiveBindingIds(actorUserId);
  if (actorBindingIds.length > 0) {
    const composition = await handymanJobRepository.findActiveByJobId(
      visit.handymanJobId,
    );
    if (composition) {
      const lead = await handymanWorkCrewRepository.findActiveLead(
        composition.handymanWorkCrewId,
      );
      if (lead && actorBindingIds.includes(lead.vendorWorkforceBindingId)) {
        return;
      }
    }
  }
  throw buildingAccessDeniedError();
}
