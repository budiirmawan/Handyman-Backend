import type { BmVerifiedCalculationInput } from '../handyman-bm-tax-case';
import type { VerifiedBmWithholdingBreakdown } from '../handyman-pph-calculation';
import type { VerifiedBmPpnBreakdown } from '../handyman-ppn-calculation';

/** A calculation only: never a payable, invoice, tax document, settlement or payout. */
export type BmCommissionTaxProjection = Readonly<{
  schema: 'HANDYMAN_BM_COMMISSION_TAX_PROJECTION_V1';
  authority: 'READ_ONLY_PROJECTION';
  input: BmVerifiedCalculationInput;
  inputChecksumAlgorithm: 'SHA-256'; inputChecksum: string;
  currency: 'IDR'; commissionGross: string;
  ppnBasis: string; ppnAmount: string;
  pphWithholdingBasis: string; pphWithheld: string;
  /** Exact decimal sum of gross plus PPN minus PPh, not a payment instruction. */
  netPayableProjection: string;
  /** Complete independently verified calculations, including source, case, identities and approved rules. */
  ppn: VerifiedBmPpnBreakdown; pph: VerifiedBmWithholdingBreakdown;
  checksumAlgorithm: 'SHA-256'; checksum: string;
}>;
