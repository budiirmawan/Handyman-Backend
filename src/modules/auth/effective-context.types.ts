import type { PublicUser } from '../users';

/**
 * BE-01I / BE-02H / BE-25B — Effective User Context types.
 *
 * The single authoritative context for the authenticated user. BE-01I supplies
 * identity, active roles, and effective permissions. BE-02H extends the same
 * authoritative context with reachable commercial context (Client → Property →
 * Building) and effective Module Entitlements. BE-25B adds the mobile-facing
 * data scope (accessible Building/Client ids, from the same BE-02G source) and
 * the authenticated user's linked Workforce Profile(s) — without creating a
 * separate mobile context engine.
 *
 * Deferred dimensions (Organization, Department, Team, Position, Operational
 * Data Scope, Available Workspace, Configuration) are deliberately absent here
 * — no fabricated data.
 */
export type EffectiveRole = {
  id: string;
  code: string;
  name: string;
};

export type EffectiveAccess = {
  roles: EffectiveRole[];
  permissions: string[];
};

export type EffectiveBuildingContext = {
  id: string;
  code: string;
  name: string;
};

export type EffectivePropertyContext = {
  id: string;
  code: string;
  name: string;
  buildings: EffectiveBuildingContext[];
};

export type EffectiveClientContext = {
  id: string;
  code: string;
  name: string;
  properties: EffectivePropertyContext[];
};

/** Effective commercial module availability (BE-02C authoritative). */
export type EffectiveEntitlement = {
  moduleCode: string;
  status: 'ACTIVE';
};

/**
 * BE-25B — Mobile data scope.
 *
 * The flat accessible scope the mobile client may use for filtering and
 * offline caching. It is derived from the SAME authoritative source as BE-02G
 * data isolation (the user's explicit Building assignments) — a Building or
 * Client is never listed here that isolation would deny.
 */
export type EffectiveScope = {
  buildingIds: string[];
  clientIds: string[];
};

/**
 * BE-25B — Workforce profile linked to the authenticated user.
 *
 * Identity-only: the profile the user acts under on mobile. Organization /
 * Department / Team / Position dimensions remain deferred and are not
 * expanded here. Only profiles belonging to an accessible Client are exposed.
 */
export type EffectiveWorkforceProfile = {
  id: string;
  clientId: string;
  employeeCode: string;
  fullName: string;
  workforceType: string;
  status: string;
};

export type EffectiveUserContext = {
  user: PublicUser;
  access: EffectiveAccess;
  context: {
    clients: EffectiveClientContext[];
    workforce: EffectiveWorkforceProfile[];
  };
  scope: EffectiveScope;
  entitlements: EffectiveEntitlement[];
};
