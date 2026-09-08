import type { PublicUser, UserRecord } from './user.types';

/**
 * Safe public representation of a user. Never includes credential, session,
 * or other security-related fields. This shape is reused by authentication
 * (BE-01C) and Effective User Context (BE-01I).
 */
export function toPublicUser(record: UserRecord): PublicUser {
  return {
    id: record.id,
    email: record.email,
    displayName: record.displayName,
    status: record.status,
    whatsappPhone: record.whatsappPhone,
    whatsappOptedInAt: record.whatsappOptedInAt
      ? record.whatsappOptedInAt.toISOString()
      : null,
    whatsappOptedOutAt: record.whatsappOptedOutAt
      ? record.whatsappOptedOutAt.toISOString()
      : null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
