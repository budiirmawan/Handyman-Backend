import { getPool } from '../../database';
import type { PoolClient } from 'pg';
import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { requireVerifiedCustomerTaxInSnapshot } from '../handyman-customer-tax/handyman-customer-tax.service';
import { customerTaxPolicy } from '../handyman-customer-tax/handyman-customer-tax.policy';
import type { CustomerTaxClassificationPin } from '../handyman-customer-tax';
import { hash, parsePpnWholeRupiah, ppnIdentityReference } from './handyman-ppn-core';

export type InclusiveInvoiceCalculationInput = Readonly<{
  clientId: string; requestId: string; classification: CustomerTaxClassificationPin;
}>;

/** Revalidate and calculate under the caller's single repeatable-read snapshot. */
export async function calculateInclusiveHandymanInvoicePpnInSnapshot(tx:PoolClient, actor:string, input:InclusiveInvoiceCalculationInput) {
  if (typeof actor!=='string' || !isValidUuid(actor) || !input || typeof input!=='object' || Array.isArray(input) ||
      Object.keys(input).some(k=>!['clientId','requestId','classification'].includes(k)))
    throw AppError.validation('A scoped actor and exact reviewed classification pin are required.');
  const verified=await requireVerifiedCustomerTaxInSnapshot(tx,actor,{clientId:input.clientId,requestId:input.requestId,pin:input.classification});
  const s=verified.classification.snapshot, invoice=s.invoice, resolved=verified.invoiceResolved;
  if (s.schema!=='HANDYMAN_CUSTOMER_TAX_V2' || s.amountBasis!=='PPN_INCLUSIVE' || !invoice || !resolved)
    throw new AppError({code:'HANDYMAN_PPN_UNSUPPORTED',statusCode:409,message:'An independently verified inclusive, line-classified commercial source is required.'});
  const lines=resolved.lineRules.map(({treatment,rule,amounts})=>{
    const source=invoice.source.lines.find(x=>x.chargeLineId===treatment.chargeLineId)!;
    const p=rule.rule.snapshot;
    return {chargeLineId:source.chargeLineId,quotationLineId:source.quotationLineId,grossAmount:source.grossAmount,
      considerationBeforePpn:amounts.consideration,dppAmount:amounts.dpp,ppnAmount:amounts.ppn,
      applicability:customerTaxPolicy(treatment.taxpayerClassification).applicability,
      taxpayerClassification:treatment.taxpayerClassification,evidenceReferenceId:treatment.evidenceReferenceId,
      ratePercent:p.ratePercent,rounding:{mode:p.roundingMode,scale:p.roundingScale},basisMethodCode:p.basisMethodCode,
      rule:{id:p.id,version:p.version,digest:rule.rule.digest,basisDescription:p.basisDescription,
        classificationDescription:p.classificationDescription,legalReference:p.legalReference,legalSource:p.legalSource,
        approval:{submission:rule.approval.submission,decision:rule.approval.decision}}};
  });
  const sum=(key:'considerationBeforePpn'|'dppAmount'|'ppnAmount')=>{
    const n=lines.reduce((a,l)=>a+parsePpnWholeRupiah(l[key]),0n);
    if (n>9_999_999_999_999_999n) throw AppError.validation('Inclusive tax total exceeds ledger precision.');
    return `${n}.00`;
  };
  const considerationBeforePpn=sum('considerationBeforePpn'), dppAmount=sum('dppAmount'), ppnAmount=sum('ppnAmount');
  if (parsePpnWholeRupiah(considerationBeforePpn)+parsePpnWholeRupiah(ppnAmount)!==parsePpnWholeRupiah(s.sourceAmount))
    throw new AppError({code:'HANDYMAN_PPN_INTEGRITY_ERROR',statusCode:409,message:'Inclusive line totals do not reconcile to the agreed gross.'});
  const body={schema:'HANDYMAN_INCLUSIVE_INVOICE_PPN_V1' as const,clientId:s.clientId,requestId:s.requestId,
    taxDate:s.taxDate,taxPointAt:s.taxPointAt,currency:'IDR' as const,amountBasis:'PPN_INCLUSIVE' as const,
    commercialSource:invoice.source,commercialSourceChecksum:hash(invoice.source),
    buyer:{tenantCompanyId:s.buyerTenantCompanyId,kind:s.buyerKind,binding:{bindingId:s.buyerBindingId,
      bindingVersion:s.buyerBindingVersion,bindingDigest:s.buyerBindingDigest,decisionId:s.buyerDecisionId,decisionDigest:s.buyerDecisionDigest}},
    supplier:ppnIdentityReference(resolved.supplier),
    classification:{pin:{classificationId:s.id,version:s.version,digest:verified.classification.digest,
      decisionId:verified.decision.id,decisionDigest:verified.decision.decisionDigest},
      decision:verified.decision,documentClass:s.documentClass,identifierKind:s.identifierKind},
    lines,considerationBeforePpn,dppAmount,ppnAmount,totalIncludingPpn:s.sourceAmount,
    authority:'VERIFIED_LINE_CLASSIFICATIONS_AND_CORRECTION_NETTED_COMMERCIAL_SOURCE' as const,
    invoiceIssued:false as const,paymentOrSettlementProof:false as const};
  const result={...body,checksumAlgorithm:'SHA-256' as const,checksum:hash(body)};
  return result;
}

/** Public projection remains read-only and never issues an invoice. */
export async function calculateInclusiveHandymanInvoicePpn(actor:string, input:InclusiveInvoiceCalculationInput) {
  const tx=await getPool().connect();
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result=await calculateInclusiveHandymanInvoicePpnInSnapshot(tx,actor,input);
    await tx.query('COMMIT'); return result;
  } catch(e) { await tx.query('ROLLBACK').catch(()=>undefined); throw e; }
  finally { tx.release(); }
}
