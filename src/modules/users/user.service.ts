import { AppError } from '../../shared/errors';
import { isWhatsAppE164Phone } from '../whatsapp-delivery';
import {
  userEmailAlreadyExistsError,
  userNotFoundError,
  userWhatsAppPhoneAlreadyExistsError,
} from './user.errors';
import { toPublicUser } from './user.mapper';
import { userRepository } from './user.repository';
import type {
  CreateUserInput,
  NewUser,
  PublicUser,
  UpdateUserWhatsAppContactInput,
} from './user.types';

/**
 * Email normalization is the single source of truth for identity lookup.
 * Emails are trimmed and lowercased so uniqueness is enforced consistently.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function normalizeDisplayName(displayName: string): string {
  return displayName.trim();
}

export async function createUser(input: CreateUserInput): Promise<PublicUser> {
  const newUser: NewUser = {
    email: normalizeEmail(input.email),
    displayName: normalizeDisplayName(input.displayName),
    status: input.status ?? 'ACTIVE',
  };

  const existing = await userRepository.findByEmail(newUser.email);
  if (existing) {
    throw userEmailAlreadyExistsError();
  }

  const record = await userRepository.createUser(newUser);
  return toPublicUser(record);
}

export async function getUserById(id: string): Promise<PublicUser> {
  const record = await userRepository.findById(id);
  if (!record) {
    throw userNotFoundError();
  }

  return toPublicUser(record);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

/**
 * CR-BE-NOTIFY-PROV-01 PART 06 — guarded User WhatsApp contact + consent
 * seam (the existing User authority/RBAC surface; `user.manage` at the
 * route layer).
 *
 * Rules (consent is ALWAYS explicit — never implied by setting a number):
 *   - the user must exist,
 *   - a non-null phone must be strict E.164,
 *   - OPT_IN requires an effective phone (supplied now or already stored),
 *   - clearing the phone (`whatsappPhone: null`) clears BOTH consent
 *     timestamps — consent cannot exist without a contact,
 *   - clearing the phone and requesting OPT_IN in one call is rejected,
 *   - consent actions stamp their instant (last-write-wins); the
 *     consent-active rule compares the two instants,
 *   - one account per WhatsApp number (409 on conflict).
 *
 * Numbers are never inferred from any other field or table.
 */
export async function updateUserWhatsAppContact(
  id: string,
  input: UpdateUserWhatsAppContactInput,
): Promise<PublicUser> {
  const existing = await userRepository.findById(id);
  if (!existing) {
    throw userNotFoundError();
  }

  const details: { field: string; message: string }[] = [];

  let phone: string | null = existing.whatsappPhone;
  if (input.whatsappPhone !== undefined) {
    if (input.whatsappPhone === null) {
      phone = null;
    } else {
      const trimmed = input.whatsappPhone.trim();
      if (!isWhatsAppE164Phone(trimmed)) {
        details.push({
          field: 'whatsappPhone',
          message: 'whatsappPhone must be a valid E.164 number (e.g. +628123456789).',
        });
      } else {
        phone = trimmed;
      }
    }
  }

  const consent = input.consent;
  if (consent === 'OPT_IN' && phone === null) {
    details.push({
      field: 'consent',
      message: 'OPT_IN requires a WhatsApp number (set whatsappPhone first or in the same request).',
    });
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  let optedInAt = existing.whatsappOptedInAt;
  let optedOutAt = existing.whatsappOptedOutAt;

  if (input.whatsappPhone === null) {
    // Clearing the contact clears consent with it.
    optedInAt = null;
    optedOutAt = null;
  }
  if (consent === 'OPT_IN') {
    optedInAt = new Date();
  } else if (consent === 'OPT_OUT') {
    optedOutAt = new Date();
  }

  try {
    const updated = await userRepository.updateWhatsAppContact(id, {
      whatsappPhone: phone,
      whatsappOptedInAt: optedInAt,
      whatsappOptedOutAt: optedOutAt,
    });
    if (!updated) {
      throw userNotFoundError();
    }
    return toPublicUser(updated);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw userWhatsAppPhoneAlreadyExistsError();
    }
    throw error;
  }
}

export const userService = {
  createUser,
  getUserById,
  updateUserWhatsAppContact,
};
