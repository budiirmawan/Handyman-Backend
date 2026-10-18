import { logger } from '../../shared/logger';
import { userNotFoundError, userRepository } from '../users';
import {
  credentialAlreadyExistsError,
  credentialNotFoundError,
  invalidPasswordError,
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

/**
 * CR-HM-IAM-BOOTSTRAP-01 — administrative password reset.
 *
 * Reuses the central bcrypt policy/hasher, stores only the hash, marks
 * `must_change_password` so the temporary secret is explicitly one-time, and
 * never returns or logs the plaintext. The caller (user lifecycle service)
 * revokes every active session; this function intentionally has no HTTP
 * knowledge.
 */
export async function resetPassword(
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
    mustChangePassword: true,
  });

  if (!updated) {
    throw credentialNotFoundError();
  }

  logger.info('User password reset', {
    userId,
    operation: 'credential.reset_password',
  });

  return updated;
}

/**
 * CR-HM-IAM-BOOTSTRAP-01 — authenticated self-service password change.
 *
 * Requires the CURRENT password (constant-time bcrypt comparison), applies the
 * same policy, clears `must_change_password`, and stores only the new hash.
 * The caller revokes the user's OTHER sessions and keeps the current one.
 */
export async function changeOwnPassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<CredentialRecord> {
  const existing = await credentialRepository.findByUserId(userId);
  if (!existing) {
    throw credentialNotFoundError();
  }

  const matches = await passwordService.verifyPassword(
    currentPassword,
    existing.passwordHash,
  );
  if (!matches) {
    throw invalidPasswordError();
  }

  const passwordHash = await passwordService.hashPassword(newPassword);
  const updated = await credentialRepository.updatePassword(userId, {
    passwordHash,
    passwordChangedAt: new Date(),
    mustChangePassword: false,
  });

  if (!updated) {
    throw credentialNotFoundError();
  }

  logger.info('User password changed', {
    userId,
    operation: 'credential.change_password',
  });

  return updated;
}

export const credentialService = {
  changeOwnPassword,
  createInitialCredential,
  getCredentialByUserId,
  resetPassword,
  updatePassword,
  verifyPasswordForUser,
};
