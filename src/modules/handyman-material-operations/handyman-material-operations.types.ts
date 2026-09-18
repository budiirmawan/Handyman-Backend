import type {
  HandymanMaterialCommercialBasis,
  HandymanMaterialDemandStatus,
  HandymanMaterialSupplySource,
} from '../handyman-material-demands';

/**
 * CR-HM-BE-07 RUN 3 — HTTP-only read shapes for the material operations
 * surface. Command shapes are owned by the Run-1/Run-2 services; this file
 * carries ONLY the derived fulfillment projection, which is computed from
 * authoritative facts at read time and never persisted.
 */
export const HANDYMAN_MATERIAL_FULFILLMENT_STATUSES = [
  'WAITING_FOR_MATERIAL',
  'PARTIALLY_FULFILLED',
  'FULFILLED',
] as const;
export type HandymanMaterialFulfillmentStatus =
  (typeof HANDYMAN_MATERIAL_FULFILLMENT_STATUSES)[number];

export type HandymanMaterialDemandFulfillment = {
  handymanMaterialDemandId: string;
  handymanJobId: string;
  supplySource: HandymanMaterialSupplySource;
  commercialBasis: HandymanMaterialCommercialBasis;
  demandStatus: HandymanMaterialDemandStatus;
  demandQuantity: number;
  /** ACTIVE reservation remainder (provider demands only, else 0). */
  activeReservedQuantity: number;
  /** Gross controlled STOCK_OUT quantity (provider demands only, else 0). */
  issuedQuantity: number;
  /** Cumulative actual USED/INSTALLED quantity (both supply sources). */
  usedQuantity: number;
  /** Cumulative unused-return quantity (provider demands only, else 0). */
  returnedQuantity: number;
  /**
   * Provider: demand − issued − activeReserved. Customer-supplied: demand −
   * used. Derived only; the authoritative caps stay Run-2 owned.
   */
  remainingDemandQuantity: number;
  fulfillmentStatus: HandymanMaterialFulfillmentStatus;
};
