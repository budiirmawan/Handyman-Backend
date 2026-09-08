/**
 * BE-01G — Invitation domain types.
 *
 * The raw invitation token is returned once at creation and never persisted;
 * only its hash is stored. Invitations are not authenticated sessions.
 */
export const INVITATION_STATUSES = ['PENDING', 'ACCEPTED', 'REVOKED'] as const;

export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

export function isInvitationStatus(value: unknown): value is InvitationStatus {
  return (
    typeof value === 'string' &&
    (INVITATION_STATUSES as readonly string[]).includes(value)
  );
}

export type InvitationRecord = {
  id: string;
  email: string;
  tokenHash: string;
  status: InvitationStatus;
  expiresAt: Date;
  invitedByUserId: string | null;
  acceptedByUserId: string | null;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation (never includes the token or its hash). */
export type PublicInvitation = {
  id: string;
  email: string;
  status: InvitationStatus;
  expiresAt: string;
  invitedByUserId: string | null;
  acceptedByUserId: string | null;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateInvitationInput = {
  email: string;
};

export type AcceptInvitationInput = {
  token: string;
  displayName: string;
  password: string;
};
