import { effectiveContextService } from '../auth';
import type {
  EffectiveClientContext,
  EffectivePropertyContext,
} from '../auth';
import { buildingAccessDeniedError } from '../context-access';
import type {
  ManagementReadModelContract,
  ManagementReadScopeFilters,
  ManagementReadScopeMode,
  PublicManagementReadScopeContext,
  ResolvedManagementReadScope,
} from './management-read-scope.types';
import {
  managementDateToMode,
  managementReadPeriodRange,
} from './management-read-scope.validation';

/**
 * Resolves a BE-24 read scope from the SAME Client → Property → Building
 * hierarchy returned by the effective-user context. Selection can only narrow
 * that hierarchy; it can never infer a sibling Building or widen access.
 */
export async function resolveManagementReadScope(
  filters: ManagementReadScopeFilters,
  userId: string,
): Promise<ResolvedManagementReadScope> {
  const effective = await effectiveContextService.getEffectiveUserContext(userId);
  const accessibleClients = effective.context.clients;
  const accessibleBuildingIds = collectBuildingIds(accessibleClients);
  const requestedBuildingIds = filters.buildingId
    ? [filters.buildingId]
    : (filters.buildingIds ?? []);

  if (filters.clientId) {
    const client = accessibleClients.find((entry) => entry.id === filters.clientId);
    if (!client) {
      throw buildingAccessDeniedError();
    }
  }

  for (const buildingId of requestedBuildingIds) {
    if (!accessibleBuildingIds.has(buildingId)) {
      throw buildingAccessDeniedError();
    }
  }

  let selectedClients = accessibleClients;
  if (filters.clientId) {
    selectedClients = selectedClients.filter(
      (client) => client.id === filters.clientId,
    );
  }
  if (requestedBuildingIds.length > 0) {
    const selected = new Set(requestedBuildingIds);
    selectedClients = selectBuildings(selectedClients, selected);
  } else {
    selectedClients = cloneHierarchy(selectedClients);
  }

  // A Building that is accessible but does not belong to the requested Client
  // is a denied scope combination, not an empty successful result.
  if (
    requestedBuildingIds.length > 0 &&
    collectBuildingIds(selectedClients).size !== requestedBuildingIds.length
  ) {
    throw buildingAccessDeniedError();
  }

  selectedClients = sortHierarchy(selectedClients);
  const buildingIds = [...collectBuildingIds(selectedClients)].sort();
  const clientIds = selectedClients.map((client) => client.id).sort();
  const range = managementReadPeriodRange(filters);

  return {
    context: {
      scope: {
        mode: resolveMode(filters, requestedBuildingIds),
        clientId: filters.clientId ?? null,
        clientIds,
        buildingIds,
        clients: selectedClients,
      },
      period: {
        dateFrom: filters.dateFrom ?? null,
        dateTo: filters.dateTo ?? null,
        timeBasis: 'UTC',
        dateToMode: managementDateToMode(filters.dateTo),
      },
      filters: {
        clientId: filters.clientId ?? null,
        buildingId: filters.buildingId ?? null,
        buildingIds: filters.buildingIds ?? [],
      },
      asOf: new Date().toISOString(),
    },
    range,
  };
}

/** Public endpoint service: internal Date boundaries are not serialized. */
export async function getManagementReadScopeContext(
  filters: ManagementReadScopeFilters,
  userId: string,
): Promise<PublicManagementReadScopeContext> {
  return (await resolveManagementReadScope(filters, userId)).context;
}

/**
 * Common response builder for later BE-24 parts. It adds domain filters/data
 * around the already-authorized scope without touching any KPI calculation.
 */
export function createManagementReadModelContract<
  TData,
  TFilters extends Record<string, unknown> = Record<string, never>,
>(
  context: PublicManagementReadScopeContext,
  filters: TFilters,
  data: TData,
): ManagementReadModelContract<TData, TFilters> {
  return {
    scope: context.scope,
    period: context.period,
    filters: { ...context.filters, ...filters },
    asOf: context.asOf,
    data,
  };
}

function resolveMode(
  filters: ManagementReadScopeFilters,
  requestedBuildingIds: string[],
): ManagementReadScopeMode {
  if (requestedBuildingIds.length === 1) return 'SINGLE_BUILDING';
  if (requestedBuildingIds.length > 1) return 'MULTI_BUILDING';
  if (filters.clientId) return 'CLIENT';
  return 'ALL_ACCESSIBLE';
}

function collectBuildingIds(clients: EffectiveClientContext[]): Set<string> {
  const ids = new Set<string>();
  for (const client of clients) {
    for (const property of client.properties) {
      for (const building of property.buildings) {
        ids.add(building.id);
      }
    }
  }
  return ids;
}

function selectBuildings(
  clients: EffectiveClientContext[],
  selected: Set<string>,
): EffectiveClientContext[] {
  return clients.flatMap((client) => {
    const properties = client.properties.flatMap((property) => {
      const buildings = property.buildings.filter((building) =>
        selected.has(building.id),
      );
      return buildings.length > 0 ? [{ ...property, buildings }] : [];
    });
    return properties.length > 0 ? [{ ...client, properties }] : [];
  });
}

function cloneHierarchy(
  clients: EffectiveClientContext[],
): EffectiveClientContext[] {
  return clients.map((client) => ({
    ...client,
    properties: client.properties.map((property) => ({
      ...property,
      buildings: property.buildings.map((building) => ({ ...building })),
    })),
  }));
}

function sortHierarchy(
  clients: EffectiveClientContext[],
): EffectiveClientContext[] {
  const byCode = (a: { code: string }, b: { code: string }) =>
    a.code.localeCompare(b.code);
  return clients
    .map((client) => ({
      ...client,
      properties: client.properties
        .map((property: EffectivePropertyContext) => ({
          ...property,
          buildings: [...property.buildings].sort(byCode),
        }))
        .sort(byCode),
    }))
    .sort(byCode);
}

export const managementReadScopeService = {
  createManagementReadModelContract,
  getManagementReadScopeContext,
  resolveManagementReadScope,
};
