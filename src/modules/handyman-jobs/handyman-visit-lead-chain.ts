import { vendorWorkforceRepository } from '../vendor-workforce';
import { workforceRepository } from '../workforce';

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
