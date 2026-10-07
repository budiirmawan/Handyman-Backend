/**
 * BE-02C — Module catalogue domain types.
 *
 * A Module is a commercially entitleable Asentra capability (e.g. ENGINEERING,
 * HOUSEKEEPING). The catalogue is authoritative; module codes are never
 * hardcoded into authorization logic. Module does NOT answer "what may a User
 * do" (that is BE-01 Permission).
 */
export const MODULE_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type ModuleStatus = (typeof MODULE_STATUSES)[number];

export function isModuleStatus(value: unknown): value is ModuleStatus {
  return (
    typeof value === 'string' &&
    (MODULE_STATUSES as readonly string[]).includes(value)
  );
}

export type ModuleRecord = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: ModuleStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicModule = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: ModuleStatus;
};

export type CreateModuleInput = {
  code: string;
  name: string;
  description?: string;
  status?: ModuleStatus;
};

/** Fully-resolved module data ready for persistence. */
export type NewModule = {
  code: string;
  name: string;
  description: string | null;
  status: ModuleStatus;
};

export type UpdateModuleStatusInput = {
  status: ModuleStatus;
};
