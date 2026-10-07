import type { EffectiveClientContext } from '../auth/effective-context.types';

/**
 * BE-24 PART 01 — shared Management & Owner read-model scope contract.
 *
 * This module owns no operational data. It resolves which existing Building
 * contexts a caller may read and provides the common scope/period/provenance
 * envelope that later BE-24 read models compose around their own data.
 */

export const MANAGEMENT_READ_SCOPE_MODES = [
  'ALL_ACCESSIBLE',
  'CLIENT',
  'SINGLE_BUILDING',
  'MULTI_BUILDING',
] as const;

export type ManagementReadScopeMode =
  (typeof MANAGEMENT_READ_SCOPE_MODES)[number];

export type ManagementReadScopeFilters = {
  /** Optional Client narrowing. It never widens the accessible Building set. */
  clientId?: string;
  /** Optional single-Building selector. Mutually exclusive with buildingIds. */
  buildingId?: string;
  /** Optional explicit multi-Building selector. Duplicates are removed. */
  buildingIds?: string[];
  /** BE-23-compatible ISO date/datetime reporting window. */
  dateFrom?: string;
  dateTo?: string;
};

export type ManagementReadScopeFilterEcho = {
  clientId: string | null;
  buildingId: string | null;
  buildingIds: string[];
};

export type ManagementReadPeriod = {
  dateFrom: string | null;
  dateTo: string | null;
  /** BE-23 reporting windows are evaluated in UTC. */
  timeBasis: 'UTC';
  /**
   * A date-only dateTo includes the whole UTC day. A datetime dateTo is the
   * exclusive upper instant, matching the BE-23 KPI range helpers.
   */
  dateToMode: 'NONE' | 'INCLUSIVE_DAY' | 'EXCLUSIVE_INSTANT';
};

export type ManagementReadScope = {
  mode: ManagementReadScopeMode;
  /** Requested Client, or null when the result may span accessible Clients. */
  clientId: string | null;
  /** Every Client represented by the effective Building scope. */
  clientIds: string[];
  /** Every Building downstream repositories are allowed to query. */
  buildingIds: string[];
  /**
   * Selected subset of the same hierarchy returned by the authoritative
   * effective-user context. No sibling Building is inferred.
   */
  clients: EffectiveClientContext[];
};

/** Public foundation response returned by GET /management/read-scope. */
export type PublicManagementReadScopeContext = {
  scope: ManagementReadScope;
  period: ManagementReadPeriod;
  filters: ManagementReadScopeFilterEcho;
  /** Projection instant, distinct from the requested reporting period. */
  asOf: string;
};

/** Internal range used by later BE-24 repositories: [start, end). */
export type ManagementReadPeriodRange = {
  start: Date | null;
  end: Date | null;
};

export type ResolvedManagementReadScope = {
  context: PublicManagementReadScopeContext;
  range: ManagementReadPeriodRange;
};

/**
 * Shared shape for later BE-24 read models. The platform API success envelope
 * wraps this object; `data` is the read model's own projection.
 */
export type ManagementReadModelContract<
  TData,
  TFilters extends Record<string, unknown> = Record<never, never>,
> = Omit<PublicManagementReadScopeContext, 'filters'> & {
  filters: ManagementReadScopeFilterEcho & TFilters;
  data: TData;
};
