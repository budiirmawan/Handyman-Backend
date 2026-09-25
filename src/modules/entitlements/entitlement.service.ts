import { AppError } from '../../shared/errors';
import {
  moduleInactiveError,
  moduleNotFoundError,
  moduleRepository,
} from '../modules';
import {
  isSubscriptionEffective,
  subscriptionNotActiveError,
  subscriptionNotFoundError,
  subscriptionRepository,
  type SubscriptionEffectiveness,
  type SubscriptionRecord,
} from '../subscriptions';
import { isLicenseEffective, licenseRepository } from '../licenses';
import { platformProductRepository } from '../platform-products';
import { recordOperationalEvent } from '../operational-events';
import {
  entitlementAlreadyExistsError,
  entitlementCommercialContextInvalidError,
  entitlementNotFoundError,
  saasEntitlementNotFoundError,
  saasQuotaExceededError,
} from './entitlement.errors';
import { entitlementRepository } from './entitlement.repository';
import type {
  CreateEntitlementInput,
  EffectiveModuleSummary,
  EntitlementRecord,
  EntitlementStatus,
  NewEntitlement,
  OverrideEntitlementInput,
  PublicEntitlement,
  UpdateEntitlementStatusInput,
} from './entitlement.types';

export function toPublicEntitlement(record: EntitlementRecord): PublicEntitlement {
  return {
    id: record.id,
    subscriptionId: record.subscriptionId,
    moduleId: record.moduleId,
    status: record.status,
    startsAt: record.startsAt,
    endsAt: record.endsAt,
    source: record.source,
    limitValue: record.limitValue,
  };
}

export function validateEntitlementPeriod(
  startsAt: Date,
  endsAt: Date | undefined | null,
): void {
  if (endsAt !== undefined && endsAt !== null && endsAt <= startsAt) {
    throw AppError.validation('Request validation failed.', [
      { field: 'endsAt', message: 'endsAt must be after startsAt.' },
    ]);
  }
}

export async function createEntitlement(
  subscriptionId: string,
  input: CreateEntitlementInput,
): Promise<PublicEntitlement> {
  const subscription = await subscriptionRepository.findById(subscriptionId);
  if (!subscription) {
    throw subscriptionNotFoundError();
  }

  const module = await moduleRepository.findById(input.moduleId);
  if (!module) {
    throw moduleNotFoundError();
  }

  validateEntitlementPeriod(input.startsAt, input.endsAt);

  const status = input.status ?? 'ACTIVE';

  if (status === 'ACTIVE') {
    if (subscription.status !== 'ACTIVE') {
      throw subscriptionNotActiveError();
    }
    if (module.status !== 'ACTIVE') {
      throw moduleInactiveError();
    }

    const licenses = await licenseRepository.findBySubscriptionId(subscriptionId);
    if (licenses.some((license) => license.status === 'REVOKED')) {
      throw entitlementCommercialContextInvalidError();
    }

    const existingActive =
      await entitlementRepository.findBySubscriptionAndModule(subscriptionId, module.id);
    if (existingActive) {
      throw entitlementAlreadyExistsError();
    }
  }

  const newEntitlement: NewEntitlement = {
    subscriptionId,
    moduleId: module.id,
    status,
    startsAt: input.startsAt,
    endsAt: input.endsAt ?? null,
  };

  const record = await entitlementRepository.createEntitlement(newEntitlement);
  return toPublicEntitlement(record);
}

export async function getEntitlementById(id: string): Promise<PublicEntitlement> {
  const record = await entitlementRepository.findById(id);
  if (!record) {
    throw entitlementNotFoundError();
  }
  return toPublicEntitlement(record);
}

export async function listEntitlementsBySubscriptionId(
  subscriptionId: string,
): Promise<PublicEntitlement[]> {
  const subscription = await subscriptionRepository.findById(subscriptionId);
  if (!subscription) {
    throw subscriptionNotFoundError();
  }
  const records = await entitlementRepository.findBySubscriptionId(subscriptionId);
  return records.map(toPublicEntitlement);
}

export async function listEntitlements(): Promise<PublicEntitlement[]> {
  const records = await entitlementRepository.listEntitlements();
  return records.map(toPublicEntitlement);
}

export async function updateEntitlementStatus(
  id: string,
  input: UpdateEntitlementStatusInput,
): Promise<PublicEntitlement> {
  const existing = await entitlementRepository.findById(id);
  if (!existing) {
    throw entitlementNotFoundError();
  }

  const status: EntitlementStatus = input.status;
  const record = await entitlementRepository.updateStatus(id, status);
  return toPublicEntitlement(record as EntitlementRecord);
}

