export const FINDING_STATUSES = [
  'OPEN',
  'ASSIGNED',
  'IN_PROGRESS',
  'PENDING_REVIEW',
  'REJECTED',
  'REWORK_REQUIRED',
  'RESUBMITTED',
  'VERIFIED',
  'CLOSED',
  'CANCELLED',
] as const;
export const FINDING_SOURCE_TYPES = [
  'FORM_INSTANCE',
  'CHECKLIST_EXECUTION',
  'WORK_ORDER',
] as const;

export type FindingStatus = (typeof FINDING_STATUSES)[number];
export type FindingSourceType = (typeof FINDING_SOURCE_TYPES)[number];

export function isFindingSourceType(value: unknown): value is FindingSourceType {
  return typeof value === 'string' &&
    (FINDING_SOURCE_TYPES as readonly string[]).includes(value);
}

export function isFindingStatus(value: unknown): value is FindingStatus {
  return typeof value === 'string' &&
    (FINDING_STATUSES as readonly string[]).includes(value);
}

export const FINDING_TRANSITIONS: Record<
  FindingStatus,
  readonly FindingStatus[]
> = {
  OPEN: ['ASSIGNED', 'CANCELLED'],
  ASSIGNED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['PENDING_REVIEW', 'CANCELLED'],
  PENDING_REVIEW: [
    'VERIFIED',
    'REJECTED',
    'REWORK_REQUIRED',
    'CANCELLED',
  ],
  REJECTED: ['REWORK_REQUIRED', 'CANCELLED'],
  REWORK_REQUIRED: ['IN_PROGRESS', 'RESUBMITTED', 'CANCELLED'],
  RESUBMITTED: ['PENDING_REVIEW', 'CANCELLED'],
  VERIFIED: ['CLOSED'],
  CLOSED: [],
  CANCELLED: [],
};

export function canTransitionFindingStatus(
  from: FindingStatus,
  to: FindingStatus,
): boolean {
  return FINDING_TRANSITIONS[from].includes(to);
}

export type FindingRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  findingNumber: string;
  title: string;
  description: string | null;
  classificationId: string | null;
  severityId: string | null;
  sourceType: FindingSourceType | null;
  sourceId: string | null;
  status: FindingStatus;
  stateChangedAt: Date;
  reportedByUserId: string;
  reportedAt: Date;
  closedAt: Date | null;
  closedByUserId: string | null;
  closureNotes: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicFinding = {
  id: string;
  clientId: string;
  buildingId: string;
  findingNumber: string;
  title: string;
  description: string | null;
  classificationId: string | null;
  severityId: string | null;
  sourceType: FindingSourceType | null;
  sourceId: string | null;
  status: FindingStatus;
  stateChangedAt: string;
  reportedByUserId: string;
  reportedAt: string;
  closedAt: string | null;
  closedByUserId: string | null;
  closureNotes: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateFindingInput = {
  clientId: string;
  buildingId: string;
  findingNumber: string;
  title: string;
  description?: string;
  reportedByUserId: string;
};

export type NewFinding = {
  clientId: string;
  buildingId: string;
  findingNumber: string;
  title: string;
  description: string | null;
  reportedByUserId: string;
};

export type UpdateFindingInput = {
  title?: string;
  description?: string | null;
  classificationId?: string | null;
  severityId?: string | null;
};

export type FindingFilters = {
  status?: FindingStatus;
};
