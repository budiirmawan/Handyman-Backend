import type {
  HandymanMaterialSupplySource,
} from '../handyman-material-demands';
import type { MaterialReservationStatus } from '../inventory-material-reservations';

/**
 * CR-HM-BE-07 RUN 2 — material fulfilment facts.
 *
 * `controlled issue` is the one provider-stock hand-off backed by exactly one
 * existing inventory STOCK_OUT. Actual use/install is deliberately a separate
 * append-only field fact; it never posts stock. A normal unused return is the
 * inverse inventory hand-off backed by exactly one STOCK_IN.
 */
export const HANDYMAN_MATERIAL_USAGE_KINDS = ['USED', 'INSTALLED'] as const;
export type HandymanMaterialUsageKind =
  (typeof HANDYMAN_MATERIAL_USAGE_KINDS)[number];

export function isHandymanMaterialUsageKind(
  value: unknown,
): value is HandymanMaterialUsageKind {
  return (
    typeof value === 'string' &&
    (HANDYMAN_MATERIAL_USAGE_KINDS as readonly string[]).includes(value)
  );
}

export type HandymanMaterialControlledIssueRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  handymanMaterialDemandId: string;
  handymanJobId: string;
  workOrderId: string;
  inventoryMaterialReservationId: string | null;
  warehouseId: string;
  itemId: string;
  uomId: string;
  handymanServiceVisitId: string | null;
  handymanWorkSessionId: string | null;
  inventoryStockMovementId: string;
  quantity: number;
  issuedByUserId: string;
  issuedAt: Date;
  reference: string | null;
  notes: string | null;
  idempotencyKey: string;
  idempotencyFingerprint: string;
  createdAt: Date;
};

export type HandymanMaterialActualUsageRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  handymanMaterialDemandId: string;
  handymanJobId: string;
  workOrderId: string;
  handymanMaterialControlledIssueId: string | null;
  inventoryItemId: string | null;
  uomId: string;
  handymanServiceVisitId: string | null;
  handymanWorkSessionId: string | null;
  usageKind: HandymanMaterialUsageKind;
  quantity: number;
  usedByUserId: string;
  usedAt: Date;
  notes: string | null;
  idempotencyKey: string;
  idempotencyFingerprint: string;
  createdAt: Date;
};

export type HandymanMaterialReturnRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  handymanMaterialControlledIssueId: string;
  handymanMaterialDemandId: string;
  handymanJobId: string;
  workOrderId: string;
  warehouseId: string;
  itemId: string;
  uomId: string;
  inventoryStockMovementId: string;
  quantity: number;
  returnedByUserId: string;
  returnedAt: Date;
  reference: string | null;
  notes: string | null;
  idempotencyKey: string;
  idempotencyFingerprint: string;
  createdAt: Date;
};

export type PublicHandymanMaterialReservation = {
  id: string;
  clientId: string;
  buildingId: string;
  sourceType: 'HANDYMAN_MATERIAL_DEMAND';
  handymanMaterialDemandId: string;
  warehouseId: string;
  itemId: string;
  uomId: string;
  reservedQuantity: number;
  consumedQuantity: number;
  remainingQuantity: number;
  status: MaterialReservationStatus;
  createdByUserId: string;
  releasedByUserId: string | null;
  cancelledByUserId: string | null;
  consumedByUserId: string | null;
  notes: string | null;
  createdAt: string;
  releasedAt: string | null;
  cancelledAt: string | null;
  consumedAt: string | null;
  updatedAt: string;
};

export type PublicHandymanMaterialControlledIssue = Omit<
  HandymanMaterialControlledIssueRecord,
  'issuedAt' | 'createdAt' | 'idempotencyKey' | 'idempotencyFingerprint'
> & {
  issuedAt: string;
  createdAt: string;
};

export type PublicHandymanMaterialActualUsage = Omit<
  HandymanMaterialActualUsageRecord,
  'usedAt' | 'createdAt' | 'idempotencyKey' | 'idempotencyFingerprint'
> & {
  usedAt: string;
  createdAt: string;
};

export type PublicHandymanMaterialReturn = Omit<
  HandymanMaterialReturnRecord,
  'returnedAt' | 'createdAt' | 'idempotencyKey' | 'idempotencyFingerprint'
> & {
  returnedAt: string;
  createdAt: string;
};

/**
 * Callers pass their existing client-scoped Idempotency-Key as
 * `idempotencyKey`. Client/building/item/UOM and source authority are always
 * resolved server-side from the Handyman demand and existing inventory master.
 */
export type ReserveHandymanMaterialDemandInput = {
  handymanMaterialDemandId: string;
  warehouseId: string;
  /** Optional assertion only; item is derived from the demand. */
  itemId?: string | null;
  /** Optional assertion only; UOM is derived from the demand. */
  uomId?: string | null;
  quantity: number | string;
  notes?: string | null;
  idempotencyKey: string;
};

export type ReleaseHandymanMaterialReservationInput = {
  inventoryMaterialReservationId: string;
  idempotencyKey: string;
};

export type CancelHandymanMaterialReservationInput = {
  inventoryMaterialReservationId: string;
  idempotencyKey: string;
};

/**
 * A session is optional to support legitimate pre-staged issue. If a visit or
 * session is supplied it is only an asserted execution-context link and must
 * resolve coherently to this job; this command never changes visit/session or
 * execution lifecycle state.
 */
export type IssueHandymanProviderStockInput = {
  handymanMaterialDemandId: string;
  warehouseId: string;
  itemId?: string | null;
  uomId?: string | null;
  inventoryMaterialReservationId?: string | null;
  handymanServiceVisitId?: string | null;
  handymanWorkSessionId?: string | null;
  quantity: number | string;
  issuedAt?: string | null;
  reference?: string | null;
  notes?: string | null;
  idempotencyKey: string;
};

/**
 * Provider stock must cite its originating controlled issue. Customer-supplied
 * facts deliberately cite no inventory issue/reservation/movement and are
 * capped directly against their approved demand.
 */
export type RecordHandymanMaterialActualUsageInput = {
  handymanMaterialDemandId: string;
  handymanMaterialControlledIssueId?: string | null;
  handymanServiceVisitId?: string | null;
  handymanWorkSessionId?: string | null;
  usageKind?: HandymanMaterialUsageKind;
  quantity: number | string;
  usedAt?: string | null;
  notes?: string | null;
  idempotencyKey: string;
};

export type ReturnUnusedHandymanProviderStockInput = {
  handymanMaterialControlledIssueId: string;
  quantity: number | string;
  returnedAt?: string | null;
  reference?: string | null;
  notes?: string | null;
  idempotencyKey: string;
};

export type HandymanMaterialReservationCommandResult = {
  reservation: PublicHandymanMaterialReservation;
  replayed: boolean;
};

export type HandymanMaterialControlledIssueResult = {
  issue: PublicHandymanMaterialControlledIssue;
  replayed: boolean;
};

export type HandymanMaterialActualUsageResult = {
  usage: PublicHandymanMaterialActualUsage;
  replayed: boolean;
  supplySource: HandymanMaterialSupplySource;
};

export type HandymanMaterialReturnResult = {
  return: PublicHandymanMaterialReturn;
  replayed: boolean;
};
