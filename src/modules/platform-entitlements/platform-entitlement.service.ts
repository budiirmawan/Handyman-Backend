/**
 * CR-BE-SAAS-01 PART 04 — SaaS entitlement platform service (SaaS Control
 * Plane).
 *
 * Frozen §22 entitlement surface (exactly two routes):
 *
 *   GET  /platform/subscriptions/:id/entitlements  (platform.subscription.read)
 *        — resolved entitlements incl. limits: the extended §12.1
 *          resolver's effective capability grants plus the bound package's
 *          limit definitions (§9.4).
 *
 *   POST /platform/subscriptions/:id/entitlements  (platform.subscription.manage, ver)
 *        — console OVERRIDE (reason mandatory, audited
 *          SAAS_ENTITLEMENT_OVERRIDDEN). The one-active-per-(subscription,
 *          capability) slot passes to the OVERRIDE grant; PACKAGE-derived
 *          rows are never hand-editable — the console can only add or
 *          withhold grants through this command.
 *
 * Concurrency (frozen §17.3): the route is "ver" — the command applies the
 * subscription's `expectedVersion` guard (row-locked, version-bumped) and
 * 409s VERSION_CONFLICT on stale versions; no separate entitlement version
 * column is invented (module_entitlements is not in the §17.3 aggregate
 * list). No Idempotency-Key (the frozen §17.2 operation-key catalog defines
 * none for entitlements; the command is retry-safe under the version guard).
 */
import { withTransaction } from '../../database';
import {
  applyEntitlementOverride,
  isSubscriptionEffectivelyLicensed,
  resolveEffectiveEntitlements,
  toPublicEntitlement,
  type PublicEntitlement,
} from '../entitlements';
import {
  saasSubscriptionNotFoundError,
  saasSubscriptionVersionConflictError,
} from '../platform-subscriptions/platform-subscription.errors';
import { platformSubscriptionRepository } from '../platform-subscriptions/platform-subscription.repository';
import { platformProductRepository } from '../platform-products';
import {
  isSubscriptionEffective,
} from '../subscriptions';
import type {
  OverrideSaasEntitlementInput,
  PublicSaasEntitlementResolved,
} from './platform-entitlement.types';

/**
 * GET /platform/subscriptions/:id/entitlements — resolved entitlements
 * including limits (frozen §22).
 */
export async function getSaasEntitlements(
  subscriptionId: string,
  now: Date = new Date(),
): Promise<PublicSaasEntitlementResolved> {
  const record = await platformSubscriptionRepository.findById(subscriptionId);
  if (!record) throw saasSubscriptionNotFoundError(subscriptionId);

  const grants = await resolveEffectiveEntitlements(subscriptionId, now);
  const effective =
    isSubscriptionEffective(record, now) &&
    (await isSubscriptionEffectivelyLicensed(record, now));

  let limits: PublicSaasEntitlementResolved['limits'] = [];
  if (record.packageId) {
    const packageLimits = await platformProductRepository.findLimitsByPackageId(
      record.packageId,
    );
    limits = packageLimits.map((row) => ({
      limitKey: row.limitKey,
      limitValue: row.limitValue,
      unit: row.unit,
      source: 'PACKAGE' as const,
    }));
  }

  return {
    subscriptionId: record.id,
    clientId: record.clientId,
    subscriptionStatus: record.status,
    effective,
    capabilities: grants.map((grant) => ({
      capabilityCode: grant.code,
      enabled: true,
      source: grant.source,
      limit: grant.limit,
      effectiveFrom: grant.effectiveFrom.toISOString(),
      effectiveUntil: grant.effectiveUntil
        ? grant.effectiveUntil.toISOString()
        : null,
    })),
    limits,
  };
}

/**
 * POST /platform/subscriptions/:id/entitlements — console OVERRIDE
 * (frozen §22: ver, reason mandatory, audited).
 */
export async function overrideSaasEntitlement(
  actorUserId: string,
  authority: string,
  subscriptionId: string,
  input: OverrideSaasEntitlementInput,
): Promise<{ entitlement: PublicEntitlement | null; version: number; changed: boolean }> {
  return withTransaction(async (client) => {
    const locked = await platformSubscriptionRepository.lockById(
      subscriptionId,
      client,
    );
    if (!locked) throw saasSubscriptionNotFoundError(subscriptionId);

    // Frozen §17.3 guard: the commercial state under the subscription
    // aggregate changes, so the route's expectedVersion applies.
    const bumped = await platformSubscriptionRepository.bumpVersion(
      subscriptionId,
      input.expectedVersion,
      client,
    );
    if (!bumped) {
      const current = await platformSubscriptionRepository.findById(
        subscriptionId,
        client,
      );
      if (!current) throw saasSubscriptionNotFoundError(subscriptionId);
      throw saasSubscriptionVersionConflictError(
        subscriptionId,
        current.version,
        input.expectedVersion,
      );
    }

    const { applied, changed } = await applyEntitlementOverride(
      {
        subscriptionId,
        clientId: locked.clientId,
        actorUserId,
        authority,
        input: {
          capabilityCode: input.capabilityCode,
          enabled: input.enabled,
          ...(input.limitValue !== undefined ? { limitValue: input.limitValue } : {}),
          reason: input.reason,
        },
        now: new Date(),
      },
      client,
    );

    return {
      entitlement: applied ? toPublicEntitlement(applied) : null,
      version: bumped.version,
      changed,
    };
  });
}

export const platformEntitlementService = {
  getSaasEntitlements,
  overrideSaasEntitlement,
};
