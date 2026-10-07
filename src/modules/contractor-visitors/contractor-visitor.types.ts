/**
 * BE-13J — Contractor Visitor types.
 *
 * This is contractor-specific metadata bound to exactly one existing
 * BE-13 visit. Visitor identity and operational entry/exit remain owned
 * by the existing Visitor, Check-In / Check-Out and Visitor Pass modules.
 */

export const CONTRACTOR_VISITOR_STATUSES = [
  'REGISTERED',
  'CANCELLED',
] as const;

export type ContractorVisitorStatus =
  (typeof CONTRACTOR_VISITOR_STATUSES)[number];

export function isContractorVisitorStatus(
  value: unknown,
): value is ContractorVisitorStatus {
  return (
    typeof value === 'string' &&
    (CONTRACTOR_VISITOR_STATUSES as readonly string[]).includes(value)
  );
}

export type ContractorVisitorRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  visitorId: string;
  expectedVisitorId: string | null;
  walkInVisitId: string | null;
  contractorCompany: string;
  contractorPurpose: string;
  responsibleHostUserId: string | null;
  responsibleHostWorkforceId: string | null;
  responsibleHostName: string | null;
  functionalLocationId: string | null;
  workLocation: string | null;
  notes: string | null;
  status: ContractorVisitorStatus;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicContractorVisitor = Omit<
  ContractorVisitorRecord,
  'createdAt' | 'updatedAt'
> & {
  createdAt: string;
  updatedAt: string;
};

export type CreateContractorVisitorInput = {
  /** Optional consistency assertion; authoritative value comes from visit. */
  buildingId?: string;
  /** Optional consistency assertion; authoritative value comes from visit. */
  visitorId?: string;
  expectedVisitorId?: string;
  walkInVisitId?: string;
  contractorCompany: string;
  contractorPurpose: string;
  responsibleHostUserId?: string | null;
  responsibleHostWorkforceId?: string | null;
  responsibleHostName?: string | null;
  functionalLocationId?: string | null;
  workLocation?: string | null;
  notes?: string | null;
  createdByUserId: string;
};

export type UpdateContractorVisitorInput = {
  contractorCompany?: string;
  contractorPurpose?: string;
  responsibleHostUserId?: string | null;
  responsibleHostWorkforceId?: string | null;
  responsibleHostName?: string | null;
  functionalLocationId?: string | null;
  workLocation?: string | null;
  notes?: string | null;
  status?: ContractorVisitorStatus;
};

export type ContractorVisitorListFilters = {
  buildingId?: string;
  visitorId?: string;
  expectedVisitorId?: string;
  walkInVisitId?: string;
  status?: ContractorVisitorStatus;
  /** Case-insensitive company, purpose, PIC, work-location or notes search. */
  search?: string;
};
