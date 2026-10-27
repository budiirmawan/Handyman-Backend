import { AppError, ERROR_CODES } from '../../shared/errors';
import type { CustomerDocumentClass, CustomerIdentifierKind } from './handyman-customer-tax.types';

export type CustomerTaxPolicy = Readonly<{
  applicability: 'TAXABLE' | 'EXEMPT' | 'NON_TAXABLE';
  supplierKind: 'E' | 'IR' | 'IN'; supplierPkp: 'PKP' | 'NON_PKP';
  buyerKind: 'INDIVIDUAL' | 'LEGAL_ENTITY'; documentClass: CustomerDocumentClass;
  identifierKind: CustomerIdentifierKind; description: string;
}>;

/** A technical vocabulary only. A matching 0497 rule must be independently Finance-approved. */
export function customerTaxPolicy(code: string): CustomerTaxPolicy {
  const m = typeof code === 'string' && code.length <= 64 &&
    /^P02AC_(TAX|EXEMPT|NON_TAX)_(E|IR|IN)_(P|N)_(I|E)_(ORD|FINAL)_(NP15|NP16|NIK16|NIKNP16|PASS|NONE)_([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)$/.exec(code);
  if (!m || m[7].length < 2 || m[7].length > 24 ||
    m[7].split('_').some(x => ['ANY','ALL','DEFAULT','UNKNOWN','UNSPECIFIED','NONE'].includes(x))) {
    throw new AppError({ code: ERROR_CODES.HANDYMAN_CUSTOMER_TAX_UNSUPPORTED, statusCode: 409, message: 'Unsupported customer tax classification vocabulary.' });
  }
  const applicability = m[1] === 'TAX' ? 'TAXABLE' : m[1] === 'EXEMPT' ? 'EXEMPT' : 'NON_TAXABLE';
  const supplierKind = m[2] as CustomerTaxPolicy['supplierKind'];
  const supplierPkp = m[3] === 'P' ? 'PKP' : 'NON_PKP';
  const buyerKind = m[4] === 'I' ? 'INDIVIDUAL' : 'LEGAL_ENTITY';
  const documentClass = m[5] === 'ORD' ? 'ORDINARY' : 'FINAL_CONSUMER';
  const identifiers: Record<string, CustomerIdentifierKind> = {
    NP15: 'NPWP_15', NP16: 'NPWP_16', NIK16: 'NIK_16', NIKNP16: 'NIK_NPWP_16', PASS: 'PASSPORT', NONE: 'NONE',
  };
  const identifierKind = identifiers[m[6]];
  if ((documentClass === 'ORDINARY' && identifierKind === 'NONE') ||
      (buyerKind === 'LEGAL_ENTITY' && ['NIK_16','NIK_NPWP_16','PASSPORT'].includes(identifierKind)) ||
      (applicability === 'TAXABLE' && supplierPkp !== 'PKP')) {
    throw new AppError({ code: ERROR_CODES.HANDYMAN_CUSTOMER_TAX_UNSUPPORTED, statusCode: 409, message: 'Unsupported customer document policy.' });
  }
  const supplierLabel = supplierKind === 'E' ? 'ENTITY' : supplierKind === 'IR' ? 'INDIVIDUAL_RESIDENT' : 'INDIVIDUAL_NON_RESIDENT';
  return Object.freeze({ applicability, supplierKind, supplierPkp, buyerKind, documentClass, identifierKind,
    description: `P02AC_V1|APPLICABILITY=${applicability}|SUPPLIER=${supplierLabel},${supplierPkp}|BUYER=${buyerKind}|DOCUMENT=${documentClass}|IDENTIFIER=${identifierKind}|CASE=${m[7]}` });
}
