/**
 * BE-13K — Delivery / Courier types.
 *
 * Delivery metadata can optionally bind to the shared Visitor identity
 * and one existing visit. Check-In / Check-Out remain owned by the BE-13
 * visit lifecycle whenever those references are present.
 */

export const DELIVERY_COURIER_TYPES = ['DELIVERY', 'COURIER'] as const;
export type DeliveryCourierType = (typeof DELIVERY_COURIER_TYPES)[number];

export function isDeliveryCourierType(
  value: unknown,
): value is DeliveryCourierType {
  return (
    typeof value === 'string' &&
    (DELIVERY_COURIER_TYPES as readonly string[]).includes(value)
  );
}

export const DELIVERY_COURIER_STATUSES = [
  'ARRIVED',
  'RECEIVED',
  'REJECTED',
  'CANCELLED',
] as const;

export type DeliveryCourierStatus =
  (typeof DELIVERY_COURIER_STATUSES)[number];

export function isDeliveryCourierStatus(
  value: unknown,
): value is DeliveryCourierStatus {
  return (
    typeof value === 'string' &&
    (DELIVERY_COURIER_STATUSES as readonly string[]).includes(value)
  );
}

export type DeliveryCourierRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  visitorId: string | null;
  expectedVisitorId: string | null;
  walkInVisitId: string | null;
  deliveryType: DeliveryCourierType;
  courierCompany: string | null;
  courierName: string | null;
  recipientUserId: string | null;
  recipientWorkforceId: string | null;
  recipientName: string | null;
  arrivedAt: Date;
  referenceNumber: string | null;
  notes: string | null;
  status: DeliveryCourierStatus;
  statusUpdatedAt: Date | null;
  statusUpdatedByUserId: string | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicDeliveryCourier = Omit<
  DeliveryCourierRecord,
  'arrivedAt' | 'statusUpdatedAt' | 'createdAt' | 'updatedAt'
> & {
  arrivedAt: string;
  statusUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateDeliveryCourierInput = {
  buildingId?: string;
  visitorId?: string | null;
  expectedVisitorId?: string;
  walkInVisitId?: string;
  deliveryType: DeliveryCourierType;
  courierCompany?: string | null;
  courierName?: string | null;
  recipientUserId?: string | null;
  recipientWorkforceId?: string | null;
  recipientName?: string | null;
  /** ISO timestamp; defaults to now and cannot be in the future. */
  arrivedAt?: string;
  referenceNumber?: string | null;
  notes?: string | null;
  createdByUserId: string;
};

export type UpdateDeliveryCourierStatusInput = {
  status: Exclude<DeliveryCourierStatus, 'ARRIVED'>;
  referenceNumber?: string | null;
  notes?: string | null;
  statusUpdatedByUserId: string;
};

export type DeliveryCourierListFilters = {
  buildingId?: string;
  visitorId?: string;
  expectedVisitorId?: string;
  walkInVisitId?: string;
  deliveryType?: DeliveryCourierType;
  status?: DeliveryCourierStatus;
  search?: string;
};