// ---------------------------------------------------------------------------
// PART 04 (frozen §12.1) — extended effective-entitlement resolver
// ---------------------------------------------------------------------------

/**
 * Shared runtime-usability gate for a subscription (frozen §12.1 step 1,
 * reusing the EXISTING `isSubscriptionEffective` — never reimplemented):
 * the commercial-validity rule AND a currently valid License.
 */
export async function isSubscriptionEffectivelyLicensed(
  subscription: SubscriptionEffectiveness & { id: string },
  now: Date,
): Promise<boolean> {
  if (!isSubscriptionEffective(subscription, now)) {
    return false;
  }
  const licenses = await licenseRepository.findBySubscriptionId(subscription.id);
  return licenses.some((license) => isLicenseEffective(subscription, license, now));
}

/**
 * Centralized effective-entitlement resolver (frozen §12.1 — the EXISTING
 * BE-02C resolver EXTENDED, never replaced):
 *
 *   if subscription not effectively licensed (existing
 *   isSubscriptionEffective + license validity) → ∅
 *   else for each ACTIVE module_entitlements row within its period whose
 *   Module is ACTIVE:
 *     source  ∈ {PACKAGE, ADD_ON, OVERRIDE, PROMOTION, MANUAL}
 *     limit   = the row's explicit limit_value (NULL = none on the grant;
 *               0 = explicitly unlimited). The add-on quota-delta step of
 *               the frozen chain is a no-op in PART 04 (no add-on
 *               commercial behavior exists yet); the package limit
 *               DEFINITIONS are exposed separately (package_limits of the
 *               bound package) because the frozen schema defines no
 *               capability → limit_key mapping.
 *
 * `now` is injectable for deterministic tests.
 */
export async function resolveEffectiveEntitlements(
  subscriptionId: string,
  now: Date = new Date(),
): Promise<EffectiveModuleSummary[]> {
  const subscription = await subscriptionRepository.findById(subscriptionId);
  if (!subscription) {
    throw subscriptionNotFoundError();
  }

  if (!(await isSubscriptionEffectivelyLicensed(subscription, now))) {
    return [];
  }

  const entitlements = await entitlementRepository.findBySubscriptionId(subscriptionId);
  const results: EffectiveModuleSummary[] = [];

  for (const entitlement of entitlements) {
    if (entitlement.status !== 'ACTIVE') {
      continue;
    }
    if (now < entitlement.startsAt) {
      continue;
    }
    if (entitlement.endsAt !== null && now >= entitlement.endsAt) {
      continue;
    }

    const module = await moduleRepository.findById(entitlement.moduleId);
    if (!module || module.status !== 'ACTIVE') {
      continue;
    }

    results.push({
      moduleId: module.id,
      code: module.code,
      name: module.name,
      source: entitlement.source,
      limit: entitlement.limitValue,
      effectiveFrom: entitlement.startsAt,
      effectiveUntil: entitlement.endsAt,
    });
  }

  results.sort((a, b) => a.code.localeCompare(b.code));
  return results;
}

// ---------------------------------------------------------------------------
// PART 04 (frozen §12.2) — customer-scoped resolution seam
// ---------------------------------------------------------------------------

/**
 * The customer's subscriptions that are currently effective under the
 * frozen §12.1 gate (commercial validity + license). Deterministic and
 * shared by every customer-scoped seam function below.
 */
async function findEffectiveSubscriptions(
  customerId: string,
  now: Date,
): Promise<SubscriptionRecord[]> {
  const subscriptions = await subscriptionRepository.findByClientId(customerId);
  const effective: SubscriptionRecord[] = [];
  for (const subscription of subscriptions) {
    if (await isSubscriptionEffectivelyLicensed(subscription, now)) {
      effective.push(subscription);
    }
  }
  return effective;
}

/**
 * Frozen §12.2 seam (capability half): does the customer's subscription
 * entitle it to the capability? Union across ALL of the customer's
 * effective subscriptions — reuses the per-subscription resolver above
 * (never reimplements it). This answers the ENTITLEMENT question only; the
 * actor's RBAC/permission/data-scope question is answered independently by
 * the business plane, and both must pass.
 */
export async function resolveCapabilityAccess(
  customerId: string,
  capabilityCode: string,
  now: Date = new Date(),
): Promise<boolean> {
  const effective = await findEffectiveSubscriptions(customerId, now);
  for (const subscription of effective) {
    const grants = await resolveEffectiveEntitlements(subscription.id, now);
    if (grants.some((grant) => grant.code === capabilityCode)) {
      return true;
    }
  }
  return false;
}

