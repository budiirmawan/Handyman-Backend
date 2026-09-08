import type { FindingAction } from '../findings';
import type { FindingSourceType, PublicFinding } from '../findings/finding.types';

/**
 * BE-10H — Engineering Finding Binding domain types.
 *
 * The minimal Engineering context for a BE-09 Finding. The Finding itself
 * lives exclusively in BE-09's `findings` table; this module only records
 * which Asset / Functional Location, Engineering operation type, and
 * Engineering source execution/binding produced it, and reads BE-09 state
 * back.
 */

export const ENGINEERING_FINDING_OPERATION_TYPES = [
  'EQUIPMENT_INSPECTION',
  'METER_READING',
  'EQUIPMENT_LOG_SHEET',
  'ENGINEERING_CHECKLIST',
  'BREAKDOWN',
  'MAINTENANCE',
] as const;

export type EngineeringFindingOperationType =
  (typeof ENGINEERING_FINDING_OPERATION_TYPES)[number];

export function isEngineeringFindingOperationType(
  value: unknown,
): value is EngineeringFindingOperationType {
  return (
    typeof value === 'string' &&
    (ENGINEERING_FINDING_OPERATION_TYPES as readonly string[]).includes(value)
  );
}

/** Full link record. */
export type EngineeringFindingLinkRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  findingId: string;
  assetId: string | null;
  functionalLocationId: string | null;
  operationType: EngineeringFindingOperationType;
  sourceType: FindingSourceType | null;
  sourceId: string | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * The resolved Engineering Finding context: the BE-09 Finding (authoritative)
 * plus the Engineering context and BE-09 backend-authoritative available
 * actions. Nothing here re-derives Finding workflow state.
 */
export type PublicEngineeringFinding = {
  id: string;
  clientId: string;
  buildingId: string;
  findingId: string;
  assetId: string | null;
  functionalLocationId: string | null;
  operationType: EngineeringFindingOperationType;
  sourceType: FindingSourceType | null;
  sourceId: string | null;
  createdAt: string;
  finding: PublicFinding;
  /** BE-09 backend-authoritative available actions (never re-derived). */
  availableActions: FindingAction[];
};

export type CreateEngineeringFindingInput = {
  buildingId: string;
  operationType: EngineeringFindingOperationType;
  /** Link an existing BE-09 Finding instead of creating a new one. */
  findingId?: string;
  /** Create mode: */
  title?: string;
  description?: string;
  assetId?: string | null;
  functionalLocationId?: string | null;
  sourceType?: FindingSourceType;
  sourceId?: string;
  classificationId?: string;
  severityId?: string;
  assigneeType?: 'WORKFORCE' | 'TEAM' | 'VENDOR' | 'VENDOR_WORKFORCE';
  workforceProfileId?: string;
  teamId?: string;
  vendorId?: string;
  createdByUserId: string;
};

export type EngineeringFindingListFilters = {
  buildingId?: string;
  assetId?: string;
  sourceType?: FindingSourceType;
  status?: string;
};
