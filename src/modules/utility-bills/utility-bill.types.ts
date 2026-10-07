export const UTILITY_BILL_TYPES = ['ELECTRICITY', 'WATER'] as const;
export type UtilityBillType = (typeof UTILITY_BILL_TYPES)[number];
export const isUtilityBillType = (value: unknown): value is UtilityBillType =>
  typeof value === 'string' && (UTILITY_BILL_TYPES as readonly string[]).includes(value);

export const UTILITY_BILL_STATUSES = ['DRAFT', 'ISSUED', 'CANCELLED'] as const;
export type UtilityBillStatus = (typeof UTILITY_BILL_STATUSES)[number];
export const isUtilityBillStatus = (value: unknown): value is UtilityBillStatus =>
  typeof value === 'string' && (UTILITY_BILL_STATUSES as readonly string[]).includes(value);

export type UtilityBillRecord = {
  id: string;
  clientId: string;
  tenantCompanyId: string;
  buildingId: string;
  meterId: string;
  tenantAssignmentId: string;
  calculationId: string;
  approvalId: string | null;
  spaceId: string | null;
  consumptionId: string;
  utilityType: UtilityBillType;
  periodStart: Date;
  periodEnd: Date;
  calculatedUtilityValue: string;
  billAmount: string;
  consumptionQuantity: string | null;
  uomId: string | null;
  tariffRate: string | null;
  /** Read through from the immutable Utility Calculation tariff snapshot. */
  currency: string | null;
  dueDate: string;
  status: UtilityBillStatus;
  generatedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicUtilityBill = Omit<
  UtilityBillRecord,
  'calculatedUtilityValue' | 'billAmount' | 'consumptionQuantity' | 'tariffRate' | 'periodStart' | 'periodEnd' | 'createdAt' | 'updatedAt'
> & {
  calculatedUtilityValue: number;
  billAmount: number;
  consumptionQuantity: number | null;
  tariffRate: number | null;
  periodStart: string;
  periodEnd: string;
  createdAt: string;
  updatedAt: string;
};

export type GenerateUtilityBillInput = {
  tenantCompanyId: string;
  calculationId: string;
  dueDate: string;
};

export type NewUtilityBill = {
  clientId: string;
  tenantCompanyId: string;
  buildingId: string;
  meterId: string;
  tenantAssignmentId: string;
  calculationId: string;
  approvalId: string;
  spaceId: string;
  consumptionQuantity: string;
  uomId: string;
  tariffRate: string;
  currency: string;
  utilityType: UtilityBillType;
  periodStart: Date;
  periodEnd: Date;
  /** Exact authoritative NUMERIC value from the finalized calculation. */
  billAmount: string;
  dueDate: string;
  generatedByUserId: string;
};

export type UtilityBillInvoiceReady = {
  tenantCompanyId: string;
  billingPeriod: { start: string; end: string };
  chargeDescription: string;
  utilityType: UtilityBillType;
  quantity: number;
  uomId: string;
  unitRate: number;
  amount: number;
  currency: string;
  utilityBillId: string;
  sourceCalculationId: string;
};

export type UpdateUtilityBillInput = {
  dueDate?: string;
  status?: UtilityBillStatus;
};

export type UtilityBillFilters = {
  tenantCompanyId?: string;
  buildingId?: string;
  utilityType?: UtilityBillType;
  status?: UtilityBillStatus;
  periodFrom?: Date;
  periodTo?: Date;
};
