import { AppError } from '../../shared/errors';

/** Explicit, reviewed facts, NOT automatic tax classification by catalog name.
 * The existing ledger can settle agreed VAT-INCLUSIVE prices without inventing
 * a TAX quotation line, a second payment ledger, or a universal tax surcharge.
 * Exclusive/special/mixed regimes are deliberately not silently converted. */
export type HandymanTaxFacts = {
  priceBasis: 'GROSS_INCLUSIVE';
  providerStatus: 'PKP' | 'NON_PKP';
  vatRegime: 'PMK131_ART3' | 'NON_PKP';
  /** Income recipient (Handyman for tenant invoices; BM for BM fees). */
  recipientKind: 'DOMESTIC_BODY' | 'DOMESTIC_INDIVIDUAL';
  incomeRecipientReference: string;
  payerReference: string;
  serviceClass:
    | 'ORDINARY_SERVICE'
    | 'CONSTRUCTION_WORK'
    | 'CONSTRUCTION_CONSULTANCY'
    | 'CONSTRUCTION_INTEGRATED';
  payerIsWithholder: boolean;
  incomeTax: 'NONE' | 'PPH23' | 'PPH_FINAL_CONSTRUCTION';
  hasNpwp: boolean;
  qualification: 'NOT_APPLICABLE' | 'SMALL_CERTIFIED' | 'OTHER_CERTIFIED' | 'UNCERTIFIED';
  withholdingBasis: 'ALL_SERVICE_NET' | 'LABOR_NET';
  effectiveFrom: string;
  effectiveTo: string;
  sourceReference: string;
  classificationReference: string;
  exemptionReference?: string;
  materialExclusionReference?: string;
  certificateReference?: string;
  /** Existing settlement engine supports funded collection, not invented terms. */
  bmSettlementTiming?: 'AFTER_FULL_CUSTOMER_COLLECTION';
};
export function financialConfig(message: string): never {
  throw new AppError({
    statusCode: 409,
    code: 'HANDYMAN_FINANCIAL_CONFIGURATION_REQUIRED',
    message,
  });
}
export function financialConflict(message: string): never {
  throw new AppError({
    statusCode: 409,
    code: 'HANDYMAN_FINANCIAL_RECONCILIATION_CONFLICT',
    message,
  });
}
export function financialMoney(s: unknown): bigint {
  if (typeof s !== 'string' || !/^(0|[1-9]\d{0,15})\.\d{2}$/.test(s))
    throw AppError.validation('A canonical nonnegative decimal money string is required.');
  const [a, b] = s.split('.');
  return BigInt(a) * 100n + BigInt(b);
}
export function financialDecimal(n: bigint): string {
  const sign = n < 0n ? '-' : '';
  const v = n < 0n ? -n : n;
  if (v > 999999999999999999n) financialConflict('Money exceeds the ledger precision.');
  return `${sign}${v / 100n}.${String(v % 100n).padStart(2, '0')}`;
}
const round = (n: bigint, d: bigint) => (n + d / 2n) / d;
export function jakartaDate(date: Date): string {
  return new Date(date.getTime() + 7 * 3600000).toISOString().slice(0, 10);
}
export function financialReference(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > 200)
    throw AppError.validation('A bounded actual external/configuration reference is required.');
  return value.trim();
}
export function validateHandymanTaxFacts(value: unknown): HandymanTaxFacts {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    financialConfig('Reviewed taxpayer, service, payer and effective-date facts are required.');
  const f = { ...value } as HandymanTaxFacts;
  const required = [
    'priceBasis',
    'providerStatus',
    'vatRegime',
    'recipientKind',
    'incomeRecipientReference',
    'payerReference',
    'serviceClass',
    'payerIsWithholder',
    'incomeTax',
    'hasNpwp',
    'qualification',
    'withholdingBasis',
    'effectiveFrom',
    'effectiveTo',
    'sourceReference',
    'classificationReference',
  ];
  const allowed = new Set([
    ...required,
    'exemptionReference',
    'materialExclusionReference',
    'certificateReference',
    'bmSettlementTiming',
  ]);
  if (Object.keys(f).some((k) => !allowed.has(k)) || required.some((k) => !(k in f)))
    financialConfig('Unknown or missing tax facts. No default tax classification is available.');
  if (f.priceBasis !== 'GROSS_INCLUSIVE')
    financialConfig(
      'An explicitly agreed VAT-inclusive price is required; tax-exclusive price integration is not inferred.',
    );
  if (
    !['PKP', 'NON_PKP'].includes(f.providerStatus) ||
    !['PMK131_ART3', 'NON_PKP'].includes(f.vatRegime) ||
    (f.providerStatus === 'PKP') !== (f.vatRegime === 'PMK131_ART3')
  )
    financialConfig(
      'Explicit PKP/non-PKP status and the corresponding supported VAT regime are required. Special/exempt regimes need separate review.',
    );
  if (
    !['DOMESTIC_BODY', 'DOMESTIC_INDIVIDUAL'].includes(f.recipientKind) ||
    typeof f.payerIsWithholder !== 'boolean' ||
    typeof f.hasNpwp !== 'boolean' ||
    ![
      'ORDINARY_SERVICE',
      'CONSTRUCTION_WORK',
      'CONSTRUCTION_CONSULTANCY',
      'CONSTRUCTION_INTEGRATED',
    ].includes(f.serviceClass) ||
    !['NONE', 'PPH23', 'PPH_FINAL_CONSTRUCTION'].includes(f.incomeTax) ||
    !['NOT_APPLICABLE', 'SMALL_CERTIFIED', 'OTHER_CERTIFIED', 'UNCERTIFIED'].includes(
      f.qualification,
    ) ||
    !['ALL_SERVICE_NET', 'LABOR_NET'].includes(f.withholdingBasis)
  )
    financialConfig('Service, recipient, payer, NPWP and certificate facts must be explicit.');
  for (const date of [f.effectiveFrom, f.effectiveTo])
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date
    )
      financialConfig('Valid effective dates are required.');
  if (
    f.effectiveFrom > f.effectiveTo ||
    (f.providerStatus === 'PKP' && f.effectiveFrom < '2025-01-01')
  )
    financialConfig(
      'This reviewed PMK131 regime is effective from 2025-01-01; historical/other regimes are not inferred.',
    );
  f.sourceReference = financialReference(f.sourceReference);
  f.classificationReference = financialReference(f.classificationReference);
  f.incomeRecipientReference = financialReference(f.incomeRecipientReference);
  f.payerReference = financialReference(f.payerReference);
  if (
    f.bmSettlementTiming !== undefined &&
    f.bmSettlementTiming !== 'AFTER_FULL_CUSTOMER_COLLECTION'
  )
    financialConfig('The contract settlement timing is unsupported, not a default.');
  if (f.incomeTax === 'NONE') {
    if (f.serviceClass !== 'ORDINARY_SERVICE' || (f.payerIsWithholder && !f.exemptionReference))
      financialConfig(
        'No-withholding needs a non-withholding payer or an actual reviewed exemption; qualifying construction cannot be relabelled NONE.',
      );
    if (f.exemptionReference) f.exemptionReference = financialReference(f.exemptionReference);
  } else if (f.incomeTax === 'PPH23') {
    if (
      !f.payerIsWithholder ||
      f.recipientKind !== 'DOMESTIC_BODY' ||
      f.serviceClass !== 'ORDINARY_SERVICE' ||
      f.qualification !== 'NOT_APPLICABLE'
    )
      financialConfig(
        'PPh23 service treatment requires a qualifying withholding payer, domestic body and reviewed PMK141 service; not individual/PPh21 or construction.',
      );
    if (f.withholdingBasis === 'LABOR_NET')
      f.materialExclusionReference = financialReference(f.materialExclusionReference);
  } else {
    if (f.withholdingBasis !== 'ALL_SERVICE_NET')
      financialConfig(
        'Qualifying construction uses the contract consideration excluding VAT, not an invented labor-only withholding base.',
      );
    if (
      f.serviceClass === 'ORDINARY_SERVICE' ||
      f.effectiveFrom < '2022-02-21' ||
      f.qualification === 'NOT_APPLICABLE' ||
      (f.serviceClass !== 'CONSTRUCTION_WORK' && f.qualification === 'SMALL_CERTIFIED')
    )
      financialConfig(
        'PP9/2022 requires an explicitly qualifying construction class and actual qualification.',
      );
    if (f.qualification !== 'UNCERTIFIED')
      f.certificateReference = financialReference(f.certificateReference);
  }
  return JSON.parse(JSON.stringify(f)) as HandymanTaxFacts;
}
export type HandymanTaxAmounts = {
  grossLabor: string;
  grossMaterial: string;
  gross: string;
  serviceNet: string;
  dpp: string;
  vat: string;
  incomeTaxBase: string;
  incomeTaxDue: string;
  withholding: string;
  selfRemittance: string;
  cashDue: string;
};
/** Effective-dated, exact integer/rational arithmetic. PPN rate 12% and
 * DPP 11/12 apply ONLY to the explicitly configured PMK131 Art.3 regime.
 * Ordinary services are never classified as construction automatically. */
