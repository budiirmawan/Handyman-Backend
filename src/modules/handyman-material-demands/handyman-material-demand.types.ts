import type { PriceCatalogCurrency } from '../price-catalog-entries';

/** CR-HM-BE-07 RUN 1 — source and commercial authority are separate facts. */
export const HANDYMAN_MATERIAL_SUPPLY_SOURCES = [
  'PROVIDER_STOCK',
  'CUSTOMER_SUPPLIED',
] as const;
export type HandymanMaterialSupplySource =
  (typeof HANDYMAN_MATERIAL_SUPPLY_SOURCES)[number];

export const HANDYMAN_MATERIAL_COMMERCIAL_BASES = [
  'QUOTATION_INCLUDED',
  'ADDITIONAL_CUSTOMER_CHARGEABLE',
  'NON_CHARGEABLE_OPERATIONAL',
] as const;
export type HandymanMaterialCommercialBasis =
  (typeof HANDYMAN_MATERIAL_COMMERCIAL_BASES)[number];

export const HANDYMAN_MATERIAL_DEMAND_SOURCES = [
  'QUOTATION_INCLUDED',
  'CUSTOMER_APPROVED_ADDENDUM',
  'INTERNAL_OPERATION',
  'FIELD_DISCOVERED',
] as const;
export type HandymanMaterialDemandSource =
  (typeof HANDYMAN_MATERIAL_DEMAND_SOURCES)[number];

export const HANDYMAN_MATERIAL_DEMAND_STATUSES = [
  'ACTIVE',
  'SUPERSEDED',
  'CANCELLED',
] as const;
export type HandymanMaterialDemandStatus =
  (typeof HANDYMAN_MATERIAL_DEMAND_STATUSES)[number];

export const HANDYMAN_MATERIAL_ADDENDUM_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'SUPERSEDED',
  'CANCELLED',
] as const;
export type HandymanMaterialAddendumStatus =
  (typeof HANDYMAN_MATERIAL_ADDENDUM_STATUSES)[number];

export const HANDYMAN_MATERIAL_APPROVAL_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
] as const;
export type HandymanMaterialApprovalStatus =
  (typeof HANDYMAN_MATERIAL_APPROVAL_STATUSES)[number];

export const HANDYMAN_MATERIAL_APPROVAL_METHODS = [
  'IN_APP',
  'ASSISTED',
] as const;
export type HandymanMaterialApprovalMethod =
  (typeof HANDYMAN_MATERIAL_APPROVAL_METHODS)[number];

export const HANDYMAN_MATERIAL_APPROVED_FOR_TYPES = [
  'TENANT_COMPANY',
  'TENANT_PIC',
  'CUSTOMER',
] as const;
export type HandymanMaterialApprovedForType =
  (typeof HANDYMAN_MATERIAL_APPROVED_FOR_TYPES)[number];

/** Closed reason codes retain cancellation provenance without raw narratives. */
export const HANDYMAN_MATERIAL_CANCELLATION_REASONS = [
  'CUSTOMER_WITHDREW',
  'SCOPE_NO_LONGER_REQUIRED',
  'OTHER_OPERATIONAL',
] as const;
export type HandymanMaterialCancellationReason =
  (typeof HANDYMAN_MATERIAL_CANCELLATION_REASONS)[number];

