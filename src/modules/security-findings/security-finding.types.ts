/**
 * BE-12H — Security Finding Binding domain types.
 *
 * The Security context link for a BE-09 Finding. The Finding itself
 * (lifecycle, classification/severity, source binding, assignment,
 * verification, rework, closure, available actions) lives entirely in
 * BE-09. This module only records the Security operational context
 * (which Security source produced it + the related Security Post /
 * Patrol Route) and reads BE-09 state back.
 *
 * The Security source types are distinct from BE-09's `findings.source_type`
 * enum: BE-09 knows WORK_ORDER / CHECKLIST_EXECUTION / FORM_INSTANCE;
 * the Security binding knows the Security operational sources listed
 * below. The two enums are intentionally separate.
 */

import type { FindingAction } from '../findings';
import type { PublicFinding } from '../findings/finding.types';

export const SECURITY_FINDING_SOURCE_TYPES = [
  'PATROL_EXECUTION',
  'PATROL_CHECKLIST',
  'SECURITY_DAILY_ACTIVITY',
  'SHIFT_HANDOVER',
  'SECURITY_POST',
] as const;

export type SecurityFindingSourceType =
  (typeof SECURITY_FINDING_SOURCE_TYPES)[number];

export function isSecurityFindingSourceType(
  value: unknown,
): value is SecurityFindingSourceType {
  return (
    typeof value === 'string' &&
    (SECURITY_FINDING_SOURCE_TYPES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type SecurityFindingLinkRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  findingId: string;
  startSecurityPostId: string | null;
  patrolRouteId: string | null;
  sourceType: SecurityFindingSourceType;
  sourceId: string;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * The resolved Security Finding context: the BE-09 Finding (authoritative)
 * plus the Security context and BE-09 backend-authoritative available
 * actions. Nothing here re-derives Finding workflow state.
 */
export type PublicSecurityFinding = {
  id: string;
  clientId: string;
  buildingId: string;
  findingId: string;
  startSecurityPostId: string | null;
  patrolRouteId: string | null;
  sourceType: SecurityFindingSourceType;
  sourceId: string;
  createdAt: string;
  finding: PublicFinding;
  /** BE-09 backend-authoritative available actions (never re-derived). */
  availableActions: FindingAction[];
};

export type CreateSecurityFindingInput = {
  buildingId: string;
  sourceType: SecurityFindingSourceType;
  sourceId: string;
  startSecurityPostId?: string | null;
  patrolRouteId?: string | null;
  title: string;
  description?: string;
  classificationId?: string;
  severityId?: string;
  assigneeType?: 'WORKFORCE' | 'TEAM' | 'VENDOR' | 'VENDOR_WORKFORCE';
  workforceProfileId?: string;
  teamId?: string;
  vendorId?: string;
  createdByUserId: string;
};

export type SecurityFindingListFilters = {
  buildingId?: string;
  startSecurityPostId?: string;
  patrolRouteId?: string;
  sourceType?: SecurityFindingSourceType;
  status?: string;
};
