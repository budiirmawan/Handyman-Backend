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
} from '../subscriptions';
import { isLicenseEffective, licenseRepository } from '../licenses';
import {
  entitlementAlreadyExistsError,
  entitlementCommercialContextInvalidError,
  entitlementNotFoundError,
} from './entitlement.errors';
import { entitlementRepository } from './entitlement.repository';
import type {
  CreateEntitlementInput,
  EffectiveModuleSummary,
  EntitlementRecord,
  EntitlementStatus,
  NewEntitlement,
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

/**
 * Centralized effective-entitlement resolver.
 *
 * A Module is effectively entitled when ALL hold:
 *   Module = ACTIVE
 *   AND Entitlement = ACTIVE
 *   AND now inside entitlement period
 *   AND Subscription is effective (BE-02B resolver)
 *   AND a License is valid (BE-02B resolver)
 *
 * Reuses the BE-02B validity algorithms rather than reimplementing them.
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

  if (!isSubscriptionEffective(subscription, now)) {
    return [];
  }

  const licenses = await licenseRepository.findBySubscriptionId(subscriptionId);
  const effectiveLicense = licenses.find((license) =>
    isLicenseEffective(subscription, license, now),
  );
  if (!effectiveLicense) {
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
    });
  }

  results.sort((a, b) => a.code.localeCompare(b.code));
  return results;
}

export const entitlementService = {
  createEntitlement,
  getEntitlementById,
  listEntitlements,
  listEntitlementsBySubscriptionId,
  resolveEffectiveEntitlements,
  updateEntitlementStatus,
  validateEntitlementPeriod,
};
