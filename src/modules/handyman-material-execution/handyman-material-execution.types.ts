/**
 * CR-HM-09 PART 01 — material execution persistence types ONLY
 * (FROZEN governance `CR-HM-09_START_GOVERNANCE.md` D1–D7). Statuses
 * and event types are the exact frozen contracts. NO amount/currency/
 * price/charge/billing/payment fields anywhere; NO FM stock/
 * reservation/purchase-order/material-request semantics.
 */

export const HANDYMAN_MATERIAL_EXECUTION_STATUSES = [
  'ESTIMATED',
  'APPROVED',
  'ISSUED',
  'PURCHASED',
  'USED',
  'FINAL_CHARGE_READY',
] as const;

export type HandymanMaterialExecutionStatus =
  (typeof HANDYMAN_MATERIAL_EXECUTION_STATUSES)[number];

export function isHandymanMaterialExecutionStatus(
  value: string,
): value is HandymanMaterialExecutionStatus {
  return (HANDYMAN_MATERIAL_EXECUTION_STATUSES as readonly string[])
    .includes(value);
}

/**
 * RETURNED is NEVER a sticky status — it is a quantity adjustment
 * recorded via RETURN events against issued/purchased holdings.
 */
export type HandymanMaterialAcquisitionMode = 'ISSUED' | 'PURCHASED';

export const HANDYMAN_MATERIAL_EXECUTION_EVENT_TYPES = [
  'ESTIMATE',
  'APPROVE',
  'ISSUE',
  'PURCHASE',
  'USE',
  'RETURN',
  'FINAL_CHARGE_READY',
] as const;

export type HandymanMaterialExecutionEventType =
  (typeof HANDYMAN_MATERIAL_EXECUTION_EVENT_TYPES)[number];

export function isHandymanMaterialExecutionEventType(
  value: string,
): value is HandymanMaterialExecutionEventType {
  return (HANDYMAN_MATERIAL_EXECUTION_EVENT_TYPES as readonly string[])
    .includes(value);
}

/**
 * Line aggregate row (execution truth only). Quantities are
 * server-derived by later-PART commands through events; the
 * quotation snapshot references are written once and never
 * rewritten. ZERO commercial fields — final material charge is
 * CR-HM-12/13 authority.
 */
export type HandymanMaterialExecutionLineRecord = {
  id: string;
  clientId: string;
  executionScopeId: string;
  quotationVersionId: string;
  quotationLineId: string;
  sourceItemId: string | null;
  status: HandymanMaterialExecutionStatus;
  acquisitionMode: HandymanMaterialAcquisitionMode | null;
  estimatedQty: number;
  approvedQty: number;
  issuedQty: number;
  purchasedQty: number;
  usedQty: number;
  returnedQty: number;
  supplierReference: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NewHandymanMaterialExecutionLine = {
  clientId: string;
  executionScopeId: string;
  quotationVersionId: string;
  quotationLineId: string;
  sourceItemId: string | null;
  estimatedQty: number;
  supplierReference?: string | null;
};

/** Head mutation payload (primitive only — no lifecycle decisions). */
export type HandymanMaterialExecutionLineHead = {
  status: HandymanMaterialExecutionStatus;
  acquisitionMode: HandymanMaterialAcquisitionMode | null;
  approvedQty: number;
  issuedQty: number;
  purchasedQty: number;
  usedQty: number;
  returnedQty: number;
  supplierReference: string | null;
};

export type HandymanMaterialExecutionEventRecord = {
  id: string;
  clientId: string;
  lineId: string;
  executionScopeId: string;
  eventType: HandymanMaterialExecutionEventType;
  idempotencyKey: string;
  actorUserId: string;
  occurredAt: string;
  createdAt: string;
};

export type NewHandymanMaterialExecutionEvent = {
  clientId: string;
  lineId: string;
  executionScopeId: string;
  eventType: HandymanMaterialExecutionEventType;
  idempotencyKey: string;
  actorUserId: string;
};
