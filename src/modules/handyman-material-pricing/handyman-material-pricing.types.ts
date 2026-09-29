/**
 * CR-HM-12 PART 03 — material pricing basis types ONLY (FROZEN
 * `CR-HM-12_START_GOVERNANCE.md` §6/§10). One basis definition per
 * EXACT agreement version; the mode chooses which CR-HM-09 settled
 * quantity feeds the basis. NO amounts, quantities, currencies, or
 * supplier facts are stored by this CR — unit amounts are the
 * CR-HM-06 approved MATERIAL snapshot, quantities are the CR-HM-09
 * FINAL_CHARGE_READY handoff, both consumed READ-ONLY. BM fee rules
 * are PART 04; ledger posting is CR-HM-13.
 */

export const HANDYMAN_MATERIAL_PRICING_MODES = [
  'SETTLED_USAGE',
  'APPROVED_QTY',
] as const;

export type HandymanMaterialPricingMode =
  (typeof HANDYMAN_MATERIAL_PRICING_MODES)[number];

export function isHandymanMaterialPricingMode(
  value: string,
): value is HandymanMaterialPricingMode {
  return (HANDYMAN_MATERIAL_PRICING_MODES as readonly string[])
    .includes(value);
}

export type HandymanMaterialPricingBasisRecord = {
  id: string;
  agreementVersionId: string;
  mode: HandymanMaterialPricingMode;
  idempotencyKey: string;
  createdByUserId: string;
  createdAt: Date;
};

export type NewHandymanMaterialPricingBasis = {
  agreementVersionId: string;
  mode: HandymanMaterialPricingMode;
  idempotencyKey: string;
  createdByUserId: string;
};

/**
 * One settled CR-HM-09 line joined to its CR-HM-06 MATERIAL line
 * snapshot — the evaluator's only lawful pricing inputs. Quantities
 * come from execution truth; the unit amount comes from the
 * approved snapshot; neither is re-authored here.
 */
export type HandymanMaterialPricingLineInput = {
  /** provenance: handyman_quotation_lines id (MATERIAL). */
  quotationLineId: string;
  /** provenance: handyman_material_execution_lines id. */
  materialExecutionLineId: string;
  /** exact 2dp text from the approved snapshot; never recomputed */
  finalQuotedUnitAmount: string;
  currency: string;
  approvedQty: number;
  finalUsedQty: number;
};

export type HandymanMaterialPricingLineBasis = {
  quotationLineId: string;
  materialExecutionLineId: string;
  finalQuotedUnitAmount: string;
  appliedQty: number;
  basisAmount: string;
  currency: string;
};

export type HandymanMaterialPricingBasisEvaluation = {
  mode: HandymanMaterialPricingMode;
  /** null when the scope has no settled MATERIAL basis lines. */
  currency: string | null;
  lines: HandymanMaterialPricingLineBasis[];
  /** Exact 2dp sum of line bases — a MATERIAL-basis figure only. */
  basisAmount: string;
};
