import type { HandymanBmClearanceAssessment } from './handyman-bm-clearance';

export const HANDYMAN_DISPATCH_RELEASE_STATUSES = [
  'RELEASED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'SUPERSEDED',
] as const;
export type HandymanDispatchReleaseStatus =
  (typeof HANDYMAN_DISPATCH_RELEASE_STATUSES)[number];

export type HandymanDispatchReleaseRecord = {
  id: string;
  clientId: string;
  executionScopeId: string;
  assignmentId: string;
  appointmentId: string | null;
  status: HandymanDispatchReleaseStatus;
  releasedByUserId: string;
  releasedAt: Date;
  cancelledByUserId: string | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  readinessSnapshot: Record<string, unknown>;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicHandymanDispatchRelease = Omit<
  HandymanDispatchReleaseRecord,
  'releasedAt' | 'cancelledAt' | 'createdAt' | 'updatedAt'
> & {
  releasedAt: string;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type HandymanDispatchReadinessCheck = {
  authorizedScope: boolean;
  confirmedAppointment: boolean;
  eligibleProvider: boolean;
  eligibleCrew: boolean;
  eligibleLead: boolean;
  noConflictingCommitment: boolean;
  permitClearance: boolean;
  unitAccessClearance: boolean;
  materialReady: boolean;
  assignmentCurrent: boolean;
  independentBmClearance: boolean;
};

export type HandymanDispatchReadinessReport = {
  executionScopeId: string;
  ready: boolean;
  checks: HandymanDispatchReadinessCheck;
  failures: string[];
  appointmentId: string | null;
  assignmentId: string | null;
  assignmentReadiness: 'UNASSIGNED' | 'PLANNED' | 'DISPATCH_READY';
  bmClearance: HandymanBmClearanceAssessment;
};

export type ReleaseHandymanDispatchInput = {
  executionScopeId: string;
  appointmentId?: string | null;
};
