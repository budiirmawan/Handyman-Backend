/**
 * CR-BE-SAAS-01 PART 13C — Add-on domain types (frozen §9.5 + §6).
 *
 * Strict schema alignment: ONLY the columns frozen §9.5 enumerates,
 * plus timestamps (PART 02 0362 repository convention) and a binding
 * lifecycle column (frozen §6 ER: ACTIVE / REMOVED on the binding
 * edge). No catalogue OCC, no `version`, no `expectedVersion` (PART
 * 13C #6).
 *
 * Audit gap (PART 13C #3): no frozen §18.2 event is explicitly
 * authoritative for add-on catalogue CRUD or subscription attach /
 * detach. The domain service emits no audit row until contract
 * disposition names an event.
 */

export type SaasAddOnStatus = 'ACTIVE' | 'INACTIVE';

/**
 * Frozen §9.5 add-on entitlement effect: a capability grant (ENABLE /
 * LIMIT) plus a quota delta (limitKey + deltaValue). Effects are
 * INTENT-ONLY — they do not write to `module_entitlements` directly;
 * attachment materializes the capability as an ACTIVE grant with
 * `source='ADD_ON'`.
 */
export type SaasAddOnEntitlementEffect = {
  capabilityCode: string;
  action: 'ENABLE' | 'LIMIT';
  limitKey?: string;
  limitValue?: number;
};

export type SaasAddOnQuotaEffect = {
  limitKey: string;
  deltaValue: number;
};

export type SaasAddOnRecord = {
  id: string;
  productId: string;
  code: string;
  name: string;
  description: string | null;
  status: SaasAddOnStatus;
  entitlementEffects: SaasAddOnEntitlementEffect[];
  quotaEffects: SaasAddOnQuotaEffect[];
  createdAt: Date;
  updatedAt: Date;
};

export type CreateSaasAddOnInput = {
  productId: string;
  code: string;
  name: string;
  description?: string | null;
  status?: SaasAddOnStatus;
  entitlementEffects?: SaasAddOnEntitlementEffect[];
  quotaEffects?: SaasAddOnQuotaEffect[];
};

/**
 * PATCH semantics (PART 13C #6): no catalogue OCC. Scalar fields
 * are patched individually; the catalogue row's `updated_at` is the
 * sole revision marker.
 */
export type UpdateSaasAddOnInput = {
  name?: string;
  description?: string | null;
  status?: SaasAddOnStatus;
};

export type ListSaasAddOnFilters = {
  productId?: string;
  status?: SaasAddOnStatus;
};

/**
 * Lifecycle of the binding edge (the SubscriptionAddOn row).
 * `ACTIVE` = bound; `REMOVED` = detached (history-preserved).
 */
export type SaasSubscriptionAddOnStatus = 'ACTIVE' | 'REMOVED';

export type SaasSubscriptionAddOnRecord = {
  id: string;
  subscriptionId: string;
  addOnId: string;
  status: SaasSubscriptionAddOnStatus;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Attach semantics (PART 13C #6): `expectedVersion` is required
 * against the SUBSCRIPTION aggregate (the binding is a child of
 * subscription; frozen §22 marks attach/detach as `ver`). The
 * subscription OCC seam is reused — no new version column is
 * invented on the add-on tables.
 */
export type AttachSaasAddOnInput = {
  subscriptionId: string;
  addOnId: string;
  expectedVersion: number;
};

export type SaasSubscriptionAddOnDetail = SaasSubscriptionAddOnRecord & {
  /** Frozen §12.1: the ACTIVE grant(s) materialized for this binding. */
  materializedEntitlementIds: string[];
};
