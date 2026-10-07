/**
 * CR-BE-PRO-02 PART 02 — RFQ Vendor Invitation authority.
 *
 * An invitation is an external Vendor access grant for exactly one RFQ. It is
 * not an internal User invitation, a Vendor Portal account, a quotation, or a
 * notification record. Raw invitation/session tokens are never part of the
 * persisted/public record types.
 */

export const RFQ_VENDOR_INVITATION_STATUSES = [
  'INVITED',
  'ACCEPTED',
  'DECLINED',
  'NO_BID',
  'EXPIRED',
  'REVOKED',
  'QUOTATION_SUBMITTED',
] as const;
export type RfqVendorInvitationStatus =
  (typeof RFQ_VENDOR_INVITATION_STATUSES)[number];

export function isRfqVendorInvitationStatus(
  value: unknown,
): value is RfqVendorInvitationStatus {
  return (
    typeof value === 'string' &&
    (RFQ_VENDOR_INVITATION_STATUSES as readonly string[]).includes(value)
  );
}

export const RFQ_VENDOR_SESSION_STATUSES = [
  'ACTIVE',
  'REVOKED',
  'EXPIRED',
] as const;
export type RfqVendorSessionStatus =
  (typeof RFQ_VENDOR_SESSION_STATUSES)[number];

export const RFQ_VENDOR_ACTIONS = ['ACCEPT', 'DECLINE', 'NO_BID'] as const;
export type RfqVendorAction = (typeof RFQ_VENDOR_ACTIONS)[number];

export type RfqVendorInvitationRecord = {
  id: string;
  rfqId: string;
  vendorId: string;
  clientId: string;
  buildingId: string;
  attemptNumber: number;
  status: RfqVendorInvitationStatus;
  responseDeadlineSnapshot: Date;
  tokenHash: string;
  tokenExpiresAt: Date;
  tokenConsumedAt: Date | null;
  contactSourceType: 'VENDOR';
  contactSourceId: string;
  contactNameSnapshot: string;
  recipientEmailSnapshot: string | null;
  viewedAt: Date | null;
  acceptedAt: Date | null;
  declinedAt: Date | null;
  noBidAt: Date | null;
  expiredAt: Date | null;
  revokedAt: Date | null;
  revokedByUserId: string | null;
  responseReason: string | null;
  idempotencyKey: string;
  idempotencyFingerprint: string;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicRfqVendorInvitation = Omit<
  RfqVendorInvitationRecord,
  | 'tokenHash'
  | 'idempotencyKey'
  | 'idempotencyFingerprint'
  | 'responseDeadlineSnapshot'
  | 'tokenExpiresAt'
  | 'tokenConsumedAt'
  | 'viewedAt'
  | 'acceptedAt'
  | 'declinedAt'
  | 'noBidAt'
  | 'expiredAt'
  | 'revokedAt'
  | 'createdAt'
  | 'updatedAt'
> & {
  responseDeadline: string;
  tokenExpiresAt: string;
  tokenConsumedAt: string | null;
  viewedAt: string | null;
  acceptedAt: string | null;
  declinedAt: string | null;
  noBidAt: string | null;
  expiredAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RfqVendorInvitationCreateResult = {
  invitation: PublicRfqVendorInvitation;
  invitationToken: string | null;
  created: boolean;
};

export type RfqVendorAccessSessionRecord = {
  id: string;
  invitationId: string;
  rfqId: string;
  vendorId: string;
  clientId: string;
  buildingId: string;
  sessionTokenHash: string;
  status: RfqVendorSessionStatus;
  issuedAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
  expiredAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicRfqVendorAccessSession = Omit<
  RfqVendorAccessSessionRecord,
  'sessionTokenHash' | 'issuedAt' | 'expiresAt' | 'lastUsedAt' | 'expiredAt' | 'revokedAt' | 'createdAt' | 'updatedAt'
> & {
  issuedAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  expiredAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RfqVendorSessionContext = {
  sessionId: string;
  invitationId: string;
  rfqId: string;
  vendorId: string;
  clientId: string;
  buildingId: string;
};

export type CreateRfqVendorInvitationInput = {
  rfqId: string;
  vendorId: string;
  idempotencyKey: string;
};

export type ResendRfqVendorInvitationInput = {
  invitationId: string;
  idempotencyKey: string;
};

export type RfqVendorInvitationFilters = {
  vendorId?: string;
  status?: RfqVendorInvitationStatus;
};

export type VendorRfqSafeLine = {
  id: string;
  lineNumber: number;
  sourceMode: 'MATERIAL' | 'SERVICE';
  description: string;
  quantity: number | null;
  requiredDate: string | null;
};

export type VendorSafeRfq = {
  rfq: {
    id: string;
    rfqNumber: string;
    title: string;
    description: string | null;
    sourceMode: 'MATERIAL' | 'SERVICE';
    currency: string;
    requiredDate: string | null;
    responseDeadline: string | null;
    status: string;
    lines: VendorRfqSafeLine[];
  };
  invitation: {
    id: string;
    vendorId: string;
    status: RfqVendorInvitationStatus;
    responseDeadline: string;
    contactName: string;
  };
};

export type RfqVendorExchangeResult = {
  session: PublicRfqVendorAccessSession;
  sessionToken: string;
  access: {
    invitationId: string;
    rfqId: string;
    vendorId: string;
  };
};
