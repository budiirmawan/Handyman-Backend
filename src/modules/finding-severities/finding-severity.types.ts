export const FINDING_SEVERITY_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type FindingSeverityStatus = (typeof FINDING_SEVERITY_STATUSES)[number];
export function isFindingSeverityStatus(value: unknown): value is FindingSeverityStatus {
  return typeof value === 'string' && (FINDING_SEVERITY_STATUSES as readonly string[]).includes(value);
}
export type FindingSeverityRecord = {
  id: string;
  clientId: string;
  code: string;
  name: string;
  rank: number;
  description: string | null;
  status: FindingSeverityStatus;
  createdAt: Date;
  updatedAt: Date;
};
export type PublicFindingSeverity = Omit<FindingSeverityRecord, 'createdAt' | 'updatedAt'> & { createdAt: string; updatedAt: string };
export type CreateFindingSeverityInput = {
  clientId: string;
  code: string;
  name: string;
  rank: number;
  description?: string;
  status?: FindingSeverityStatus;
};
export type NewFindingSeverity = {
  clientId: string;
  code: string;
  name: string;
  rank: number;
  description: string | null;
  status: FindingSeverityStatus;
};
export type UpdateFindingSeverityInput = {
  name?: string;
  rank?: number;
  description?: string | null;
  status?: FindingSeverityStatus;
};
export type UpdateFindingSeverityStatusInput = { status: FindingSeverityStatus };
