import { resolveBuildingsForUser } from '../building-assignments';
import { buildingAccessDeniedError } from './context-access.errors';

/**
 * BE-02G — Context Access Service.
 *
 * Backend authority for Building-scoped data isolation. Reuses the BE-02F
 * resolver (`resolveBuildingsForUser`) as the single source of accessible
 * Building contexts; never duplicates the assignment query.
 *
 * Isolation rule: an authenticated User may access a Building only when it is
 * returned by `resolveBuildingsForUser` (i.e. ACTIVE assignment + ACTIVE
 * Building). No implicit sibling, Property, or same-Client expansion.
 */

/**
 * Resolves the set of Building IDs the User can currently access.
 * This is the reusable query-scope foundation future scoped repositories can
 * use via `WHERE building_id IN (...)` instead of filtering after a global
 * fetch.
 */
export async function getAccessibleBuildingIds(userId: string): Promise<string[]> {
  const contexts = await resolveBuildingsForUser(userId);
  return contexts.map((context) => context.building.id);
}

export async function canAccessBuilding(
  userId: string,
  buildingId: string,
): Promise<boolean> {
  const ids = await getAccessibleBuildingIds(userId);
  return ids.includes(buildingId);
}

/**
 * Throws `BUILDING_ACCESS_DENIED` when the User has no explicit ACTIVE
 * assignment to the requested Building. For a valid authenticated context,
 * an unknown/nonexistent Building is never in the accessible set, so it is
 * also denied (avoiding existence leaks).
 */
export async function assertBuildingAccess(
  userId: string,
  buildingId: string,
): Promise<void> {
  if (!(await canAccessBuilding(userId, buildingId))) {
    throw buildingAccessDeniedError();
  }
}

/** True when the User has explicit access to a Building under this Property. */
export async function canAccessProperty(
  userId: string,
  propertyId: string,
): Promise<boolean> {
  const contexts = await resolveBuildingsForUser(userId);
  return contexts.some((context) => context.property?.id === propertyId);
}

/** True when the User has explicit access to a Building under this Client. */
export async function canAccessClient(
  userId: string,
  clientId: string,
): Promise<boolean> {
  const contexts = await resolveBuildingsForUser(userId);
  return contexts.some((context) => context.client?.id === clientId);
}

/**
 * Resolves the set of Client IDs reachable through the User's explicit ACTIVE
 * Building assignments. This is the query-scope foundation for legacy
 * operational tables that are Client-scoped only (no building_id column).
 * Derived from the same BE-02F resolver as `getAccessibleBuildingIds`, so the
 * two sets can never disagree about the User's reach.
 */
export async function getAccessibleClientIds(userId: string): Promise<string[]> {
  const contexts = await resolveBuildingsForUser(userId);
  const clientIds = new Set<string>();
  for (const context of contexts) {
    if (context.client?.id) {
      clientIds.add(context.client.id);
    }
  }
  return [...clientIds];
}

/**
 * A resource that carries BOTH a clientId and a buildingId is a
 * building-scoped resource (e.g. `handyman_service_requests.building_id
 * UUID NOT NULL`). Authority over such a resource is the actor's explicit
 * ACTIVE assignment to the resource's exact Building, resolving under the
 * resource's Client.
 */
export type BuildingScopedResourceRef = {
  clientId: string;
  buildingId: string;
};

/**
 * BE-02G — Building-scoped resource guard (predicate form).
 *
 * A single Building assignment under a Client is NOT client-wide privilege
 * ("No same-Client shortcut"): `canAccessClient` only proves the Client is
 * reachable through some accessible Building and is reserved for legacy
 * Client-scoped-only tables (no building_id column). No existing role/scope
 * contract grants any local User client-wide data access — roles carry
 * RBAC capabilities only, there is no user↔client assignment, and even the
 * PLATFORM_ADMIN operational exception stays inside its assigned Buildings —
 * so this guard admits exactly the explicit per-Building assignment and
 * invents no client-wide bypass.
 */
export async function canAccessBuildingScopedResource(
  userId: string,
  resource: BuildingScopedResourceRef,
): Promise<boolean> {
  const contexts = await resolveBuildingsForUser(userId);
  return contexts.some(
    (context) =>
      context.building.id === resource.buildingId &&
      context.client?.id === resource.clientId,
  );
}

/**
 * BE-02G — Building-scoped resource guard (assertion form).
 *
 * Throws `BUILDING_ACCESS_DENIED` (403) unless the User holds an explicit
 * ACTIVE assignment to the resource's exact Building under the resource's
 * Client. A valid but inaccessible Building is denied exactly like an
 * unknown one, so no existence is leaked.
 */
export async function assertBuildingScopedResourceAccess(
  userId: string,
  resource: BuildingScopedResourceRef,
): Promise<void> {
  if (!(await canAccessBuildingScopedResource(userId, resource))) {
    throw buildingAccessDeniedError();
  }
}

export const contextAccessService = {
  assertBuildingAccess,
  assertBuildingScopedResourceAccess,
  canAccessBuilding,
  canAccessBuildingScopedResource,
  canAccessClient,
  canAccessProperty,
  getAccessibleBuildingIds,
  getAccessibleClientIds,
};