/**
 * Frozen §12.2 seam (limit half): the customer's EFFECTIVE LIMIT
 * DEFINITION for `limitKey` — the max of `package_limits` over the bound
 * packages of all effective subscriptions (deterministic; the most
 * permissive effective definition wins). Null = no effective definition.
 * PART 04 owns the definition only — current/remaining usage belongs to
 * PART 09 and is never read or fabricated here.
 */
export async function resolveEffectiveLimit(
  customerId: string,
  limitKey: string,
  now: Date = new Date(),
): Promise<number | null> {
  const effective = await findEffectiveSubscriptions(customerId, now);
  let best: number | null = null;
  let sawUnlimited = false;
  for (const subscription of effective) {
    if (!subscription.packageId) continue;
    const limits = await platformProductRepository.findLimitsByPackageId(
      subscription.packageId,
    );
    const packageRow = limits.find((candidate) => candidate.limitKey === limitKey);
    // PART 13C PART 01C quota formula:
    //   effectiveLimit = packageBase + SUM(active add-on delta)
    // Canonical unlimited semantics preserved: a `0` package base
    // means UNLIMITED — the additive step must NOT turn `0` into a
    // finite positive quota (`0 + 10` stays `0`, not `10`).
    if (!packageRow) {
      // Missing package base: §12.1 step 3 ("no row, no package base,
      // no effective limit is published"). A delta alone does NOT mint
      // a finite quota — that would invent policy.
      continue;
    }
    if (packageRow.limitValue === 0) {
      // Unlimited: a `0` package base dominates any positive delta;
      // flag it for the customer-level result. PART 13C PART 01C —
      // multi-subscription rule: if ANY effective subscription
      // publishes `0` (unlimited), the customer-level result is
      // unlimited regardless of other finite subscriptions.
      sawUnlimited = true;
      continue;
    }
    const packageBase = packageRow.limitValue;
    const deltaSum = await entitlementRepository.sumActiveAddOnQuotaDelta(
      subscription.id,
      limitKey,
    );
    const candidate = packageBase + deltaSum;
    if (best === null || candidate > best) {
      best = candidate;
    }
  }
  if (sawUnlimited) return 0;
  return best;
}

/**
 * Frozen §12.2 seam (capability assertion): the reusable business-plane
 * guard. Denial is a COMMERCIAL error, never an RBAC 403 (frozen §17.1):
 *   - capability unknown (not in the `modules` catalogue) → the existing
 *     canonical module 404;
 *   - capability known but not entitled for the customer → 404
 *     SAAS_ENTITLEMENT_NOT_FOUND.
 */
export async function assertCapabilityAccess(
  customerId: string,
  capabilityCode: string,
  now: Date = new Date(),
): Promise<void> {
  const module = await moduleRepository.findByCode(capabilityCode);
  if (!module) {
    throw moduleNotFoundError();
  }
  const granted = await resolveCapabilityAccess(customerId, capabilityCode, now);
  if (!granted) {
    throw saasEntitlementNotFoundError(capabilityCode);
  }
}

/**
 * Frozen §12.2 seam (quota half) — PART 04 scope: the frozen
 * `assertQuotaAvailable(customerId, limitKey)` comparison shape.
 *
 *   limit = effective limit definition (PART 04, above);
 *   used  = saas_usage_aggregations (BILLING_PERIOD) + in-flight count —
 *           supplied by PART 09 (Usage Metering). Until the meter lands,
 *           the used component is 0 BY DEFINITION: no usage is fabricated,
 *           no meter row is read or written, and no limit is enforced
 *           early. PART 09 replaces the used source; the frozen 409
 *           `SAAS_QUOTA_EXCEEDED {limitKey, limit, used}` semantics are
 *           already wired below.
 */
/**
 * Frozen §12.2 quota-preflight seam (customer-scoped, single-shot).
 *
 * Backward-compatible signature with PART 04 — a brand-new
 * `requestedQuantity` parameter is OPTIONAL (default 1). The
 * frozen PART 04 call shape `assertQuotaAvailable(customerId,
 * limitKey)` keeps working unchanged; callers that opt-in to true
 * preflight enforcement pass the quantity they intend to consume
 * (e.g. the building count delta before INSERT).
 *
 * Frozen semantics:
 *   - limit === 0     → unlimited (no check, never throws).
 *   - limit === null  → no applicable definition → no quota-bound
 *     (preserves PART 04 not-bounded semantics, never throws).
 *   - limit > 0 and requestedQuantity > 0 →
 *     preflight check: throws SAAS_QUOTA_EXCEEDED iff the projected
 *     total (used + requestedQuantity) exceeds limit. This is the
 *     CORRECT boundary behavior for preflight — without it, a caller
 *     doing resource creation at used=limit would not be denied
 *     until the usage feed catches up.
 *
 * `requestedQuantity` MUST be strictly greater than 0; 0 and
 * negative / non-finite values are validation errors. There is no
 * legacy post-state-only mode — every call enforces preflight.
 *
 * The function is READ-ONLY with respect to usage — preflight
 * never mutates usage (failed preflight must not change anything).
 */
