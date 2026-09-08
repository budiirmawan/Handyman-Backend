/**
 * BE-02F — User / Building Assignment domain types.
 *
 * Establishes which Building contexts a User may operate within. A User may be
 * assigned to multiple Buildings. Assignment answers "WHERE may this User
 * operate" — it does NOT answer "WHAT may the User do" (BE-01 Permission) nor
 * "WHAT modules has the Client enabled" (BE-02C Entitlement).
 */
export const USER_BUILDING_ASSIGNMENT_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type UserBuildingAssignmentStatus =
  (typeof USER_BUILDING_ASSIGNMENT_STATUSES)[number];

export function isUserBuildingAssignmentStatus(
  value: unknown,
): value is UserBuildingAssignmentStatus {
  return (
    typeof value === 'string' &&
    (USER_BUILDING_ASSIGNMENT_STATUSES as readonly string[]).includes(value)
  );
}

export type UserBuildingAssignmentRecord = {
  id: string;
  userId: string;
  buildingId: string;
  status: UserBuildingAssignmentStatus;
  assignedByUserId: string | null;
  assignedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicUserBuildingAssignment = {
  id: string;
  userId: string;
  buildingId: string;
  status: UserBuildingAssignmentStatus;
  assignedByUserId: string | null;
  assignedAt: Date;
};

/** Fully-resolved assignment data ready for persistence. */
export type NewUserBuildingAssignment = {
  userId: string;
  buildingId: string;
  status: UserBuildingAssignmentStatus;
  assignedByUserId: string | null;
};

export type CreateUserBuildingAssignmentInput = {
  buildingId: string;
};

/** Safe building-context read model with authoritative hierarchy. */
export type UserBuildingContext = {
  id: string;
  status: UserBuildingAssignmentStatus;
  building: {
    id: string;
    code: string;
    name: string;
  };
  property: {
    id: string;
    code: string;
    name: string;
  } | null;
  client: {
    id: string;
    code: string;
    name: string;
  } | null;
};
