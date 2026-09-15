import { AppError } from '../../shared/errors';
import {
  clientInactiveError,
  clientNotFoundError,
  clientRepository,
} from '../clients';
import {
  subscriptionCodeAlreadyExistsError,
  subscriptionNotFoundError,
} from './subscription.errors';
import { subscriptionRepository } from './subscription.repository';
import { normalizePlanCode, normalizeSubscriptionCode } from './subscription.validation';
import type {
  CreateSubscriptionInput,
  NewSubscription,
  PublicSubscription,
  SubscriptionEffectiveState,
  SubscriptionRecord,
  SubscriptionStatus,
  UpdateSubscriptionStatusInput,
} from './subscription.types';

export function toPublicSubscription(record: SubscriptionRecord): PublicSubscription {
  return {
    id: record.id,
    clientId: record.clientId,
    code: record.code,
    planCode: record.planCode,
    status: record.status,
    startsAt: record.startsAt,
    endsAt: record.endsAt,
  };
}

/**
 * Centralized commercial-validity rule for a Subscription:
 *   status = ACTIVE
 *   AND now >= startsAt
 *   AND (endsAt IS NULL OR now < endsAt)
 *
 * `now` is injectable for deterministic tests.
 */
export function isSubscriptionEffective(
  record: SubscriptionRecord,
  now: Date,
): boolean {
  if (record.status !== 'ACTIVE') {
    return false;
  }
  if (now < record.startsAt) {
    return false;
  }
  if (record.endsAt !== null && now >= record.endsAt) {
    return false;
  }
  return true;
}

export function validateSubscriptionPeriod(
  startsAt: Date,
  endsAt: Date | undefined | null,
): void {
  if (endsAt !== undefined && endsAt !== null && endsAt <= startsAt) {
    throw AppError.validation('Request validation failed.', [
      { field: 'endsAt', message: 'endsAt must be after startsAt.' },
    ]);
  }
}

export async function createSubscription(
  input: CreateSubscriptionInput,
): Promise<PublicSubscription> {
  const client = await clientRepository.findById(input.clientId);
  if (!client) {
    throw clientNotFoundError();
  }
  if (client.status !== 'ACTIVE') {
    throw clientInactiveError();
  }

  validateSubscriptionPeriod(input.startsAt, input.endsAt);

  const newSubscription: NewSubscription = {
    clientId: input.clientId,
    code: normalizeSubscriptionCode(input.code),
    planCode: normalizePlanCode(input.planCode),
    status: input.status ?? 'ACTIVE',
    startsAt: input.startsAt,
    endsAt: input.endsAt ?? null,
  };

  const existing = await subscriptionRepository.findByCode(newSubscription.code);
  if (existing) {
    throw subscriptionCodeAlreadyExistsError();
  }

  const record = await subscriptionRepository.createSubscription(newSubscription);
  return toPublicSubscription(record);
}

export async function getSubscriptionById(id: string): Promise<PublicSubscription> {
  const record = await subscriptionRepository.findById(id);
  if (!record) {
    throw subscriptionNotFoundError();
  }
  return toPublicSubscription(record);
}

export async function listSubscriptions(
  clientId?: string,
): Promise<PublicSubscription[]> {
  const records = clientId
    ? await subscriptionRepository.findByClientId(clientId)
    : await subscriptionRepository.listSubscriptions();
  return records.map(toPublicSubscription);
}

export async function listSubscriptionsByClientId(
  clientId: string,
): Promise<PublicSubscription[]> {
  const client = await clientRepository.findById(clientId);
  if (!client) {
    throw clientNotFoundError();
  }
  const records = await subscriptionRepository.findByClientId(clientId);
  return records.map(toPublicSubscription);
}

export async function updateSubscriptionStatus(
  id: string,
  input: UpdateSubscriptionStatusInput,
): Promise<PublicSubscription> {
  const existing = await subscriptionRepository.findById(id);
  if (!existing) {
    throw subscriptionNotFoundError();
  }

  const record = await subscriptionRepository.updateStatus(id, input.status);
  return toPublicSubscription(record as SubscriptionRecord);
}

export async function getSubscriptionEffectiveState(
  id: string,
  now: Date = new Date(),
): Promise<SubscriptionEffectiveState> {
  const record = await subscriptionRepository.findById(id);
  if (!record) {
    throw subscriptionNotFoundError();
  }

  return {
    subscription: toPublicSubscription(record),
    effective: isSubscriptionEffective(record, now),
  };
}

export const subscriptionService = {
  createSubscription,
  getSubscriptionById,
  getSubscriptionEffectiveState,
  isSubscriptionEffective,
  listSubscriptions,
  listSubscriptionsByClientId,
  updateSubscriptionStatus,
  validateSubscriptionPeriod,
};
