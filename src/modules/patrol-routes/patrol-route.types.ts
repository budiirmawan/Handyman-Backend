/**
 * BE-12B — Patrol Route domain types.
 *
 * A Patrol Route is an ordered, named Security patrol definition anchored
 * to one Building. It may optionally bind to a starting BE-12A Security
 * Post (which must belong to the same Building). A Patrol Route is
 * operational context only — no scheduling, execution, checklist, or
 * finding semantics belong here.
 */
export const PATROL_ROUTE_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type PatrolRouteStatus = (typeof PATROL_ROUTE_STATUSES)[number];

export function isPatrolRouteStatus(
  value: unknown,
): value is PatrolRouteStatus {
  return (
    typeof value === 'string' &&
    (PATROL_ROUTE_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type PatrolRouteRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  startSecurityPostId: string | null;
  code: string;
  name: string;
  description: string | null;
  status: PatrolRouteStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Raw database row (snake_case columns) for cross-module read access. */
export type PatrolRouteRow = {
  id: string;
  client_id: string;
  building_id: string;
  start_security_post_id: string | null;
  code: string;
  name: string;
  description: string | null;
  status: PatrolRouteStatus;
  created_at: Date;
  updated_at: Date;
};

/** Safe public representation exposed through the API. */
export type PublicPatrolRoute = {
  id: string;
  clientId: string;
  buildingId: string;
  startSecurityPostId: string | null;
  code: string;
  name: string;
  description: string | null;
  status: PatrolRouteStatus;
  createdAt: string;
  updatedAt: string;
};

export type CreatePatrolRouteInput = {
  buildingId: string;
  startSecurityPostId?: string | null;
  code: string;
  name: string;
  description?: string | null;
  status?: PatrolRouteStatus;
};

export type UpdatePatrolRouteInput = {
  startSecurityPostId?: string | null;
  name?: string;
  description?: string | null;
  status?: PatrolRouteStatus;
};

export type PatrolRouteFilter = {
  status?: PatrolRouteStatus;
  startSecurityPostId?: string;
};

/* ------------------------------------------------------------------ */
/*  Patrol Route Point                                                 */
/* ------------------------------------------------------------------ */

export const PATROL_ROUTE_POINT_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type PatrolRoutePointStatus =
  (typeof PATROL_ROUTE_POINT_STATUSES)[number];

export function isPatrolRoutePointStatus(
  value: unknown,
): value is PatrolRoutePointStatus {
  return (
    typeof value === 'string' &&
    (PATROL_ROUTE_POINT_STATUSES as readonly string[]).includes(value)
  );
}

export type PatrolRoutePointRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  patrolRouteId: string;
  floorId: string | null;
  areaId: string | null;
  roomId: string | null;
  spaceId: string | null;
  functionalLocationId: string | null;
  sequence: number;
  notes: string | null;
  status: PatrolRoutePointStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicPatrolRoutePoint = {
  id: string;
  clientId: string;
  buildingId: string;
  patrolRouteId: string;
  floorId: string | null;
  areaId: string | null;
  roomId: string | null;
  spaceId: string | null;
  functionalLocationId: string | null;
  sequence: number;
  notes: string | null;
  status: PatrolRoutePointStatus;
  createdAt: string;
  updatedAt: string;
};

export type CreatePatrolRoutePointInput = {
  patrolRouteId: string;
  floorId?: string | null;
  areaId?: string | null;
  roomId?: string | null;
  spaceId?: string | null;
  functionalLocationId?: string | null;
  sequence: number;
  notes?: string | null;
  status?: PatrolRoutePointStatus;
};

export type UpdatePatrolRoutePointInput = {
  floorId?: string | null;
  areaId?: string | null;
  roomId?: string | null;
  spaceId?: string | null;
  functionalLocationId?: string | null;
  sequence?: number;
  notes?: string | null;
  status?: PatrolRoutePointStatus;
};
