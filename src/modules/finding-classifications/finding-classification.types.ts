export const FINDING_CLASSIFICATION_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type FindingClassificationStatus =
  (typeof FINDING_CLASSIFICATION_STATUSES)[number];

export function isFindingClassificationStatus(
  value: unknown,
): value is FindingClassificationStatus {
  return typeof value === 'string' &&
    (FINDING_CLASSIFICATION_STATUSES as readonly string[]).includes(value);
}

export type FindingClassificationRecord = {
  id: string;
  clientId: string;
  code: string;
  name: string;
  description: string | null;
  status: FindingClassificationStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicFindingClassification = Omit<
  FindingClassificationRecord,
  'createdAt' | 'updatedAt'
> & { createdAt: string; updatedAt: string };

export type CreateFindingClassificationInput = {
  clientId: string;
  code: string;
  name: string;
  description?: string;
  status?: FindingClassificationStatus;
};

export type NewFindingClassification = {
  clientId: string;
  code: string;
  name: string;
  description: string | null;
  status: FindingClassificationStatus;
};

export type UpdateFindingClassificationInput = {
  name?: string;
  description?: string | null;
  status?: FindingClassificationStatus;
};

export type UpdateFindingClassificationStatusInput = {
  status: FindingClassificationStatus;
};