export type HandymanMaterialDemandRecord = {
  id: string;
  clientId: string;
  handymanJobId: string;
  handymanRequestId: string;
  buildingId: string;
  supplySource: HandymanMaterialSupplySource;
  commercialBasis: HandymanMaterialCommercialBasis;
  sourceContext: HandymanMaterialDemandSource;
  inventoryItemId: string | null;
  uomId: string;
  description: string;
  quantity: string;
  handymanServiceVisitId: string | null;
  quotationRevisionId: string | null;
  handymanQuotationLineId: string | null;
  commercialAddendumId: string | null;
  handymanMaterialApprovalId: string | null;
  status: HandymanMaterialDemandStatus;
  supersedesDemandId: string | null;
  supersededAt: Date | null;
  supersededByUserId: string | null;
  cancelledAt: Date | null;
  cancelledByUserId: string | null;
  cancellationReason: HandymanMaterialCancellationReason | null;
  idempotencyKey: string;
  idempotencyFingerprint: string;
  cancellationIdempotencyKey: string | null;
  cancellationIdempotencyFingerprint: string | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type HandymanMaterialCommercialAddendumRecord = {
  id: string;
  clientId: string;
  handymanJobId: string;
  handymanRequestId: string;
  buildingId: string;
  supplySource: HandymanMaterialSupplySource;
  commercialBasis: 'ADDITIONAL_CUSTOMER_CHARGEABLE';
  inventoryItemId: string | null;
  uomId: string;
  description: string;
  quantity: string;
  currency: PriceCatalogCurrency | null;
  unitCommercialAmount: string | null;
  totalCommercialAmount: string | null;
  referencePriceCatalogEntryId: string | null;
  referenceScopeTier: string | null;
  referenceAsOf: Date | null;
  status: HandymanMaterialAddendumStatus;
  supersedesAddendumId: string | null;
  supersededAt: Date | null;
  supersededByUserId: string | null;
  cancelledAt: Date | null;
  cancelledByUserId: string | null;
  cancellationReason: HandymanMaterialCancellationReason | null;
  idempotencyKey: string;
  idempotencyFingerprint: string;
  cancellationIdempotencyKey: string | null;
  cancellationIdempotencyFingerprint: string | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type HandymanMaterialApprovalRecord = {
  id: string;
  clientId: string;
  handymanJobId: string;
  handymanRequestId: string;
  buildingId: string;
  commercialAddendumId: string;
  status: HandymanMaterialApprovalStatus;
  method: HandymanMaterialApprovalMethod | null;
  approvedForType: HandymanMaterialApprovedForType | null;
  approvedForTenantCompanyId: string | null;
  approvedForTenantPicId: string | null;
  approvedForName: string | null;
  decisionNotes: string | null;
  recordedByUserId: string | null;
  decidedAt: Date | null;
  cancelledAt: Date | null;
  cancelledByUserId: string | null;
  decisionIdempotencyKey: string | null;
  decisionIdempotencyFingerprint: string | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Service read shape: no customer name/contact or assisted narrative leaks. */
export type PublicHandymanMaterialDemand = {
  id: string;
  clientId: string;
  handymanJobId: string;
  handymanRequestId: string;
  buildingId: string;
  supplySource: HandymanMaterialSupplySource;
  commercialBasis: HandymanMaterialCommercialBasis;
  sourceContext: HandymanMaterialDemandSource;
  inventoryItemId: string | null;
  uomId: string;
  description: string;
  quantity: number;
  handymanServiceVisitId: string | null;
  quotationRevisionId: string | null;
  handymanQuotationLineId: string | null;
  commercialAddendumId: string | null;
  handymanMaterialApprovalId: string | null;
  status: HandymanMaterialDemandStatus;
  supersedesDemandId: string | null;
  supersededAt: string | null;
  supersededByUserId: string | null;
  cancelledAt: string | null;
  cancelledByUserId: string | null;
  cancellationReason: HandymanMaterialCancellationReason | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

/** Immutable commercial scope read; price is provenance-backed or null. */
export type PublicHandymanMaterialCommercialAddendum = {
  id: string;
  clientId: string;
  handymanJobId: string;
  handymanRequestId: string;
  buildingId: string;
  supplySource: HandymanMaterialSupplySource;
  commercialBasis: 'ADDITIONAL_CUSTOMER_CHARGEABLE';
  inventoryItemId: string | null;
  uomId: string;
  description: string;
  quantity: number;
  currency: PriceCatalogCurrency | null;
  unitCommercialAmount: number | null;
  totalCommercialAmount: number | null;
  referencePriceCatalogEntryId: string | null;
  referenceScopeTier: string | null;
  referenceAsOf: string | null;
  status: HandymanMaterialAddendumStatus;
  supersedesAddendumId: string | null;
  supersededAt: string | null;
  supersededByUserId: string | null;
  cancelledAt: string | null;
  cancelledByUserId: string | null;
  cancellationReason: HandymanMaterialCancellationReason | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

/** Approval read deliberately omits approved-for names and assisted notes. */
export type PublicHandymanMaterialApproval = {
  id: string;
  clientId: string;
  handymanJobId: string;
  handymanRequestId: string;
  buildingId: string;
  commercialAddendumId: string;
  status: HandymanMaterialApprovalStatus;
  method: HandymanMaterialApprovalMethod | null;
  approvedForType: HandymanMaterialApprovedForType | null;
  approvedForTenantCompanyId: string | null;
  approvedForTenantPicId: string | null;
  recordedByUserId: string | null;
  decidedAt: string | null;
  cancelledAt: string | null;
  cancelledByUserId: string | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateQuotationIncludedMaterialDemandInput = {
  handymanJobId: string;
  handymanQuotationLineId: string;
  idempotencyKey: string;
};

/**
 * Internal operational scope. FIELD_DISCOVERED is allowed only with a visit
 * and a current governed Lead Worker; no caller submits crew/member identity.
 */
export type CreateNonChargeableMaterialDemandInput = {
  handymanJobId: string;
  supplySource: HandymanMaterialSupplySource;
  inventoryItemId?: string | null;
  uomId: string;
  description?: string | null;
  quantity: number | string;
  sourceContext?: 'INTERNAL_OPERATION' | 'FIELD_DISCOVERED';
  handymanServiceVisitId?: string | null;
  supersedesDemandId?: string | null;
  idempotencyKey: string;
};

/** Convenience type for the item-master-optional customer-supplied lane. */
export type CreateCustomerSuppliedMaterialDemandInput = Omit<
  CreateNonChargeableMaterialDemandInput,
  'supplySource'
>;

/**
 * No caller price, currency, client, request, customer, or quotation revision
 * can enter this command. Provider-stock pricing is resolved only through the
 * existing price-catalog lookup; customer-supplied scope carries no Provider
 * material charge in this Run 1 lane.
 */
export type CreateHandymanMaterialCommercialAddendumInput = {
  handymanJobId: string;
  supplySource: HandymanMaterialSupplySource;
  inventoryItemId?: string | null;
  uomId: string;
  description?: string | null;
  quantity: number | string;
  supersedesAddendumId?: string | null;
  idempotencyKey: string;
};

export type HandymanMaterialApprovalDecision = 'APPROVED' | 'REJECTED';

export type DecideHandymanMaterialApprovalInAppInput = {
  handymanMaterialApprovalId: string;
  decision: HandymanMaterialApprovalDecision;
  notes?: string | null;
  idempotencyKey: string;
};

export type RecordHandymanMaterialApprovalAssistedInput = {
  handymanMaterialApprovalId: string;
  decision: HandymanMaterialApprovalDecision;
  // The class is selected here, but any customer/tenant identity is derived
  // server-side from the approval's job -> request context.
  approvedFor:
    | { type: 'TENANT_COMPANY' }
    | { type: 'TENANT_PIC' }
    | { type: 'CUSTOMER' };
  notes: string;
  idempotencyKey: string;
};

export type CancelHandymanMaterialDemandInput = {
  handymanMaterialDemandId: string;
  reason: HandymanMaterialCancellationReason;
  idempotencyKey: string;
};

export type CancelHandymanMaterialCommercialAddendumInput = {
  handymanMaterialCommercialAddendumId: string;
  reason: HandymanMaterialCancellationReason;
  idempotencyKey: string;
};

export type HandymanMaterialAddendumCreationResult = {
  addendum: PublicHandymanMaterialCommercialAddendum;
  approval: PublicHandymanMaterialApproval;
  replayed: boolean;
};

export type HandymanMaterialDemandCreationResult = {
  demand: PublicHandymanMaterialDemand;
  replayed: boolean;
};

export type HandymanMaterialApprovalDecisionResult = {
  approval: PublicHandymanMaterialApproval;
  addendum: PublicHandymanMaterialCommercialAddendum;
  demand: PublicHandymanMaterialDemand | null;
  replayed: boolean;
};

export type HandymanMaterialDemandCancellationResult = {
  demand: PublicHandymanMaterialDemand;
  replayed: boolean;
};

export type HandymanMaterialAddendumCancellationResult = {
  addendum: PublicHandymanMaterialCommercialAddendum;
  approval: PublicHandymanMaterialApproval;
  replayed: boolean;
};
