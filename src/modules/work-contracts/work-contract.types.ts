/**
 * CR-BE-R2P-01 PART 04 — SPK / Work Contract domain types.
 *
 * The SPK (Surat Perintah Kerja / Work Contract) is the EXECUTION MANDATE
 * that follows a committed Purchase Order:
 *
 *   Request → PO Readiness → PO (committed) → **SPK** → Work Order → BAST
 *           → Vendor Invoice → Verification → Payment → Settlement
 *
 * Frozen PART 04 decisions:
 *
 *  1. The SPK is its OWN entity. It does not duplicate the BE-17H Work Order
 *     Procurement Binding domain and adds nothing to `work_orders`. The
 *     SPK → Work Order linkage is PART 05.
 *
 *  2. An SPK may only be raised against an ISSUED Purchase Order: a DRAFT
 *     commitment is not yet a mandate to execute. PO issuance itself (PART 03)
 *     is untouched — this module READS the PO status, never writes it.
 *
 *  3. Client / Building / Vendor are INHERITED from the Purchase Order and
 *     can never be supplied or overridden by the caller.
 *
 *  4. MR/SR remain the quantity authority. This type carries no quantity, no
 *     amount total and no readiness verdict.
 */

/**
 * SPK lifecycle.
 *
 *   DRAFT     — mandate prepared; still editable.
 *   ACTIVE    — work authorized; the SPK is in force and becomes immutable.
 *   COMPLETED — terminal; work concluded. Reachable only from ACTIVE.
 *   CANCELLED — terminal; reachable from DRAFT or ACTIVE.
 */
export const WORK_CONTRACT_STATUSES = [
  'DRAFT',
  'ACTIVE',
  'COMPLETED',
  'CANCELLED',
] as const;

export type WorkContractStatus = (typeof WORK_CONTRACT_STATUSES)[number];

export function isWorkContractStatus(
  value: unknown,
): value is WorkContractStatus {
  return (
    typeof value === 'string' &&
    (WORK_CONTRACT_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Allowed lifecycle transitions — the single deterministic source of truth
 * for what may follow what. COMPLETED is reachable only from ACTIVE, so an
 * SPK can never be completed without having been authorized first.
 */
export const WORK_CONTRACT_TRANSITIONS: Record<
  WorkContractStatus,
  readonly WorkContractStatus[]
> = {
  DRAFT: ['ACTIVE', 'CANCELLED'],
  ACTIVE: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

export function canTransitionWorkContractStatus(
  from: WorkContractStatus,
  to: WorkContractStatus,
): boolean {
  return (
    WORK_CONTRACT_TRANSITIONS[from] as readonly WorkContractStatus[]
  ).includes(to);
}

/**
 * CR-BE-R2P-CONTRACT-01 PART 01 — caller-specific SPK lifecycle actions.
 * Every token maps one-to-one to an existing command endpoint.
 */
export const WORK_CONTRACT_ACTIONS = [
  'ACTIVATE',
  'COMPLETE',
  'CANCEL',
] as const;
export type WorkContractAction = (typeof WORK_CONTRACT_ACTIONS)[number];

/** Established backend available-actions DTO shape: id + state + actions. */
export type WorkContractAvailableActions = {
  workContractId: string;
  state: WorkContractStatus;
  availableActions: WorkContractAction[];
};

/** The lifecycle states in which an SPK occupies its Purchase Order. */
export const WORK_CONTRACT_LIVE_STATUSES: readonly WorkContractStatus[] = [
  'DRAFT',
  'ACTIVE',
];

/** Full database record. */
export type WorkContractRecord = {
  id: string;
  /** Inherited from the Purchase Order — never client-supplied. */
  clientId: string;
  /** Inherited from the Purchase Order — never client-supplied. */
  buildingId: string;
  /** Inherited from the Purchase Order — never client-supplied. */
  vendorId: string;
  /** The ISSUED commitment this mandate executes. */
  purchaseOrderId: string;
  /** SPK identity foundation: unique within a Client. */
  spkNumber: string;
  spkDate: string;
  title: string;
  scopeDescription: string | null;
  startDate: string | null;
  endDate: string | null;
  notes: string | null;
  status: WorkContractStatus;
  createdByUserId: string;
  activatedAt: Date | null;
  activatedByUserId: string | null;
  completedAt: Date | null;
  completedByUserId: string | null;
  cancelledAt: Date | null;
  cancelledByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicWorkContract = Omit<
  WorkContractRecord,
  'activatedAt' | 'completedAt' | 'cancelledAt' | 'createdAt' | 'updatedAt'
> & {
  activatedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Input supplied by the API consumer when raising an SPK.
 *
 * `purchaseOrderId` is the ONLY context input: Client, Building and Vendor
 * are all inherited from that Purchase Order, so a caller can neither widen
 * its own scope nor point a mandate at a vendor that was never committed.
 */
export type CreateWorkContractInput = {
  purchaseOrderId: string;
  spkNumber: string;
  spkDate: string;
  title: string;
  scopeDescription?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  notes?: string | null;
};

/** Fully-resolved Work Contract data ready for persistence. */
export type NewWorkContract = {
  clientId: string;
  buildingId: string;
  vendorId: string;
  purchaseOrderId: string;
  spkNumber: string;
  spkDate: string;
  title: string;
  scopeDescription: string | null;
  startDate: string | null;
  endDate: string | null;
  notes: string | null;
  status: WorkContractStatus;
  createdByUserId: string;
};

/**
 * Partial update input (PATCH /work-contracts/:id). DRAFT only.
 *
 * Identity (`spkNumber`), the commitment reference (`purchaseOrderId`) and
 * the inherited scope (`clientId`, `buildingId`, `vendorId`) are immutable —
 * a mandate is never silently re-pointed at another PO, vendor or building.
 */
export type UpdateWorkContractInput = {
  spkDate?: string;
  title?: string;
  scopeDescription?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  notes?: string | null;
};

/** List filters for GET /work-contracts. */
export type WorkContractFilters = {
  purchaseOrderId?: string;
  vendorId?: string;
  buildingId?: string;
  status?: WorkContractStatus;
  spkDateFrom?: string;
  spkDateTo?: string;
};
