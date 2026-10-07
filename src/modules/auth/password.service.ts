import bcrypt from 'bcryptjs';
import { passwordPolicyViolationError } from './credential.errors';

/**
 * Centralized password policy. Kept deliberately small: required value plus
 * reasonable minimum and maximum length. The maximum mirrors bcrypt's 72-byte
 * input limit so no password is silently truncated.
 */
export const PASSWORD_POLICY = {
  minLength: 8,
  maxLength: 72,
} as const;

export const PASSWORD_BCRYPT_ROUNDS = 12;

export type PasswordPolicyDetail = {
  field: string;
  message: string;
};

/**
 * Validates a password against the policy. Throws
 * PASSWORD_POLICY_VIOLATION with human-readable details on failure.
 */
export function validatePassword(password: unknown): string {
  if (typeof password !== 'string' || password.length === 0) {
    throw passwordPolicyViolationError([
      { field: 'password', message: 'Password is required.' },
    ]);
  }

  const details: PasswordPolicyDetail[] = [];

  if (password.length < PASSWORD_POLICY.minLength) {
    details.push({
      field: 'password',
      message: `Password must be at least ${PASSWORD_POLICY.minLength} characters.`,
    });
  }

  if (password.length > PASSWORD_POLICY.maxLength) {
    details.push({
      field: 'password',
      message: `Password must be at most ${PASSWORD_POLICY.maxLength} characters.`,
    });
  }

  if (details.length > 0) {
    throw passwordPolicyViolationError(details);
  }

  return password;
}

/**
 * Produces a salted bcrypt hash for a plaintext password. The plaintext is
 * never persisted or returned; only the hash is stored.
 */
export async function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  return bcrypt.hash(password, PASSWORD_BCRYPT_ROUNDS);
}

/**
 * Compares a candidate password against a stored hash using a constant-time
 * bcrypt comparison. Returns true/false; never throws on mismatch.
 */
export async function verifyPassword(
  candidate: string,
  passwordHash: string,
): Promise<boolean> {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    return false;
  }

  return bcrypt.compare(candidate, passwordHash);
}

export const passwordService = {
  hashPassword,
  validatePassword,
  verifyPassword,
};
