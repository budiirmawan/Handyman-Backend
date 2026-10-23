/**
 * CR-HM-WORKER-COMPETENCY-01 PART 03B2A — multi-trade Work Order classification.
 *
 * Handyman is a multi-trade light-repair platform (AC, plumbing, minor
 * electrical, sanitary, door/lock, furniture, painting, ceiling, tiling,
 * installation, generic repair). The classification authority is this
 * registry — DATA, not an application enum — so Operations can add a trade
 * without a code change.
 *
 * A Work Order is classified with exactly one ACTIVE category plus a risk
 * level; that pair is what maps to competency requirements (SKILL /
 * CERTIFICATION, configured per category, enforced at the existing Work Order
 * assignment authority).
 *
 * Classification is OPTIONAL by construction: an unclassified Work Order is
 * unrestricted and keeps the pre-PART-03B2A behaviour.
 */

export const WORK_ORDER_TRADE_RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type WorkOrderTradeRiskLevel =
  (typeof WORK_ORDER_TRADE_RISK_LEVELS)[number];

export function isWorkOrderTradeRiskLevel(
  value: unknown,
): value is WorkOrderTradeRiskLevel {
  return (
    typeof value === 'string' &&
    (WORK_ORDER_TRADE_RISK_LEVELS as readonly string[]).includes(value)
  );
}

export const WORK_ORDER_TRADE_CATEGORY_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type WorkOrderTradeCategoryStatus =
  (typeof WORK_ORDER_TRADE_CATEGORY_STATUSES)[number];

export function isWorkOrderTradeCategoryStatus(
  value: unknown,
): value is WorkOrderTradeCategoryStatus {
  return (
    typeof value === 'string' &&
    (WORK_ORDER_TRADE_CATEGORY_STATUSES as readonly string[]).includes(value)
  );
}

/** Code format shared by the database CHECK and the API validator. */
export const WORK_ORDER_TRADE_CATEGORY_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,39}$/;

export type WorkOrderTradeCategoryRecord = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  riskLevel: WorkOrderTradeRiskLevel;
  /** Optional link to the FROZEN F9 `handyman_disciplines` registry. */
  handymanDisciplineId: string | null;
  handymanDisciplineCode: string | null;
  status: WorkOrderTradeCategoryStatus;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicWorkOrderTradeCategory = Omit<
  WorkOrderTradeCategoryRecord,
  'createdAt' | 'updatedAt'
> & {
  createdAt: string;
  updatedAt: string;
};

export type CreateWorkOrderTradeCategoryInput = {
  code: string;
  name: string;
  description: string | null;
  riskLevel: WorkOrderTradeRiskLevel;
  handymanDisciplineId: string | null;
  createdByUserId: string;
};

/** Code is immutable: it is quoted by historical assignment decisions. */
export type UpdateWorkOrderTradeCategoryInput = {
  name?: string;
  description?: string | null;
  riskLevel?: WorkOrderTradeRiskLevel;
  handymanDisciplineId?: string | null;
};

export type ListWorkOrderTradeCategoriesFilter = {
  status?: WorkOrderTradeCategoryStatus;
  riskLevel?: WorkOrderTradeRiskLevel;
  handymanDisciplineId?: string;
};

/**
 * Work Order classification written by Operations' triage decision (PART
 * 03B2A requirement 5). `tradeCategoryId: null` clears the classification and
 * returns the Work Order to the unrestricted path.
 */
export type ClassifyWorkOrderInput = {
  tradeCategoryId: string | null;
  riskLevel?: WorkOrderTradeRiskLevel | null;
  notes?: string | null;
};

export type WorkOrderClassificationRecord = {
  workOrderId: string;
  clientId: string;
  buildingId: string;
  tradeCategoryId: string | null;
  tradeCategoryCode: string | null;
  tradeCategoryName: string | null;
  riskLevel: WorkOrderTradeRiskLevel | null;
  classifiedAt: string | null;
  classifiedByUserId: string | null;
  /**
   * PART 03B2E — does this Work Order belong to the Handyman lifecycle
   * (Tenant → Customer Care → Service Request → Work Order)?
   *
   * For those Work Orders classification is a REQUIRED Operations step before
   * a new assignment, so the surface can tell the client whether it still
   * owes that decision. Derived from the existing Customer Care binding
   * (`tenant_service_requests.work_order_id` / `.work_request_id`), never from
   * a new flag someone has to remember to set.
   */
  classificationRequired: boolean;
};

/** Permission vocabulary reused by the registry (no new permission codes). */
export const WORK_ORDER_TRADE_CATEGORY_PERMISSIONS = {
  read: 'work_order.read',
  manage: 'work_order.manage',
} as const;
