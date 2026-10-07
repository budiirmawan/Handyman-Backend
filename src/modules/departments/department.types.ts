/**
 * BE-03A — Department domain types.
 *
 * A Department is an organizational unit scoped to a single Organization.
 * It is NOT a Property, Building, Subscription, Role, or Permission (those
 * domains live in BE-01/BE-02).
 */

export const DEPARTMENT_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type DepartmentStatus = (typeof DEPARTMENT_STATUSES)[number];

export function isDepartmentStatus(value: unknown): value is DepartmentStatus {
  return (
    typeof value === 'string' &&
    (DEPARTMENT_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type DepartmentRecord = {
  id: string;
  organizationId: string;
  code: string;
  name: string;
  description: string | null;
  status: DepartmentStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Public API representation. */
export type PublicDepartment = {
  id: string;
  organizationId: string;
  code: string;
  name: string;
  description: string | null;
  status: DepartmentStatus;
};

/** Input supplied by the API consumer. */
export type CreateDepartmentInput = {
  organizationId: string;
  code: string;
  name: string;
  description?: string;
  status?: DepartmentStatus;
};

/** Fully-resolved data ready for database insertion. */
export type NewDepartment = {
  organizationId: string;
  code: string;
  name: string;
  description: string | null;
  status: DepartmentStatus;
};

/** Partial update input. */
export type UpdateDepartmentInput = {
  name?: string;
  description?: string;
  status?: DepartmentStatus;
};
