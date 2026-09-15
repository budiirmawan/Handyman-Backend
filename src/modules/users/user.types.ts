/**
 * BE-01A — User identity domain types.
 *
 * The User record is intentionally limited to platform identity. Credentials
 * (BE-01B), roles/permissions (BE-01D/E), and other concerns live in their
 * own modules and are never attached to this type.
 */
export const USER_STATUSES = ['INVITED', 'ACTIVE', 'INACTIVE', 'SUSPENDED'] as const;

export type UserStatus = (typeof USER_STATUSES)[number];

export function isUserStatus(value: unknown): value is UserStatus {
  return (
    typeof value === 'string' &&
    (USER_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Account state gate used by login/session. Only ACTIVE users may
 * authenticate; INVITED (onboarding incomplete), INACTIVE, and SUSPENDED
 * accounts are denied.
 */
export function userStatusCanLogin(status: UserStatus): boolean {
  return status === 'ACTIVE';
}

/** Database-shaped user record (camelCase after repository mapping). */
export type UserRecord = {
  id: string;
  email: string;
  displayName: string;
  status: UserStatus;
  /**
   * CR-BE-NOTIFY-PROV-01 PART 06 — authoritative WhatsApp contact + consent.
   * E.164 phone (null = no WhatsApp contact) and the last explicit opt-in /
   * opt-out instants. Consent is ACTIVE only when the user is ACTIVE, a
   * phone exists, and the last opt-in is newer than any opt-out.
   */
  whatsappPhone: string | null;
  whatsappOptedInAt: Date | null;
  whatsappOptedOutAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicUser = {
  id: string;
  email: string;
  displayName: string;
  status: UserStatus;
  /** CR-BE-NOTIFY-PROV-01 PART 06 — WhatsApp contact + consent (nullable). */
  whatsappPhone: string | null;
  whatsappOptedInAt: string | null;
  whatsappOptedOutAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * CR-BE-NOTIFY-PROV-01 PART 06 — explicit consent actions for the WhatsApp
 * channel. Consent is always explicit and timestamped; there is no implicit
 * opt-in.
 */
export const USER_WHATSAPP_CONSENT_ACTIONS = ['OPT_IN', 'OPT_OUT'] as const;
export type UserWhatsAppConsentAction =
  (typeof USER_WHATSAPP_CONSENT_ACTIONS)[number];

export function isUserWhatsAppConsentAction(
  value: unknown,
): value is UserWhatsAppConsentAction {
  return (
    typeof value === 'string' &&
    (USER_WHATSAPP_CONSENT_ACTIONS as readonly string[]).includes(value)
  );
}

/** Guarded update input for the User WhatsApp contact + consent seam. */
export type UpdateUserWhatsAppContactInput = {
  /** Omit to keep the current number; `null` clears number AND consent. */
  whatsappPhone?: string | null;
  /** Omit to keep consent unchanged; otherwise stamp the action instant. */
  consent?: UserWhatsAppConsentAction;
};

/**
 * Consent-active rule (governance gate decision): outbound WhatsApp delivery
 * may resolve an address ONLY when the user is ACTIVE, has a phone, opted in,
 * and the last opt-in is newer than any opt-out.
 */
export function isUserWhatsAppConsentActive(
  record: Pick<
    UserRecord,
    'status' | 'whatsappPhone' | 'whatsappOptedInAt' | 'whatsappOptedOutAt'
  >,
): boolean {
  return (
    record.status === 'ACTIVE' &&
    record.whatsappPhone !== null &&
    record.whatsappOptedInAt !== null &&
    (record.whatsappOptedOutAt === null ||
      record.whatsappOptedInAt.getTime() > record.whatsappOptedOutAt.getTime())
  );
}

/** Validated request input for creating a user (status defaults to ACTIVE). */
export type CreateUserInput = {
  email: string;
  displayName: string;
  status?: UserStatus;
};

/** Fully-resolved user data ready for persistence. */
export type NewUser = {
  email: string;
  displayName: string;
  status: UserStatus;
};