export function calculateHandymanIndonesiaTax(
  facts: HandymanTaxFacts,
  grossLabor: string,
  grossMaterial = '0.00',
  asOf = jakartaDate(new Date()),
): HandymanTaxAmounts {
  const f = validateHandymanTaxFacts(facts);
  if (asOf < f.effectiveFrom || asOf > f.effectiveTo)
    financialConfig('The tax point is outside the reviewed tax facts effective window.');
  const labor = financialMoney(grossLabor),
    material = financialMoney(grossMaterial),
    gross = labor + material;
  const net = (amount: bigint) =>
    f.providerStatus === 'PKP' ? round(amount * 100n, 111n) : amount;
  const serviceNet = net(gross),
    laborNet = net(labor);
  const vat = gross - serviceNet;
  // Preserve the unrounded rational base: gross / 1.11 * 11/12.
  const dpp = f.providerStatus === 'PKP' ? round(gross * 275n, 333n) : 0n;
  const incomeBase = f.withholdingBasis === 'LABOR_NET' ? laborNet : serviceNet;
  let rate = 0n;
  if (f.incomeTax === 'PPH23') rate = f.hasNpwp ? 200n : 400n;
  if (f.incomeTax === 'PPH_FINAL_CONSTRUCTION') {
    rate =
      f.serviceClass === 'CONSTRUCTION_WORK'
        ? f.qualification === 'SMALL_CERTIFIED'
          ? 175n
          : f.qualification === 'UNCERTIFIED'
            ? 400n
            : 265n
        : f.serviceClass === 'CONSTRUCTION_INTEGRATED'
          ? f.qualification === 'UNCERTIFIED'
            ? 400n
            : 265n
          : f.qualification === 'UNCERTIFIED'
            ? 600n
            : 350n;
  }
  const due = round(incomeBase * rate, 10000n),
    withholding = f.payerIsWithholder ? due : 0n;
  return {
    grossLabor: financialDecimal(labor),
    grossMaterial: financialDecimal(material),
    gross: financialDecimal(gross),
    serviceNet: financialDecimal(serviceNet),
    dpp: financialDecimal(dpp),
    vat: financialDecimal(vat),
    incomeTaxBase: financialDecimal(rate ? incomeBase : 0n),
    incomeTaxDue: financialDecimal(due),
    withholding: financialDecimal(withholding),
    selfRemittance: financialDecimal(f.payerIsWithholder ? 0n : due),
    cashDue: financialDecimal(gross - withholding),
  };
}
