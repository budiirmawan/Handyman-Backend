import type {
  PublicHandymanInternalNote,
  PublicHandymanInternalNoteMutationResult,
} from '../handyman-internal-notes';

/**
 * CR-HM-MANUAL-QUOTATION-01 PART 01 widened the 0486 vocabulary with the
 * five Operations triage outcomes. `PENDING_TRIAGE` stays the ONLY creation
 * state and can never be re-entered; `AWAITING_INFORMATION` is the single
 * non-terminal triage state; the remaining four are terminal.
 */
export const HANDYMAN_UNLISTED_INTAKE_STATUSES = [
  'PENDING_TRIAGE',
  'AWAITING_INFORMATION',
  'TRIAGED_CATALOG_MATCHED',
  'TRIAGED_CLIENT_CUSTOM_SERVICE',
  'TRIAGED_MANUAL_QUOTATION_READY',
  'REJECTED_UNSUPPORTED',
] as const;

export type HandymanUnlistedIntakeStatus =
  (typeof HANDYMAN_UNLISTED_INTAKE_STATUSES)[number];

/** Statuses an Operations triage decision may be recorded FROM. */
export const HANDYMAN_UNLISTED_INTAKE_TRIAGE_ELIGIBLE_STATUSES = [
  'PENDING_TRIAGE',
  'AWAITING_INFORMATION',
] as const;

/**
 * The five governed Operations triage decisions. The first four are the
 * PART 01 forecast (`HANDYMAN_UNLISTED_INTAKE_FUTURE_TRIAGE_DECISIONS`,
 * kept verbatim below); `ONE_TIME_MANUAL_QUOTATION_REQUIRED` is the
 * one-time manual quotation branch this PART adds.
 */
export const HANDYMAN_UNLISTED_INTAKE_TRIAGE_DECISIONS = [
  'MATCH_EXISTING_CATALOG_SERVICE',
  'CREATE_CLIENT_CUSTOM_SERVICE',
  'ONE_TIME_MANUAL_QUOTATION_REQUIRED',
  'REQUEST_MORE_INFORMATION_OR_INSPECTION',
  'REJECT_UNSUPPORTED',
] as const;

export type HandymanUnlistedIntakeTriageDecision =
  (typeof HANDYMAN_UNLISTED_INTAKE_TRIAGE_DECISIONS)[number];

/** Server-derived projection per decision — never caller-suppliable. */
export const HANDYMAN_UNLISTED_INTAKE_TRIAGE_PROJECTION: Record<
  HandymanUnlistedIntakeTriageDecision,
  HandymanUnlistedIntakeStatus
> = {
  MATCH_EXISTING_CATALOG_SERVICE: 'TRIAGED_CATALOG_MATCHED',
  CREATE_CLIENT_CUSTOM_SERVICE: 'TRIAGED_CLIENT_CUSTOM_SERVICE',
  ONE_TIME_MANUAL_QUOTATION_REQUIRED: 'TRIAGED_MANUAL_QUOTATION_READY',
  REQUEST_MORE_INFORMATION_OR_INSPECTION: 'AWAITING_INFORMATION',
  REJECT_UNSUPPORTED: 'REJECTED_UNSUPPORTED',
};

export const HANDYMAN_UNLISTED_INTAKE_ORIGIN_CHANNELS = [
  'CUSTOMER_CARE_BACKEND',
  'BM_SUPER_APP',
] as const;

export type HandymanUnlistedIntakeOriginChannel =
  (typeof HANDYMAN_UNLISTED_INTAKE_ORIGIN_CHANNELS)[number];

/**
 * Documented future Operations triage decisions (STEP 4 — Operations Handoff).
 * Retained verbatim from PART 01 as the frozen forecast this PART implements:
 * `HANDYMAN_UNLISTED_INTAKE_TRIAGE_DECISIONS` is this superset plus the
 * one-time manual quotation branch. Conversion to a formal service request is
 * still out of scope (PART 02).
 */
export const HANDYMAN_UNLISTED_INTAKE_FUTURE_TRIAGE_DECISIONS = [
  'MATCH_EXISTING_CATALOG_SERVICE',
  'CREATE_CLIENT_CUSTOM_SERVICE',
  'REQUEST_MORE_INFORMATION_OR_INSPECTION',
  'REJECT_UNSUPPORTED',
] as const;

export type HandymanUnlistedIntakeFutureTriageDecision =
  (typeof HANDYMAN_UNLISTED_INTAKE_FUTURE_TRIAGE_DECISIONS)[number];

export const HANDYMAN_UNLISTED_INTAKE_MAX_SERVICE_NAME_LENGTH = 250;
export const HANDYMAN_UNLISTED_INTAKE_MAX_DESCRIPTION_LENGTH = 2000;
export const HANDYMAN_UNLISTED_INTAKE_MAX_IDEMPOTENCY_KEY_LENGTH = 200;
export const HANDYMAN_UNLISTED_INTAKE_MIN_TRIAGE_JUSTIFICATION_LENGTH = 10;
export const HANDYMAN_UNLISTED_INTAKE_MAX_TRIAGE_JUSTIFICATION_LENGTH = 2000;
export const HANDYMAN_UNLISTED_INTAKE_MAX_TRIAGE_DETAIL_LENGTH = 1000;

export type HandymanUnlistedIntakeCaseRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  spaceId: string | null;
  tenantCompanyId: string;
  tenantPicId: string | null;
  approvalTenantCompanyId: string;
  costResponsibleTenantCompanyId: string;
  channelAttributionId: string | null;
  originChannel: HandymanUnlistedIntakeOriginChannel;
  originReference: string | null;
  requestedServiceName: string;
  description: string;
  preferredWindowStart: Date | null;
  preferredWindowEnd: Date | null;
  preferredWindowTimezone: string | null;
  status: HandymanUnlistedIntakeStatus;
  triageDecisionId: string | null;
  triagedAt: Date | null;
  createdByUserId: string | null;
  createdByCareActorId: string | null;
  createdByDisplayName: string;
  idempotencyKey: string;
  payloadHash: string;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Append-only Operations triage decision fact (migration 0487). Every column
 * is server-derived from the authoritative intake case plus the authenticated
 * actor; `statusAfter` is the projection the decision authorizes.
 */
export type HandymanUnlistedIntakeTriageDecisionRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  tenantCompanyId: string;
  intakeCaseId: string;
  decision: HandymanUnlistedIntakeTriageDecision;
  statusAfter: HandymanUnlistedIntakeStatus;
  justification: string;
  clarificationRequest: string | null;
  catalogServiceId: string | null;
  customServiceName: string | null;
  customServiceNotes: string | null;
  manualQuoteSummary: string | null;
  /** Decimal carried as text — never rounded by the transport. */
  manualQuoteQuantity: string | null;
  manualQuoteUomId: string | null;
  triagedByUserId: string;
  triagedByDisplayName: string;
  triagedAt: Date;
  idempotencyKey: string;
  payloadHash: string;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicHandymanUnlistedIntakeTriageDecision = {
  id: string;
  intakeCaseId: string;
  clientId: string;
  buildingId: string;
  tenantCompanyId: string;
  decision: HandymanUnlistedIntakeTriageDecision;
  statusAfter: HandymanUnlistedIntakeStatus;
  justification: string;
  clarificationRequest: string | null;
  catalogServiceId: string | null;
  customServiceName: string | null;
  customServiceNotes: string | null;
  manualQuoteSummary: string | null;
  manualQuoteQuantity: string | null;
  manualQuoteUomId: string | null;
  /** Manual-quotation readiness flag consumed by PART 02. */
  manualQuotationRequired: boolean;
  triagedByUserId: string;
  triagedByDisplayName: string;
  triagedAt: string;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
};

export type PublicHandymanUnlistedIntakePreferredWindow = {
  preferredWindowStart: string;
  preferredWindowEnd: string;
  timezone: string;
};

export type PublicHandymanUnlistedIntakeActor = {
  actorType: 'USER' | 'CARE_ACTOR';
  userId: string | null;
  careActorId: string | null;
  displayName: string;
};

export type PublicHandymanUnlistedIntakeCase = {
  id: string;
  clientId: string;
  buildingId: string;
  spaceId: string | null;
  tenantCompanyId: string;
  tenantPicId: string | null;
  approvalTenantCompanyId: string;
  costResponsibleTenantCompanyId: string;
  channelAttributionId: string | null;
  originChannel: HandymanUnlistedIntakeOriginChannel;
  originReference: string | null;
  requestedServiceName: string;
  description: string;
  preferredWindowStart: string | null;
  preferredWindowEnd: string | null;
  preferredWindowTimezone: string | null;
  preferredWindow: PublicHandymanUnlistedIntakePreferredWindow | null;
  status: HandymanUnlistedIntakeStatus;
  triageDecisionId: string | null;
  triagedAt: string | null;
  /** The ONE effective triage decision (null while untriaged). */
  triage: PublicHandymanUnlistedIntakeTriageDecision | null;
  /** Chronological append-only triage history (clarification rounds included). */
  triageHistory: PublicHandymanUnlistedIntakeTriageDecision[];
  createdByUserId: string | null;
  createdByCareActorId: string | null;
  createdByDisplayName: string;
  createdBy: PublicHandymanUnlistedIntakeActor;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
  internalNotes: PublicHandymanInternalNote[];
};

/** Triage command result: the decision fact plus the refreshed case view. */
export type PublicHandymanUnlistedIntakeTriageMutationResult = {
  replayed: boolean;
  decision: PublicHandymanUnlistedIntakeTriageDecision;
  intakeCase: PublicHandymanUnlistedIntakeCase;
};

export type PublicHandymanUnlistedIntakeMutationResult =
  PublicHandymanUnlistedIntakeCase & {
    replayed: boolean;
    internalNote?: PublicHandymanInternalNoteMutationResult;
  };

export type HandymanUnlistedIntakeListPage = {
  items: PublicHandymanUnlistedIntakeCase[];
  pagination: {
    limit: number;
    offset: number;
    nextOffset: number | null;
  };
};
