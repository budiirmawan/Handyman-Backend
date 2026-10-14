import type {
  HandymanMaterialFundingSource,
  HandymanMaterialPurchaseStatus,
} from '../handyman-material-purchasing';
import type {
  HandymanScopeVariationActorRole,
  HandymanScopeVariationStatus,
  HandymanScopeVariationType,
} from '../handyman-scope-variations';

/**
 * CR-HM-OPS-INBOX-BE-01 P0-B — authoritative commercial action inbox types.
 *
 * This is a READ-ONLY discovery projection over the EXISTING commercial
 * records (`handyman_scope_variations`, `handyman_material_purchase_records`).
 * No lifecycle state, actor role, status or decision vocabulary is invented:
 * every status is a repository-native state of its record type and every
 * persona/action is derived only from the authorities those modules already
 * enforce. Discovery authority never alters commercial authority (variation
 * approval/tenant decision, purchasing/expense, QC/BAST, invoice/finance,
 * evidence verification, dispatch assignment stay with their own CRs).
 */

export const HANDYMAN_COMMERCIAL_INBOX_RECORD_TYPES = [
  'SCOPE_VARIATION',
  'MATERIAL_PURCHASE',
] as const;
export type HandymanCommercialInboxRecordType =
  (typeof HANDYMAN_COMMERCIAL_INBOX_RECORD_TYPES)[number];

/**
 * Responsible persona, derived ONLY from the authority that already governs
 * the record's next stage (the variation actor-role vocabulary and the
 * material purchasing actor-role vocabulary). Operations users can never be
 * substituted into the TENANT persona by this projection.
 */
export const HANDYMAN_COMMERCIAL_INBOX_RESPONSIBLE_PERSONAS = [
  'PIC_PEKERJAAN',
  'INSPECTOR',
  'OPERATIONS_MANAGER',
  'TENANT',
] as const;
export type HandymanCommercialInboxResponsiblePersona =
  (typeof HANDYMAN_COMMERCIAL_INBOX_RESPONSIBLE_PERSONAS)[number];

/**
 * Actionable (open) discovery scope, expressed with the repositories' own
 * pending semantics:
 * - variations: the pre-authorized and authorized-for-execution statuses,
 *   minus a tenant-REJECTED decision (the repositories' own
 *   `pendingVariationsCount` definition of closed).
 * - material purchases: every pre-reconciliation status; RECONCILIATION is
 *   the terminal reconciled state and is out of discovery scope.
 * Downstream field/QC/charge variation stages (EXECUTION, QC,
 * FINAL_CHARGE_ELIGIBILITY) have their own governed surfaces and are not
 * Operational inbox discovery.
 */
export const HANDYMAN_COMMERCIAL_INBOX_VARIATION_STATUSES: readonly HandymanScopeVariationStatus[] = [
  'FIELD_FINDING',
  'PROPOSAL',
  'OPERATIONS_REVIEW',
  'REVISED_QUOTATION',
  'TENANT_DECISION',
  'AUTHORIZED_SCOPE',
];

export const HANDYMAN_COMMERCIAL_INBOX_MATERIAL_STATUSES: readonly HandymanMaterialPurchaseStatus[] = [
  'REQUEST',
  'ISSUED',
  'PURCHASED',
  'USAGE',
  'RETURN',
];

export type HandymanCommercialInboxItem = {
  /** Authoritative record id (variation id or material purchase record id). */
  recordId: string;
  recordType: HandymanCommercialInboxRecordType;
  /** The record's actual, repository-native status. */
  recordStatus: HandymanScopeVariationStatus | HandymanMaterialPurchaseStatus;
  /** Record-type-native commercial kind: variation ADD/REDUCE or the
   * material funding source. */
  commercialKind: HandymanScopeVariationType | HandymanMaterialFundingSource;
  executionScopeId: string;
  handymanRequestId: string;
  clientId: string;
  buildingId: string;
  tenantCompanyId: string;
  /** Variation title or material item name (existing record fields). */
  title: string;
  /** Derived from existing authority only (see module doc). */
  responsible: {
    persona: HandymanCommercialInboxResponsiblePersona;
    /** The next governed lifecycle stage of the record's own state machine. */
    action: string;
  };
  /**
   * Derived exception fact, not a new status: a USAGE/RETURN material record
   * that the existing reconciliation authority would reject today because
   * used + returned does not equal issued + purchased (or nothing was used).
   */
  reconciliationException: boolean;
  /** Existing authoritative source reference (latest managed evidence). */
  sourceReference: string;
  /** Existing revised-quotation pointer where the record carries one. */
  revisedQuotationVersionId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

/** Opaque, explicit keyset continuation token. */
export type HandymanCommercialInboxCursor = {
  createdAt: string;
  recordType: HandymanCommercialInboxRecordType;
  recordId: string;
};

export type HandymanCommercialInboxPage = {
  items: HandymanCommercialInboxItem[];
  pagination: {
    limit: number;
    nextCursor: string | null;
    hasMore: boolean;
  };
  /**
   * Present ONLY when explicitly requested via `includeCounts=true` and then
   * always computed over the COMPLETE permitted result set with the same
   * filters and authorization wall — never over a loaded page.
   */
  counts?: HandymanCommercialInboxCounts;
};

export type HandymanCommercialInboxCounts = {
  total: number;
  byRecordType: Record<HandymanCommercialInboxRecordType, number>;
  byStatus: Record<string, number>;
  byResponsiblePersona: Record<string, number>;
};

export type HandymanCommercialInboxQuery = {
  clientId: string;
  buildingId?: string;
  tenantCompanyId?: string;
  recordType?: HandymanCommercialInboxRecordType;
  status?: HandymanScopeVariationStatus | HandymanMaterialPurchaseStatus;
  responsible?: HandymanCommercialInboxResponsiblePersona;
  createdFrom?: Date;
  createdTo?: Date;
  includeCounts: boolean;
  limit: number;
  cursor?: HandymanCommercialInboxCursor;
};