export async function assertQuotaAvailable(
  customerId: string,
  limitKey: string,
  now: Date = new Date(),
  requestedQuantity: number = 1,
): Promise<void> {
  const limit = await resolveEffectiveLimit(customerId, limitKey, now);
  // null = no effective definition (not quota-bounded); 0 = unlimited.
  if (limit === null || limit === 0) {
    return;
  }
  if (
    !Number.isFinite(requestedQuantity) ||
    requestedQuantity <= 0
  ) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'requestedQuantity',
        message:
          'requestedQuantity must be a finite number strictly greater than 0.',
      },
    ]);
  }
  // PART 09 — authoritative `used` from saas_usage_aggregations.
  // PART 04 must never fabricate usage; it consumes PART 09 only.
  const { getUsedForCustomerLimit } = await import(
    '../platform-usage/saas-usage.service'
  );
  const used = await getUsedForCustomerLimit(customerId, limitKey, now);
  // Pre-flight formula (frozen): projected = used + requestedQuantity.
  const projected = used + requestedQuantity;
  if (projected > limit) {
    throw saasQuotaExceededError(limitKey, limit, projected);
  }
}

// ---------------------------------------------------------------------------
// PART 04 (frozen §9.3/§12.1) — deterministic package materialization
// ---------------------------------------------------------------------------

/**
 * Materializes (and deterministically reconciles) PACKAGE-source grants for
 * a subscription's bound package. Runs INSIDE the caller's transaction,
 * under the caller's subscription row lock (frozen §9.3: "the declarative
 * grant list resolved at subscription activation"):
 *
 *   - every ENABLED package feature with an ACTIVE module that has no
 *     ACTIVE grant yet gains ONE ACTIVE PACKAGE row (starts now, open
 *     period, no explicit limit);
 *   - stale PACKAGE rows whose capability the package no longer enables
 *     become EXPIRED with their period closed (history preserved);
 *   - existing ACTIVE grants of ANY other source (MANUAL/OVERRIDE/…) are
 *     never created, altered or suspended by package sync;
 *   - re-running is a no-op (retry-safe, no duplicates — the 0016
 *     one-active-per-(subscription, module) index is the backstop).
 *
 * No audit event is emitted here (the owning transition's frozen
 * SAAS_SUBSCRIPTION_* event covers it; no entitlement event is frozen for
 * package materialization). No idempotency key (internal deterministic
 * synchronization inside the subscription transaction — frozen §17.2
 * defines no entitlement operation key).
 */
export async function syncPackageEntitlements(
  subscriptionId: string,
  packageId: string,
  now: Date = new Date(),
  q?: Parameters<typeof entitlementRepository.createEntitlement>[1],
): Promise<{ created: number; expired: number }> {
  const features = await platformProductRepository.findFeaturesByPackageId(
    packageId,
    q,
  );
  const enabledFeatures = features.filter((feature) => feature.enabled);

  // Resolve capability codes to the canonical modules catalogue (the
  // package_features FK on modules(code) makes missing codes impossible;
  // the defensive skip keeps sync deterministic regardless).
  const enabledModules = new Map<string, { id: string; code: string }>();
  for (const feature of enabledFeatures) {
    if (enabledModules.has(feature.capabilityCode)) continue;
    const module = await moduleRepository.findByCode(feature.capabilityCode, q);
    if (module) {
      enabledModules.set(feature.capabilityCode, { id: module.id, code: module.code });
    }
  }
  const enabledModuleIds = new Set(
    [...enabledModules.values()].map((module) => module.id),
  );

  const activeRows = (
    await entitlementRepository.findBySubscriptionId(subscriptionId, q)
  ).filter((row) => row.status === 'ACTIVE');
  const activeModuleIds = new Set(activeRows.map((row) => row.moduleId));
  const activePackageRows = activeRows.filter((row) => row.source === 'PACKAGE');

  let created = 0;
  for (const feature of enabledFeatures) {
    const module = enabledModules.get(feature.capabilityCode);
    if (!module) continue;
    if (activeModuleIds.has(module.id)) continue; // an ACTIVE grant already wins
    await entitlementRepository.createEntitlement(
      {
        subscriptionId,
        moduleId: module.id,
        status: 'ACTIVE',
        startsAt: now,
        endsAt: null,
        source: 'PACKAGE',
        limitValue: null,
      },
      q,
    );
    created += 1;
  }

  // Stale reconciliation: PACKAGE rows whose capability the enabled package
  // feature set no longer contains become EXPIRED (period closed).
  let expired = 0;
  for (const row of activePackageRows) {
    if (!enabledModuleIds.has(row.moduleId)) {
      await entitlementRepository.expirePackageRow(row.id, now, q);
      expired += 1;
    }
  }

  return { created, expired };
}

