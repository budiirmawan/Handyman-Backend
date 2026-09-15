/**
 * BE-03B — Team domain types.
 *
 * A Team is an operational / organizational grouping scoped to a single
 * Department. It is NOT a Role, Permission, or workforce membership (those
 * belong to BE-01 and BE-03C respectively).
 */

export const TEAM_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type TeamStatus = (typeof TEAM_STATUSES)[number];

export function isTeamStatus(value: unknown): value is TeamStatus {
  return (
    typeof value === 'string' &&
    (TEAM_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type TeamRecord = {
  id: string;
  departmentId: string;
  code: string;
  name: string;
  description: string | null;
  status: TeamStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Public API representation. */
export type PublicTeam = {
  id: string;
  departmentId: string;
  code: string;
  name: string;
  description: string | null;
  status: TeamStatus;
};

/** Input supplied by the API consumer. */
export type CreateTeamInput = {
  departmentId: string;
  code: string;
  name: string;
  description?: string;
  status?: TeamStatus;
};

/** Fully-resolved data ready for database insertion. */
export type NewTeam = {
  departmentId: string;
  code: string;
  name: string;
  description: string | null;
  status: TeamStatus;
};

/** Partial update input. */
export type UpdateTeamInput = {
  name?: string;
  description?: string;
  status?: TeamStatus;
};
