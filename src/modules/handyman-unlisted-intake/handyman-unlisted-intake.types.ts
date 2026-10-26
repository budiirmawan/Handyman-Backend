import type {
  PublicHandymanInternalNote,
  PublicHandymanInternalNoteMutationResult,
} from '../handyman-internal-notes';

export const HANDYMAN_UNLISTED_INTAKE_STATUSES = [
  'PENDING_TRIAGE',
] as const;

export type HandymanUnlistedIntakeStatus =
  (typeof HANDYMAN_UNLISTED_INTAKE_STATUSES)[number];

export const HANDYMAN_UNLISTED_INTAKE_ORIGIN_CHANNELS = [
  'CUSTOMER_CARE_BACKEND',
  'BM_SUPER_APP',
] as const;

export type HandymanUnlistedIntakeOriginChannel =
  (typeof HANDYMAN_UNLISTED_INTAKE_ORIGIN_CHANNELS)[number];

/**
 * Documented future Operations triage decisions (STEP 4 — Operations Handoff).
 * Triage execution and conversion to a formal service request are out of scope
 * for PART 01.
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
  createdByUserId: string | null;
  createdByCareActorId: string | null;
  createdByDisplayName: string;
  idempotencyKey: string;
  payloadHash: string;
  createdAt: Date;
  updatedAt: Date;
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
  createdByUserId: string | null;
  createdByCareActorId: string | null;
  createdByDisplayName: string;
  createdBy: PublicHandymanUnlistedIntakeActor;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
  internalNotes: PublicHandymanInternalNote[];
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
