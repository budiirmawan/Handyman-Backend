/**
 * BE-13A — Visitor Identity / Registration domain types.
 *
 * The Visitor is the SINGLE shared identity master for the whole BE-13
 * Front Desk domain. Invitation (BE-13B), Expected Visitor (BE-13C),
 * Walk-In (BE-13D), Contractor (BE-13J) and Delivery / Courier (BE-13K)
 * flows all reference the same visitor identity row — none of them
 * creates a second visitor master.
 *
 * Scoping: the identity is Client-scoped (a person-level master reusable
 * across every Building of the same Client). Operational Visit records
 * (later BE-13 PARTs) are Building-scoped and reference this identity.
 *
 * Data minimization: only operationally necessary identity data is
 * stored — full name, identity document type + reference number, phone,
 * email, organization/company name and free-form notes. No photo
 * binaries, birthdates, addresses or other sensitive personal data.
 */

export const VISITOR_STATUSES = ['ACTIVE', 'INACTIVE', 'BLOCKED'] as const;

export type VisitorStatus = (typeof VISITOR_STATUSES)[number];

export function isVisitorStatus(value: unknown): value is VisitorStatus {
  return (
    typeof value === 'string' &&
    (VISITOR_STATUSES as readonly string[]).includes(value)
  );
}

export const VISITOR_IDENTITY_TYPES = [
  'NATIONAL_ID',
  'PASSPORT',
  'DRIVER_LICENSE',
  'EMPLOYEE_BADGE',
  'OTHER',
  'NONE',
] as const;

export type VisitorIdentityType = (typeof VISITOR_IDENTITY_TYPES)[number];

export function isVisitorIdentityType(
  value: unknown,
): value is VisitorIdentityType {
  return (
    typeof value === 'string' &&
    (VISITOR_IDENTITY_TYPES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type VisitorRecord = {
  id: string;
  clientId: string;
  fullName: string;
  identityType: VisitorIdentityType;
  identityNumber: string | null;
  phone: string | null;
  email: string | null;
  organizationName: string | null;
  notes: string | null;
  status: VisitorStatus;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicVisitor = {
  id: string;
  clientId: string;
  fullName: string;
  identityType: VisitorIdentityType;
  identityNumber: string | null;
  phone: string | null;
  email: string | null;
  organizationName: string | null;
  notes: string | null;
  status: VisitorStatus;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateVisitorInput = {
  clientId: string;
  fullName: string;
  identityType?: VisitorIdentityType;
  identityNumber?: string | null;
  phone?: string | null;
  email?: string | null;
  organizationName?: string | null;
  notes?: string | null;
  status?: VisitorStatus;
  createdByUserId?: string | null;
};

export type UpdateVisitorInput = {
  fullName?: string;
  identityType?: VisitorIdentityType;
  identityNumber?: string | null;
  phone?: string | null;
  email?: string | null;
  organizationName?: string | null;
  notes?: string | null;
  status?: VisitorStatus;
};

export type VisitorListFilters = {
  /** Case-insensitive substring search over full name. */
  search?: string;
  identityType?: VisitorIdentityType;
  identityNumber?: string;
  phone?: string;
  email?: string;
  status?: VisitorStatus;
};
