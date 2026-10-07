import { logger } from '../../shared/logger';
import { userNotFoundError, userRepository } from '../users';
import {
  credentialAlreadyExistsError,
  credentialNotFoundError,
} from './credential.errors';
import { credentialRepository } from './credential.repository';
import { passwordService } from './password.service';
import type { CredentialRecord, CreateCredentialInput } from './credential.types';

/**
 * Creates the first credential for an existing user.
 *
 * Existing User → validate policy → hash → persist. Rejects duplicates so a
 * user can never end up with two active credential records.
 */
export async function createInitialCredential(
  input: CreateCredentialInput,
): Promise<CredentialRecord> {
  const user = await userRepository.findById(input.userId);
  if (!user) {
    throw userNotFoundError();
  }

  const existing = await credentialRepository.findByUserId(input.userId);
  if (existing) {
    throw credentialAlreadyExistsError();
  }

  const passwordHash = await passwordService.hashPassword(input.password);
  const record = await credentialRepository.createForUser({
    userId: input.userId,
    passwordHash,
    mustChangePassword: input.mustChangePassword ?? false,
  });

  logger.info('User credential created', {
    userId: input.userId,
    operation: 'credential.create',
  });

  return record;
}

/**
 * Internal lookup. Returns the credential record (including the hash) for
 * backend verification flows only; never exposed through the API.
 */
export async function getCredentialByUserId(
  userId: string,
): Promise<CredentialRecord | null> {
  return credentialRepository.findByUserId(userId);
}

/**
 * Reusable verification used later by login/session (BE-01C).
 */
export async function verifyPasswordForUser(
  userId: string,
  candidate: string,
): Promise<boolean> {
  const record = await credentialRepository.findByUserId(userId);
  if (!record) {
    return false;
  }

  return passwordService.verifyPassword(candidate, record.passwordHash);
}

/**
 * Password update foundation: validate → hash → update hash and
 * password_changed_at. No authenticated endpoint yet (BE-01C).
 */
export async function updatePassword(
  userId: string,
  newPassword: string,
): Promise<CredentialRecord> {
  const existing = await credentialRepository.findByUserId(userId);
  if (!existing) {
    throw credentialNotFoundError();
  }

  const passwordHash = await passwordService.hashPassword(newPassword);
  const updated = await credentialRepository.updatePassword(userId, {
    passwordHash,
    passwordChangedAt: new Date(),
  });

  if (!updated) {
    throw credentialNotFoundError();
  }

  logger.info('User password updated', {
    userId,
    operation: 'credential.update_password',
  });

  return updated;
}

export const credentialService = {
  createInitialCredential,
  getCredentialByUserId,
  updatePassword,
  verifyPasswordForUser,
};
