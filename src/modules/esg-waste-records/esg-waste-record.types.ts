/**
 * CR-BE-ESG-01 PART 02 — Waste Operational Records domain types.
 *
 * Building-scoped operational waste measurement (0327). Client ownership
 * derived via Building → Property → Client, never from caller.
 *
 * This module owns waste records only. It does NOT own metric values (PART 03),
 * aggregation/recycling KPI, baselines/targets (PART 04), verification workflow,
 * evidence bindings, environmental records, emissions, or reporting (PART 05).
 */

export const ESG_WASTE_TYPES = [
  'GENERAL',
  'ORGANIC',
  'RECYCLABLE',
  'HAZARDOUS',
  'E_WASTE',
  'CONSTRUCTION',
  'OTHER',
] as const;
export type EsgWasteType = (typeof ESG_WASTE_TYPES)[number];

export function isEsgWasteType(value: unknown): value is EsgWasteType {
  return (
    typeof value === 'string' &&
    (ESG_WASTE_TYPES as readonly string[]).includes(value)
  );
}

export const ESG_DISPOSAL_METHODS = [
  'LANDFILL',
  'RECYCLED',
  'COMPOSTED',
  'INCINERATED',
  'REUSED',
  'DONATED',
  'OTHER',
] as const;
export type EsgDisposalMethod = (typeof ESG_DISPOSAL_METHODS)[number];

export function isEsgDisposalMethod(value: unknown): value is EsgDisposalMethod {
  return (
    typeof value === 'string' &&
    (ESG_DISPOSAL_METHODS as readonly string[]).includes(value)
  );
}

export const ESG_WASTE_SOURCE_TYPES = ['MANUAL', 'IMPORT', 'SYSTEM'] as const;
export type EsgWasteSourceType = (typeof ESG_WASTE_SOURCE_TYPES)[number];

export function isEsgWasteSourceType(value: unknown): value is EsgWasteSourceType {
  return (
    typeof value === 'string' &&
    (ESG_WASTE_SOURCE_TYPES as readonly string[]).includes(value)
  );
}

export const ESG_WASTE_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type EsgWasteStatus = (typeof ESG_WASTE_STATUSES)[number];

export function isEsgWasteStatus(value: unknown): value is EsgWasteStatus {
  return (
    typeof value === 'string' &&
    (ESG_WASTE_STATUSES as readonly string[]).includes(value)
  );
}

export type EsgWasteRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  functionalLocationId: string | null;
  wasteType: EsgWasteType;
  disposalMethod: EsgDisposalMethod;
  quantity: string; // raw NUMERIC string from PG to preserve precision
  uomId: string;
  periodDate: Date;
  sourceType: EsgWasteSourceType;
  vendorId: string | null;
  notes: string | null;
  status: EsgWasteStatus;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicEsgWasteRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  functionalLocationId: string | null;
  wasteType: EsgWasteType;
  disposalMethod: EsgDisposalMethod;
  quantity: number;
  uomId: string;
  periodDate: string; // YYYY-MM-DD
  sourceType: EsgWasteSourceType;
  vendorId: string | null;
  notes: string | null;
  status: EsgWasteStatus;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  uom?: { id: string; code: string; name: string; symbol: string } | null;
  vendor?: { id: string; code: string; name: string } | null;
};

export type CreateEsgWasteRecordInput = {
  buildingId: string;
  functionalLocationId?: string | null;
  wasteType: EsgWasteType;
  disposalMethod: EsgDisposalMethod;
  quantity: number;
  uomId: string;
  periodDate: string; // YYYY-MM-DD
  sourceType?: EsgWasteSourceType;
  vendorId?: string | null;
  notes?: string | null;
};

export type NewEsgWasteRecord = {
  clientId: string;
  buildingId: string;
  functionalLocationId: string | null;
  wasteType: EsgWasteType;
  disposalMethod: EsgDisposalMethod;
  quantity: number;
  uomId: string;
  periodDate: Date;
  sourceType: EsgWasteSourceType;
  vendorId: string | null;
  notes: string | null;
  createdByUserId: string;
};

export type UpdateEsgWasteRecordInput = {
  functionalLocationId?: string | null;
  wasteType?: EsgWasteType;
  disposalMethod?: EsgDisposalMethod;
  quantity?: number;
  uomId?: string;
  periodDate?: string;
  sourceType?: EsgWasteSourceType;
  vendorId?: string | null;
  notes?: string | null;
};

export type EsgWasteRecordFilters = {
  clientId?: string;
  buildingId?: string;
  functionalLocationId?: string;
  wasteType?: EsgWasteType;
  disposalMethod?: EsgDisposalMethod;
  sourceType?: EsgWasteSourceType;
  status?: EsgWasteStatus;
  uomId?: string;
  vendorId?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
};

/**
 * Bounded actor-scoped read for Reporting and other multi-Building consumers.
 * `periodDate` is owned by the waste record domain and is bounded inclusively.
 */
export type EsgWasteRecordReadRequest = {
  buildingIds: readonly string[];
  periodStart: string;
  periodEnd: string;
};
