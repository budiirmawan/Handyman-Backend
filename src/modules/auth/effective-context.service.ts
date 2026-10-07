import { resolveBuildingsForUser } from '../building-assignments';
import { entitlementService } from '../entitlements';
import { organizationRepository } from '../organizations/organization.repository';
import { permissionService } from '../permissions';
import { roleRepository } from '../roles';
import { subscriptionRepository } from '../subscriptions';
import { toPublicUser, userRepository } from '../users';
import { workforceRepository } from '../workforce/workforce.repository';
import { invalidSessionError } from './session.errors';
import type {
  EffectiveClientContext,
  EffectiveEntitlement,
  EffectiveRole,
  EffectiveScope,
  EffectiveUserContext,
  EffectivePropertyContext,
  EffectiveWorkforceProfile,
} from './effective-context.types';

/**
 * Assembles the authoritative Effective User Context for an authenticated
 * user.
 *
 * Single source of truth:
 *  - BE-01 roles/permissions via the BE-01 resolver (so `/auth/me` matches RBAC).
 *  - Reachable commercial context (Client → Property → Building) via the BE-02F
 *    Building resolver — the SAME source BE-02G data isolation uses, so no
 *    Building is ever exposed that isolation would deny.
 *  - BE-25B mobile scope (accessible Building/Client ids) and the linked
 *    Workforce Profile(s), derived from the same resolvers — no separate
 *    mobile identity/context engine.
 *  - Effective Module Entitlements via the BE-02C authoritative resolver.
 */
export async function getEffectiveUserContext(
  userId: string,
): Promise<EffectiveUserContext> {
  const userRecord = await userRepository.findById(userId);
  if (!userRecord) {
    throw invalidSessionError();
  }

  const roleRecords = await roleRepository.listActiveRolesForUser(userId);
  const permissions = await permissionService.resolvePermissionsForUser(userId);

  const roles: EffectiveRole[] = roleRecords.map((role) => ({
    id: role.id,
    code: role.code,
    name: role.name,
  }));

  const buildingContexts = await resolveBuildingsForUser(userId);
  const clients = buildClientHierarchy(buildingContexts);
  const scope = buildEffectiveScope(buildingContexts);
  const workforce = await resolveLinkedWorkforce(userId, scope);
  const entitlements = await resolveEffectiveEntitlementsForContext(buildingContexts);

  return {
    user: toPublicUser(userRecord),
    access: {
      roles,
      permissions,
    },
    context: {
      clients,
      workforce,
    },
    scope,
    entitlements,
  };
}

/**
 * BE-25B — Flat accessible data scope derived from the same BE-02F resolver
 * BE-02G isolation uses. `buildingIds` covers every accessible Building;
 * `clientIds` covers the Clients reachable through those Buildings.
 */
function buildEffectiveScope(
  contexts: Awaited<ReturnType<typeof resolveBuildingsForUser>>,
): EffectiveScope {
  const buildingIds = new Set<string>();
  const clientIds = new Set<string>();
  for (const context of contexts) {
    buildingIds.add(context.building.id);
    if (context.client) {
      clientIds.add(context.client.id);
    }
  }
  return {
    buildingIds: [...buildingIds].sort(),
    clientIds: [...clientIds].sort(),
  };
}

/**
 * BE-25B — Resolves the Workforce Profile(s) linked to the authenticated user
 * (identity only; Organization/Team/Position dimensions stay deferred). A
 * profile is exposed only when its Client is inside the accessible scope, so
 * the context never leaks cross-Client identity data.
 */
async function resolveLinkedWorkforce(
  userId: string,
  scope: EffectiveScope,
): Promise<EffectiveWorkforceProfile[]> {
  const profile = await workforceRepository.findByUserId(userId);
  if (!profile) {
    return [];
  }

  const organization = await organizationRepository.findById(
    profile.organizationId,
  );
  if (!organization || !scope.clientIds.includes(organization.clientId)) {
    return [];
  }

  return [
    {
      id: profile.id,
      clientId: organization.clientId,
      employeeCode: profile.employeeCode,
      fullName: profile.fullName,
      workforceType: profile.workforceType,
      status: profile.status,
    },
  ];
}

/**
 * Builds a deduplicated Client → Property → Building hierarchy from the User's
 * accessible Building contexts. Only reachable hierarchy is returned — never
 * the global commercial tree. No sibling Buildings are inferred.
 */
function buildClientHierarchy(
  contexts: Awaited<ReturnType<typeof resolveBuildingsForUser>>,
): EffectiveClientContext[] {
  const clientsById = new Map<string, EffectiveClientContext>();
  const propertiesByClient = new Map<string, Map<string, EffectivePropertyContext>>();

  for (const context of contexts) {
    if (!context.client || !context.property) {
      continue;
    }

    const clientKey = context.client.id;
    let client = clientsById.get(clientKey);
    if (!client) {
      client = {
        id: context.client.id,
        code: context.client.code,
        name: context.client.name,
        properties: [],
      };
      clientsById.set(clientKey, client);
      propertiesByClient.set(clientKey, new Map());
    }

    const props = propertiesByClient.get(clientKey)!;
    let property = props.get(context.property.id);
    if (!property) {
      property = {
        id: context.property.id,
        code: context.property.code,
        name: context.property.name,
        buildings: [],
      };
      props.set(context.property.id, property);
      client.properties.push(property);
    }

    const alreadyPresent = property.buildings.some(
      (building) => building.id === context.building.id,
    );
    if (!alreadyPresent) {
      property.buildings.push({
        id: context.building.id,
        code: context.building.code,
        name: context.building.name,
      });
    }
  }

  return [...clientsById.values()].sort((a, b) => a.code.localeCompare(b.code));
}

/**
 * Resolves effective Module Entitlements across all Clients reachable through
 * the User's Building assignments, reusing the BE-02C authoritative resolver
 * per Subscription. Deduplicated by module code; status is always ACTIVE for
 * effective entitlements (BE-02C only returns effective modules).
 */
async function resolveEffectiveEntitlementsForContext(
  contexts: Awaited<ReturnType<typeof resolveBuildingsForUser>>,
): Promise<EffectiveEntitlement[]> {
  const clientIds = new Set<string>();
  for (const context of contexts) {
    if (context.client) {
      clientIds.add(context.client.id);
    }
  }

  const modulesByCode = new Map<string, string>();

  for (const clientId of clientIds) {
    const subscriptions = await subscriptionRepository.findByClientId(clientId);
    for (const subscription of subscriptions) {
      const effective =
        await entitlementService.resolveEffectiveEntitlements(subscription.id);
      for (const module of effective) {
        modulesByCode.set(module.code, module.code);
      }
    }
  }

  const entitlements: EffectiveEntitlement[] = [];
  for (const code of [...modulesByCode.keys()].sort()) {
    entitlements.push({ moduleCode: code, status: 'ACTIVE' });
  }

  return entitlements;
}

export const effectiveContextService = {
  getEffectiveUserContext,
};
