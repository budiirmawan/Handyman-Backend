/**
 * BE-03B — Position domain types.
 *
 * A Position represents an organizational / job-function label scoped to a
 * single Organization. It is NOT a Role, Permission, or automatic authorization
 * — those belong to BE-01. Position creation must never alter RBAC.
 */

export const POSITION_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type PositionStatus = (typeof POSITION_STATUSES)[number];

export function isPositionStatus(value: unknown): value is PositionStatus {
  return (
    typeof value === 'string' &&
    (POSITION_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type PositionRecord = {
  id: string;
  organizationId: string;
  departmentId: string | null;
  code: string;
  name: string;
  description: string | null;
  status: PositionStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Public API representation. */
export type PublicPosition = {
  id: string;
  organizationId: string;
  departmentId: string | null;
  code: string;
  name: string;
  description: string | null;
  status: PositionStatus;
};

/** Input supplied by the API consumer. */
export type CreatePositionInput = {
  organizationId: string;
  departmentId?: string | null;
  code: string;
  name: string;
  description?: string;
  status?: PositionStatus;
};

/** Fully-resolved data ready for database insertion. */
export type NewPosition = {
  organizationId: string;
  departmentId: string | null;
  code: string;
  name: string;
  description: string | null;
  status: PositionStatus;
};

/** Partial update input. */
export type UpdatePositionInput = {
  name?: string;
  description?: string;
  status?: PositionStatus;
};