// ---------------------------------------------------------------------------
// PART 04 (frozen §22/§18.2) — console OVERRIDE command (row-level core)
// ---------------------------------------------------------------------------

/**
 * Row-level core of the frozen console override. The CALLER owns the
 * transaction and the subscription row lock, and has already applied the
 * `expectedVersion` guard (frozen §17.3 — the route is "ver"); this core
 * performs the deterministic grant mutation and emits exactly one
 * `SAAS_ENTITLEMENT_OVERRIDDEN` canonical event (frozen §18.2; reason
 * mandatory per §18.3).
 */
export async function applyEntitlementOverride(
  params: {
    subscriptionId: string;
    clientId: string;
    actorUserId: string;
    authority: string;
    input: OverrideEntitlementInput;
    now?: Date;
  },
  q: Parameters<typeof recordOperationalEvent>[1],
): Promise<{ applied: EntitlementRecord | null; changed: boolean }> {
  const { subscriptionId, clientId, actorUserId, authority, input } = params;
  const now = params.now ?? new Date();

  const module = await moduleRepository.findByCode(input.capabilityCode, q);
  if (!module) {
    throw moduleNotFoundError();
  }

  const existing = await entitlementRepository.findBySubscriptionAndModule(
    subscriptionId,
    module.id,
    q,
  );

  const before = existing
    ? {
        enabled: true,
        source: existing.source,
        limitValue: existing.limitValue,
      }
    : { enabled: false, source: null, limitValue: null };

  let applied: EntitlementRecord | null = null;
  let changed = false;

  if (input.enabled) {
    if (existing) {
      if (existing.source === 'OVERRIDE') {
        applied =
          (await entitlementRepository.updateRowLimit(
            existing.id,
            input.limitValue ?? null,
            q,
          )) ?? existing;
        changed = applied.limitValue !== before.limitValue;
      } else {
        // The one-active slot passes to the OVERRIDE grant; the previous
        // grant is suspended (its history is preserved).
        await entitlementRepository.suspendRow(existing.id, q);
        applied = await entitlementRepository.createEntitlement(
          {
            subscriptionId,
            moduleId: module.id,
            status: 'ACTIVE',
            startsAt: now,
            endsAt: null,
            source: 'OVERRIDE',
            limitValue: input.limitValue ?? null,
          },
          q,
        );
        changed = true;
      }
    } else {
      applied = await entitlementRepository.createEntitlement(
        {
          subscriptionId,
          moduleId: module.id,
          status: 'ACTIVE',
          startsAt: now,
          endsAt: null,
          source: 'OVERRIDE',
          limitValue: input.limitValue ?? null,
        },
        q,
      );
      changed = true;
    }
  } else {
    if (existing) {
      applied = await entitlementRepository.suspendRow(existing.id, q);
      changed = true;
    }
  }

  await recordOperationalEvent(
    {
      clientId,
      eventType: 'SAAS_ENTITLEMENT_OVERRIDDEN',
      entityType: 'SAAS_ENTITLEMENT',
      entityId: applied?.id ?? subscriptionId,
      actorUserId,
      summary: `SaaS entitlement ${input.enabled ? 'granted' : 'withheld'}: ${input.capabilityCode} (override)`,
      metadata: {
        authority,
        reason: input.reason,
        capabilityCode: input.capabilityCode,
        before,
        after: applied
          ? {
              enabled: true,
              source: applied.source,
              limitValue: applied.limitValue,
            }
          : { enabled: false, source: null, limitValue: null },
      },
    },
    q,
  );

  return { applied, changed };
}

export const entitlementService = {
  applyEntitlementOverride,
  assertCapabilityAccess,
  assertQuotaAvailable,
  createEntitlement,
  getEntitlementById,
  isSubscriptionEffectivelyLicensed,
  listEntitlements,
  listEntitlementsBySubscriptionId,
  resolveCapabilityAccess,
  resolveEffectiveEntitlements,
  resolveEffectiveLimit,
  syncPackageEntitlements,
  updateEntitlementStatus,
  validateEntitlementPeriod,
};
