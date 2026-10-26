export const HANDYMAN_INTERNAL_NOTE_SUBJECT_TYPES = [
  'SERVICE_REQUEST',
  'UNLISTED_SERVICE_INTAKE_CASE',
] as const;

export type HandymanInternalNoteSubjectType =
  (typeof HANDYMAN_INTERNAL_NOTE_SUBJECT_TYPES)[number];

export const HANDYMAN_INTERNAL_NOTE_AUTHOR_ROLES = [
  'CUSTOMER_CARE',
  'OPERATIONS',
] as const;

export type HandymanInternalNoteAuthorRole =
  (typeof HANDYMAN_INTERNAL_NOTE_AUTHOR_ROLES)[number];

export const HANDYMAN_INTERNAL_NOTE_VISIBILITY = 'INTERNAL_ONLY' as const;

export type HandymanInternalNoteVisibility =
  typeof HANDYMAN_INTERNAL_NOTE_VISIBILITY;

export const HANDYMAN_INTERNAL_NOTE_MAX_CONTENT_LENGTH = 4000;
export const HANDYMAN_INTERNAL_NOTE_MAX_IDEMPOTENCY_KEY_LENGTH = 200;

export type HandymanInternalNoteRecord = {
  id: string;
  clientId: string;
  tenantCompanyId: string;
  buildingId: string;
  spaceId: string | null;
  subjectType: HandymanInternalNoteSubjectType;
  handymanRequestId: string | null;
  unlistedIntakeCaseId: string | null;
  visibilityClassification: HandymanInternalNoteVisibility;
  authorRole: HandymanInternalNoteAuthorRole;
  createdByUserId: string | null;
  createdByCareActorId: string | null;
  authorDisplayName: string;
  content: string;
  idempotencyKey: string;
  payloadHash: string;
  createdAt: Date;
};

export type PublicHandymanInternalNoteAuthor = {
  actorType: 'USER' | 'CARE_ACTOR';
  role: HandymanInternalNoteAuthorRole;
  userId: string | null;
  careActorId: string | null;
  displayName: string;
};

export type PublicHandymanInternalNote = {
  id: string;
  clientId: string;
  tenantCompanyId: string;
  buildingId: string;
  spaceId: string | null;
  subjectType: HandymanInternalNoteSubjectType;
  handymanRequestId: string | null;
  unlistedIntakeCaseId: string | null;
  visibilityClassification: HandymanInternalNoteVisibility;
  authorRole: HandymanInternalNoteAuthorRole;
  createdByUserId: string | null;
  createdByCareActorId: string | null;
  authorDisplayName: string;
  author: PublicHandymanInternalNoteAuthor;
  content: string;
  idempotencyKey: string;
  createdAt: string;
};

export type PublicHandymanInternalNoteMutationResult =
  PublicHandymanInternalNote & {
    replayed: boolean;
  };

export type CreateHandymanInternalNoteBody = {
  content: string;
  idempotencyKey: string;
};
