import { AppError } from '../../shared/errors';
import {
  isSubscriptionEffective,
  subscriptionNotActiveError,
  subscriptionNotFoundError,
  subscriptionRepository,
} from '../subscriptions';
import {
  licenseAlreadyActiveError,
  licenseNotFoundError,
} from './license.errors';
import { licenseRepository } from './license.repository';
import type {
  CreateLicenseInput,
  LicenseEffectiveState,
  LicenseRecord,
  LicenseStatus,
  NewLicense,
  PublicLicense,
  UpdateLicenseStatusInput,
} from './license.types';

export function toPublicLicense(record: LicenseRecord): PublicLicense {
  return {
    id: record.id,
    subscriptionId: record.subscriptionId,
    status: record.status,
    validFrom: record.validFrom,
    validUntil: record.validUntil,
  };
}

export function validateLicensePeriod(
  validFrom: Date,
  validUntil: Date | undefined | null,
): void {
  if (validUntil !== undefined && validUntil !== null && validUntil <= validFrom) {
    throw AppError.validation('Request validation failed.', [
      { field: 'validUntil', message: 'validUntil must be after validFrom.' },
    ]);
  }
}

/**
 * Centralized License validity rule. A License is effective only when:
 *   the owning Subscription is commercially effective (BE-02B resolver)
 *   AND license.status = ACTIVE
 *   AND now >= validFrom
 *   AND (validUntil IS NULL OR now < validUntil)
 *
 * `now` is injectable for deterministic tests.
 */
export function isLicenseEffective(
  subscription: Parameters<typeof isSubscriptionEffective>[0],
  license: LicenseRecord,
  now: Date,
): boolean {
  if (!isSubscriptionEffective(subscription, now)) {
    return false;
  }
  if (license.status !== 'ACTIVE') {
    return false;
  }
  if (now < license.validFrom) {
    return false;
  }
  if (license.validUntil !== null && now >= license.validUntil) {
    return false;
  }
  return true;
}

export async function createLicense(
  subscriptionId: string,
  input: CreateLicenseInput,
): Promise<PublicLicense> {
  const subscription = await subscriptionRepository.findById(subscriptionId);
  if (!subscription) {
    throw subscriptionNotFoundError();
  }
  if (subscription.status !== 'ACTIVE') {
    throw subscriptionNotActiveError();
  }

  validateLicensePeriod(input.validFrom, input.validUntil);

  const status = input.status ?? 'ACTIVE';

  if (status === 'ACTIVE') {
    const existingActive =
      await licenseRepository.findActiveBySubscriptionId(subscriptionId);
    if (existingActive) {
      throw licenseAlreadyActiveError();
    }
  }

  const newLicense: NewLicense = {
    subscriptionId,
    status,
    validFrom: input.validFrom,
    validUntil: input.validUntil ?? null,
  };

  const record = await licenseRepository.createLicense(newLicense);
  return toPublicLicense(record);
}

export async function getLicenseById(id: string): Promise<PublicLicense> {
  const record = await licenseRepository.findById(id);
  if (!record) {
    throw licenseNotFoundError();
  }
  return toPublicLicense(record);
}

export async function listLicensesBySubscriptionId(
  subscriptionId: string,
): Promise<PublicLicense[]> {
  const subscription = await subscriptionRepository.findById(subscriptionId);
  if (!subscription) {
    throw subscriptionNotFoundError();
  }
  const records = await licenseRepository.findBySubscriptionId(subscriptionId);
  return records.map(toPublicLicense);
}

export async function updateLicenseStatus(
  id: string,
  input: UpdateLicenseStatusInput,
): Promise<PublicLicense> {
  const existing = await licenseRepository.findById(id);
  if (!existing) {
    throw licenseNotFoundError();
  }

  const status: LicenseStatus = input.status;
  const record = await licenseRepository.updateStatus(id, status);
  return toPublicLicense(record as LicenseRecord);
}

export async function getLicenseEffectiveState(
  id: string,
  now: Date = new Date(),
): Promise<LicenseEffectiveState> {
  const license = await licenseRepository.findById(id);
  if (!license) {
    throw licenseNotFoundError();
  }

  const subscription = await subscriptionRepository.findById(license.subscriptionId);
  if (!subscription) {
    throw subscriptionNotFoundError();
  }

  return {
    license: toPublicLicense(license),
    effective: isLicenseEffective(subscription, license, now),
  };
}

export const licenseService = {
  createLicense,
  getLicenseById,
  getLicenseEffectiveState,
  isLicenseEffective,
  listLicensesBySubscriptionId,
  updateLicenseStatus,
  validateLicensePeriod,
};
