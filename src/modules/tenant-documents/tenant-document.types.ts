export const TENANT_DOCUMENT_STATUSES = [
  'ACTIVE',
  'EXPIRED',
  'INACTIVE',
] as const;
export type TenantDocumentStatus = (typeof TENANT_DOCUMENT_STATUSES)[number];
export const isTenantDocumentStatus = (value: unknown): value is TenantDocumentStatus =>
  typeof value === 'string' &&
  (TENANT_DOCUMENT_STATUSES as readonly string[]).includes(value);

export type TenantDocumentRecord = {
  id: string;
  clientId: string;
  tenantCompanyId: string;
  buildingId: string | null;
  documentType: string;
  documentName: string;
  documentNumber: string;
  issueDate: Date | null;
  expiryDate: Date | null;
  fileReference: string | null;
  status: TenantDocumentStatus;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicTenantDocument = Omit<
  TenantDocumentRecord,
  'issueDate' | 'expiryDate' | 'createdAt' | 'updatedAt'
> & {
  issueDate: string | null;
  expiryDate: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateTenantDocumentInput = {
  tenantCompanyId: string;
  buildingId?: string;
  documentType: string;
  documentName: string;
  documentNumber: string;
  issueDate?: Date | null;
  expiryDate?: Date | null;
  fileReference?: string;
  status?: TenantDocumentStatus;
  notes?: string;
};

export type NewTenantDocument = {
  clientId: string;
  tenantCompanyId: string;
  buildingId: string | null;
  documentType: string;
  documentName: string;
  documentNumber: string;
  issueDate: Date | null;
  expiryDate: Date | null;
  fileReference: string | null;
  status: TenantDocumentStatus;
  notes: string | null;
};

export type UpdateTenantDocumentInput = {
  documentType?: string;
  documentName?: string;
  documentNumber?: string;
  issueDate?: Date | null;
  expiryDate?: Date | null;
  fileReference?: string | null;
  status?: TenantDocumentStatus;
  notes?: string | null;
};

export type TenantDocumentFilters = {
  documentType?: string;
  status?: TenantDocumentStatus;
  buildingId?: string;
};
