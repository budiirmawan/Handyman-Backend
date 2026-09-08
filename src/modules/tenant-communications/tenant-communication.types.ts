export const TENANT_COMMUNICATION_STATUSES = ['DRAFT', 'SENT', 'READ'] as const;
export type TenantCommunicationStatus =
  (typeof TENANT_COMMUNICATION_STATUSES)[number];
export const isTenantCommunicationStatus = (
  value: unknown,
): value is TenantCommunicationStatus =>
  typeof value === 'string' &&
  (TENANT_COMMUNICATION_STATUSES as readonly string[]).includes(value);

export const TENANT_COMMUNICATION_RELATED_TYPES = [
  'SERVICE_REQUEST',
  'COMPLAINT',
  'UTILITY_REQUEST',
  'DOCUMENT',
] as const;
export type TenantCommunicationRelatedType =
  (typeof TENANT_COMMUNICATION_RELATED_TYPES)[number];
export const isTenantCommunicationRelatedType = (
  value: unknown,
): value is TenantCommunicationRelatedType =>
  typeof value === 'string' &&
  (TENANT_COMMUNICATION_RELATED_TYPES as readonly string[]).includes(value);

export type TenantCommunicationRecord = {
  id: string;
  clientId: string;
  tenantCompanyId: string;
  buildingId: string | null;
  senderUserId: string;
  recipientTenantPicId: string | null;
  recipientUserId: string | null;
  communicationType: string;
  subject: string;
  messageBody: string;
  relatedType: TenantCommunicationRelatedType | null;
  serviceRequestId: string | null;
  complaintId: string | null;
  utilityRequestId: string | null;
  documentId: string | null;
  status: TenantCommunicationStatus;
  sentAt: Date | null;
  readAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicTenantCommunication = Omit<
  TenantCommunicationRecord,
  'sentAt' | 'readAt' | 'createdAt' | 'updatedAt'
> & {
  relatedId: string | null;
  sentAt: string | null;
  readAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateTenantCommunicationInput = {
  tenantCompanyId: string;
  buildingId?: string;
  recipientTenantPicId?: string;
  recipientUserId?: string;
  communicationType: string;
  subject: string;
  messageBody: string;
  relatedType?: TenantCommunicationRelatedType;
  relatedId?: string;
};

export type NewTenantCommunication = Omit<
  TenantCommunicationRecord,
  'id' | 'status' | 'sentAt' | 'readAt' | 'createdAt' | 'updatedAt'
>;

export type UpdateTenantCommunicationInput = {
  communicationType?: string;
  subject?: string;
  messageBody?: string;
};

export type TenantCommunicationFilters = {
  recipientTenantPicId?: string;
  recipientUserId?: string;
  communicationType?: string;
  relatedType?: TenantCommunicationRelatedType;
  relatedId?: string;
  buildingId?: string;
  status?: TenantCommunicationStatus;
};
