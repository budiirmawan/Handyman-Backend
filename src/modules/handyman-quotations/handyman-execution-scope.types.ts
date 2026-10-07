/**
 * CR-HM-06 PART 05 — Handyman Execution Scope types (FROZEN F8/F9/
 * F10/F11/F12). The single authoritative operational target created
 * ONLY inside a successful quotation APPROVE transaction. Every
 * authority field is a server-derived snapshot of the approved
 * quotation → request → immutable attribution/location lineage chain;
 * NO caller input exists for this entity. Execution Scope != FM work
 * order (F12). Downstream bindings (CR-HM-04/05/07/08) consume this
 * identity later — nothing here implements them.
 */

/** Bounded lifecycle: exactly one state exists in CR-HM-06. */
export const HANDYMAN_EXECUTION_SCOPE_STATUSES = ['AUTHORIZED'] as const;
export type HandymanExecutionScopeStatus =
  (typeof HANDYMAN_EXECUTION_SCOPE_STATUSES)[number];

/** Full execution scope database record (immutable authority). */
export type HandymanExecutionScopeRecord = {
  id: string;
  clientId: string;
  handymanRequestId: string;
  channelAttributionId: string;
  quotationId: string;
  /** UNIQUE: exactly one scope per approved quotation version (F9). */
  approvedQuotationVersionId: string;
  /** Provenance: the exact immutable APPROVE decision (F8). */
  quotationDecisionId: string;
  tenantCompanyId: string;
  /** NULL when the authoritative lineage has no PIC (never fabricated). */
  tenantPicId: string | null;
  /** Authoritative location snapshot (server-derived; CR-HM-07 target). */
  buildingId: string;
  floorId: string | null;
  areaId: string | null;
  roomId: string | null;
  spaceId: string | null;
  status: HandymanExecutionScopeStatus;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation. */
export type PublicHandymanExecutionScope = Omit<
  HandymanExecutionScopeRecord,
  'createdAt' | 'updatedAt'
> & { createdAt: string; updatedAt: string };

/** Fully-resolved row ready for persistence (server-derived only). */
export type NewHandymanExecutionScope = Omit<
  HandymanExecutionScopeRecord,
  'id' | 'status' | 'createdAt' | 'updatedAt'
>;
