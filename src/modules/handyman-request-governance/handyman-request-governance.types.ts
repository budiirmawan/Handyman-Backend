/**
 * CR-HM-BE-03 RUN 1 — Handyman Request governance types.
 *
 * Triage history, governed request↔service selection, and inspection
 * aggregates. All rows preserve superseded/completed history — nothing is
 * overwritten or hard-deleted. No quotation, pricing, approval, or
 * assignment vocabulary exists in this run.
 */

export const HANDYMAN_TRIAGE_PATHS = ['QUOTATION', 'INSPECTION'] as const;
export type HandymanTriagePath = (typeof HANDYMAN_TRIAGE_PATHS)[number];

export const HANDYMAN_GOVERNANCE_ROW_STATUSES = ['ACTIVE', 'SUPERSEDED'] as const;
export type HandymanGovernanceRowStatus =
  (typeof HANDYMAN_GOVERNANCE_ROW_STATUSES)[number];

export const HANDYMAN_SERVICE_SELECTION_SOURCES = ['TRIAGE', 'INSPECTION'] as const;
export type HandymanServiceSelectionSource =
  (typeof HANDYMAN_SERVICE_SELECTION_SOURCES)[number];

export const HANDYMAN_INSPECTION_STATUSES = ['OPEN', 'COMPLETED', 'CANCELLED'] as const;
export type HandymanInspectionStatus = (typeof HANDYMAN_INSPECTION_STATUSES)[number];

/** Persisted row shapes returned by the repositories. */
export type HandymanRequestTriageRecord = {
  id: string;
  requestId: string;
  clientId: string;
  buildingId: string;
  path: HandymanTriagePath;
  notes: string | null;
  status: HandymanGovernanceRowStatus;
  triagedByUserId: string;
  triagedAt: Date;
  supersededAt: Date | null;
  supersededByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type HandymanRequestServiceRecord = {
  id: string;
  requestId: string;
  clientId: string;
  buildingId: string;
  serviceCatalogId: string;
  source: HandymanServiceSelectionSource;
  status: HandymanGovernanceRowStatus;
  selectedByUserId: string;
  selectedAt: Date;
  supersededAt: Date | null;
  supersededByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type HandymanInspectionRecord = {
  id: string;
  requestId: string;
  clientId: string;
  buildingId: string;
  spaceId: string;
  status: HandymanInspectionStatus;
  diagnosis: string | null;
  scopeNotes: string | null;
  checklistExecutionId: string | null;
  openedByUserId: string;
  openedAt: Date;
  inspectedByUserId: string | null;
  inspectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representations exposed to callers (ISO timestamps). */
export type PublicHandymanRequestTriage = {
  id: string;
  requestId: string;
  clientId: string;
  buildingId: string;
  path: HandymanTriagePath;
  notes: string | null;
  status: HandymanGovernanceRowStatus;
  triagedByUserId: string;
  triagedAt: string;
  supersededAt: string | null;
  supersededByUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PublicHandymanRequestService = {
  id: string;
  requestId: string;
  clientId: string;
  buildingId: string;
  serviceCatalogId: string;
  source: HandymanServiceSelectionSource;
  status: HandymanGovernanceRowStatus;
  selectedByUserId: string;
  selectedAt: string;
  supersededAt: string | null;
  supersededByUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PublicHandymanInspection = {
  id: string;
  requestId: string;
  clientId: string;
  buildingId: string;
  spaceId: string;
  status: HandymanInspectionStatus;
  diagnosis: string | null;
  scopeNotes: string | null;
  checklistExecutionId: string | null;
  openedByUserId: string;
  openedAt: string;
  inspectedByUserId: string | null;
  inspectedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Command inputs. Actor identity is always a separate parameter — never
 * carried in the input shape (the CR-HM-BE-02 convention). */
export type TriageHandymanRequestInput = {
  requestId: string;
  path: HandymanTriagePath;
  notes?: string | null;
};

export type SelectHandymanRequestServiceInput = {
  requestId: string;
  serviceCatalogId: string;
  source: HandymanServiceSelectionSource;
};

export type HandymanRequestServiceFilters = {
  status?: HandymanGovernanceRowStatus;
};

export type OpenHandymanInspectionInput = {
  requestId: string;
  checklistExecutionId?: string | null;
};

export type CompleteHandymanInspectionInput = {
  diagnosis: string;
  scopeNotes: string;
};
