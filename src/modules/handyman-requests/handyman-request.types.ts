export const HANDYMAN_OPERATIONAL_SURFACES = ['BM_SUPER_APP'] as const;
export type HandymanOperationalSurface =
  (typeof HANDYMAN_OPERATIONAL_SURFACES)[number];

export function isHandymanOperationalSurface(
  value: unknown,
): value is HandymanOperationalSurface {
  return (
    typeof value === 'string' &&
    (HANDYMAN_OPERATIONAL_SURFACES as readonly string[]).includes(value)
  );
}

export const HANDYMAN_INBOUND_CHANNELS = [
  'WHATSAPP',
  'PHONE',
  'WALK_IN',
  'OTHER',
] as const;
export type HandymanInboundChannel =
  (typeof HANDYMAN_INBOUND_CHANNELS)[number];

export function isHandymanInboundChannel(
  value: unknown,
): value is HandymanInboundChannel {
  return (
    typeof value === 'string' &&
    (HANDYMAN_INBOUND_CHANNELS as readonly string[]).includes(value)
  );
}

export const HANDYMAN_REQUEST_PRIORITIES = [
  'LOW',
  'MEDIUM',
  'HIGH',
  'CRITICAL',
] as const;
export type HandymanRequestPriority =
  (typeof HANDYMAN_REQUEST_PRIORITIES)[number];

export function isHandymanRequestPriority(
  value: unknown,
): value is HandymanRequestPriority {
  return (
    typeof value === 'string' &&
    (HANDYMAN_REQUEST_PRIORITIES as readonly string[]).includes(value)
  );
}

export const HANDYMAN_REQUEST_STATUSES = [
  'SUBMITTED',
  'CANCELLED',
  // CR-HM-BE-03 RUN 1 — additive governed lifecycle statuses (migration
  // 0350). CR-HM-BE-01 semantics are unchanged: intake creates SUBMITTED
  // and cancellation remains SUBMITTED → CANCELLED only.
  'TRIAGED',
  'INSPECTION_REQUIRED',
  'INSPECTION_COMPLETED',
  'QUOTATION_PENDING',
  'APPROVED',
  'QUOTATION_REJECTED',
] as const;
export type HandymanRequestStatus =
  (typeof HANDYMAN_REQUEST_STATUSES)[number];

export function isHandymanRequestStatus(
  value: unknown,
): value is HandymanRequestStatus {
  return (
    typeof value === 'string' &&
    (HANDYMAN_REQUEST_STATUSES as readonly string[]).includes(value)
  );
}

export type HandymanRequestRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  spaceId: string;
  tenantCompanyId: string | null;
  tenantPicId: string | null;
  customerName: string;
  customerPhone: string | null;
  customerEmail: string | null;
  createdByUserId: string;
  operationalSurface: HandymanOperationalSurface;
  inboundChannel: HandymanInboundChannel;
  requestNumber: string;
  title: string;
  description: string | null;
  priority: HandymanRequestPriority;
  status: HandymanRequestStatus;
  idempotencyKey: string | null;
  idempotencyFingerprint: string | null;
  requestedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateHandymanRequestRecordInput = {
  id?: string;
  clientId: string;
  buildingId: string;
  spaceId: string;
  tenantCompanyId?: string | null;
  tenantPicId?: string | null;
  customerName: string;
  customerPhone?: string | null;
  customerEmail?: string | null;
  createdByUserId: string;
  operationalSurface?: HandymanOperationalSurface;
  inboundChannel: HandymanInboundChannel;
  requestNumber: string;
  title: string;
  description?: string | null;
  priority?: HandymanRequestPriority;
  status?: HandymanRequestStatus;
  idempotencyKey?: string | null;
  idempotencyFingerprint?: string | null;
  requestedAt?: Date;
};

export type HandymanRequestFilters = {
  buildingId?: string;
  spaceId?: string;
  status?: HandymanRequestStatus;
  inboundChannel?: HandymanInboundChannel;
  createdByUserId?: string;
  tenantCompanyId?: string;
  search?: string;
  limit?: number;
  offset?: number;
};

export type CreateHandymanRequestInput = {
  buildingId: string;
  spaceId: string;
  tenantCompanyId?: string | null;
  tenantPicId?: string | null;
  customerName: string;
  customerPhone?: string | null;
  customerEmail?: string | null;
  operationalSurface?: HandymanOperationalSurface;
  inboundChannel: HandymanInboundChannel;
  title: string;
  description?: string | null;
  priority?: HandymanRequestPriority;
  idempotencyKey?: string | null;
  requestedAt?: Date | string | null;
};

export type PublicHandymanRequest = {
  id: string;
  clientId: string;
  buildingId: string;
  spaceId: string;
  tenantCompanyId: string | null;
  tenantPicId: string | null;
  customerName: string;
  customerPhone: string | null;
  customerEmail: string | null;
  createdByUserId: string;
  operationalSurface: HandymanOperationalSurface;
  inboundChannel: HandymanInboundChannel;
  requestNumber: string;
  title: string;
  description: string | null;
  priority: HandymanRequestPriority;
  status: HandymanRequestStatus;
  idempotencyKey: string | null;
  requestedAt: string;
  createdAt: string;
  updatedAt: string;
};
