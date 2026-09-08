/**
 * BE-17H — Work Order Procurement Binding domain types.
 *
 * Binds an existing BE-08 Work Order to its BE-17A Purchase Request, and
 * optionally to a BE-17B Material Request / BE-17C Service Request and a
 * BE-17G Receiving. It does NOT create a separate Work Order procurement
 * engine — it reuses BE-08 Work Order, BE-16 Inventory, and BE-17A–BE-17G.
 *
 * Procurement context must belong to the same Client / Building as the Work
 * Order. `procurementStatus` is backend-authoritative: BOUND on create, READY
 * when a READY PO readiness exists for the request, RECEIVED when a receiving
 * is linked.
 */
export const WO_PROCUREMENT_STATUSES = ['BOUND', 'READY', 'RECEIVED'] as const;
export type WOProcurementStatus = (typeof WO_PROCUREMENT_STATUSES)[number];

export function isWOProcurementStatus(
  value: unknown,
): value is WOProcurementStatus {
  return (
    typeof value === 'string' &&
    (WO_PROCUREMENT_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type WorkOrderProcurementBindingRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  workOrderId: string;
  purchaseRequestId: string;
  materialRequestId: string | null;
  serviceRequestId: string | null;
  receivingId: string | null;
  /**
   * CR-BE-R2P-01 PART 05 — the ACTIVE SPK authorizing this Work Order, plus
   * the ISSUED PO and committed Vendor behind it. NULL together on a legacy
   * request-only binding; set together once the SPK chain is bound.
   */
  workContractId: string | null;
  purchaseOrderId: string | null;
  vendorId: string | null;
  procurementStatus: WOProcurementStatus;
  notes: string | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicWorkOrderProcurementBinding = Omit<
  WorkOrderProcurementBindingRecord,
  'createdAt' | 'updatedAt'
> & {
  createdAt: string;
  updatedAt: string;
  workOrder?: {
    id: string;
    workOrderNumber: string;
    title: string;
    status: string;
  } | null;
  purchaseRequest?: {
    id: string;
    requestNumber: string;
    title: string;
    status: string;
  } | null;
  materialRequest?: {
    id: string;
    itemId: string;
    quantity: number;
    status: string;
  } | null;
  serviceRequest?: {
    id: string;
    serviceType: string;
    title: string;
    status: string;
  } | null;
  receiving?: {
    id: string;
    receivingType: string;
    status: string;
  } | null;
  /** CR-BE-R2P-01 PART 05 — the bound SPK, when the chain is present. */
  workContract?: {
    id: string;
    spkNumber: string;
    title: string;
    status: string;
  } | null;
  purchaseOrder?: {
    id: string;
    poNumber: string;
    status: string;
  } | null;
};

/** Input supplied when creating a binding. */
export type CreateWOProcurementBindingInput = {
  workOrderId: string;
  purchaseRequestId: string;
  materialRequestId?: string | null;
  serviceRequestId?: string | null;
  /**
   * CR-BE-R2P-01 PART 05 — optional ACTIVE SPK to bind. It is the ONLY chain
   * input: the PO, Vendor, Client and Building are all DERIVED from it, so a
   * caller can never supply or override the authoritative context.
   */
  workContractId?: string | null;
  notes?: string;
};

/** Fully-resolved binding data ready for persistence. */
export type NewWorkOrderProcurementBinding = {
  clientId: string;
  buildingId: string;
  workOrderId: string;
  purchaseRequestId: string;
  materialRequestId: string | null;
  serviceRequestId: string | null;
  receivingId: string | null;
  /** PART 05 chain context — derived from the SPK, never caller-supplied. */
  workContractId: string | null;
  purchaseOrderId: string | null;
  vendorId: string | null;
  procurementStatus: WOProcurementStatus;
  notes: string | null;
  createdByUserId: string;
};

/** Input for linking a receiving (promotes status to RECEIVED). */
export type LinkReceivingInput = {
  receivingId: string;
};

/**
 * CR-BE-R2P-01 PART 05 — input for binding an ACTIVE SPK to an existing
 * procurement binding. The SPK reference is the only input; PO, Vendor,
 * Client and Building are derived from it.
 */
export type BindWorkContractInput = {
  workContractId: string;
};
