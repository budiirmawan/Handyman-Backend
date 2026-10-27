import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { stableJson } from '../../shared/stable-json';
import { isValidUuid } from '../clients';
import { buildingAccessDeniedError, canAccessBuildingScopedResource } from '../context-access';
import { buyerInstant, requireVerifiedBuyerBindingInSnapshot } from '../handyman-buyer-binding/handyman-buyer-binding.service';
import type { BuyerBindingPin, VerifiedBuyerBinding } from '../handyman-buyer-binding';
import { resolveHandymanTaxRuleInSnapshot } from '../handyman-tax-rules/handyman-tax-rules.service';
import type { TaxRuleResolution } from '../handyman-tax-rules';
import { requireApprovedIdentityAtInSnapshot } from '../handyman-tax-identity/handyman-tax-identity.service';
import type { ApprovedHandymanTaxIdentity } from '../handyman-tax-identity';
import { calculateInclusivePpnAmounts, normalizePpnIdentityPin, validateApprovedPpnIdentityPin,
  validateApprovedPpnRule } from '../handyman-ppn-calculation/handyman-ppn-core';
import { readInclusiveCommercialSource } from './handyman-inclusive-source';
import { permissionRepository } from '../permissions';
import { customerTaxPolicy } from './handyman-customer-tax.policy';
import type { CustomerTaxClassificationPin, CustomerTaxDecision, CustomerTaxRulePin, CustomerTaxSnapshot, CustomerTaxView,
  DecideCustomerTaxClassification, InclusiveInvoiceClassification, InclusiveInvoiceProposal, InclusiveLineTreatment,
  ProposeCustomerTaxClassification, VerifiedCustomerTaxClassification } from './handyman-customer-tax.types';

type Code = 'HANDYMAN_CUSTOMER_TAX_INVALID' | 'HANDYMAN_CUSTOMER_TAX_MISSING' | 'HANDYMAN_CUSTOMER_TAX_CONFLICT' |
  'HANDYMAN_CUSTOMER_TAX_STALE' | 'HANDYMAN_CUSTOMER_TAX_UNVERIFIED' | 'HANDYMAN_CUSTOMER_TAX_INTEGRITY_ERROR';
const err = (code: Code, message: string, statusCode = 409) => new AppError({ code: ERROR_CODES[code], message, statusCode });
const invalid = (field: string) => err('HANDYMAN_CUSTOMER_TAX_INVALID', `Invalid ${field}.`, 400);
const missing = () => err('HANDYMAN_CUSTOMER_TAX_MISSING', 'No current customer tax classification exists.');
const conflict = () => err('HANDYMAN_CUSTOMER_TAX_CONFLICT', 'Customer tax facts, scope or version conflict.');
const stale = () => err('HANDYMAN_CUSTOMER_TAX_STALE', 'Customer tax classification or its reviewed sources have changed.');
const unverified = () => err('HANDYMAN_CUSTOMER_TAX_UNVERIFIED', 'Customer tax classification or required evidence is not verified.');
const integrity = () => err('HANDYMAN_CUSTOMER_TAX_INTEGRITY_ERROR', 'Customer tax classification provenance failed integrity checks.');
const hash = (value: unknown) => createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
function keys(value: unknown, allowed: readonly string[], field: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) throw invalid(field);
}
function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isValidUuid(value) || /^(?:0{32}|1{32}|f{32})$/i.test(value.replaceAll('-',''))) throw invalid(field);
  return value.toLowerCase();
}
function version(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 2_147_483_647) throw invalid(field);
  return value as number;
}
function digest(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw invalid(field);
  return value;
}
function amount(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,15})\.00$/.test(value)) throw invalid('sourceAmount');
  return value;
}
function point(date: unknown, instant: unknown): { taxDate: string; taxPointAt: string } {
  const at = buyerInstant(instant);
  if (typeof date !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(date) ||
      new Date(new Date(at).getTime() + 7 * 3_600_000).toISOString().slice(0, 10) !== date) throw invalid('taxDate/taxPointAt');
  return { taxDate: date, taxPointAt: at };
}
function buyerPin(value: BuyerBindingPin): BuyerBindingPin {
  keys(value, ['bindingId','bindingVersion','bindingDigest','decisionId','decisionDigest'], 'buyer');
  return { bindingId: uuid(value.bindingId,'buyer.bindingId'), bindingVersion: version(value.bindingVersion,'buyer.bindingVersion'),
    bindingDigest: digest(value.bindingDigest,'buyer.bindingDigest'), decisionId: uuid(value.decisionId,'buyer.decisionId'),
    decisionDigest: digest(value.decisionDigest,'buyer.decisionDigest') };
}
function rulePin(value: CustomerTaxRulePin): CustomerTaxRulePin {
  keys(value, ['ruleId','ruleVersion','ruleDigest','approvalDecisionId'], 'rule');
  return { ruleId: uuid(value.ruleId,'rule.ruleId'), ruleVersion: version(value.ruleVersion,'rule.ruleVersion'),
    ruleDigest: digest(value.ruleDigest,'rule.ruleDigest'), approvalDecisionId: uuid(value.approvalDecisionId,'rule.approvalDecisionId') };
}
function classificationPin(value: CustomerTaxClassificationPin): CustomerTaxClassificationPin {
  keys(value, ['classificationId','version','digest','decisionId','decisionDigest'], 'classification');
  return { classificationId: uuid(value.classificationId,'classification.id'), version: version(value.version,'classification.version'),
    digest: digest(value.digest,'classification.digest'), decisionId: uuid(value.decisionId,'classification.decisionId'),
    decisionDigest: digest(value.decisionDigest,'classification.decisionDigest') };
}
function invoiceProposal(value: InclusiveInvoiceProposal | InclusiveInvoiceClassification, stored = false): InclusiveInvoiceProposal {
  keys(value, stored ? ['executionScopeId','supplier','lines','source'] : ['executionScopeId','supplier','lines'], 'invoice');
  const executionScopeId=uuid(value.executionScopeId,'invoice.executionScopeId');
  const supplier=normalizePpnIdentityPin(value.supplier,'invoice.supplier');
  if (!Array.isArray(value.lines) || value.lines.length<1 || value.lines.length>1000) throw invalid('invoice.lines');
  const lines:InclusiveLineTreatment[]=value.lines.map(item=>{
    keys(item,['chargeLineId','taxpayerClassification','rule','evidenceReferenceId'],'invoice.line');
    customerTaxPolicy(item.taxpayerClassification);
    return {chargeLineId:uuid(item.chargeLineId,'invoice.line.chargeLineId'),taxpayerClassification:item.taxpayerClassification,
      rule:rulePin(item.rule),evidenceReferenceId:uuid(item.evidenceReferenceId,'invoice.line.evidenceReferenceId')};
  }).sort((a,b)=>a.chargeLineId.localeCompare(b.chargeLineId));
  if (new Set(lines.map(x=>x.chargeLineId)).size!==lines.length) throw invalid('duplicate invoice lines');
  return {executionScopeId,supplier,lines};
}
function databaseError(error: unknown): never {
  if (error instanceof AppError) throw error;
  if (['23503','23505','23514','40001','40P01'].includes((error as { code?: string })?.code ?? '')) throw conflict();
  throw error;
}
async function access(tx: PoolClient, actor: string, clientId: string, requestId: string, mode: 'maker'|'checker'|'read'): Promise<string> {
  const status = await tx.query('SELECT status FROM users WHERE id=$1', [actor]);
  const permissions = await permissionRepository.listActivePermissionCodesForUser(actor,tx);
  if (status.rows[0]?.status !== 'ACTIVE' || !permissions.includes('handyman.finance.read') ||
      !permissions.includes('handyman.customer_tax.read') || (mode === 'maker' && !permissions.includes('handyman.finance.manage')) ||
      (mode === 'checker' && !permissions.includes('handyman.tax_identity.approve'))) {
    throw new AppError({ code: ERROR_CODES.PERMISSION_DENIED, statusCode: 403, message: 'Explicit scoped customer tax authority is required.' });
  }
  const request = await tx.query('SELECT building_id FROM handyman_service_requests WHERE id=$1 AND client_id=$2',[requestId,clientId]);
  if (!request.rows[0] || !(await canAccessBuildingScopedResource(actor,{clientId,buildingId:request.rows[0].building_id},tx)))
    throw buildingAccessDeniedError();
  return request.rows[0].building_id as string;
}
type ApprovedRule = Extract<TaxRuleResolution,{status:'APPROVED'}>;
async function approvedRule(tx: PoolClient, actor: string, data: {
  clientId: string; taxDate: string; taxPointAt: string; taxpayerClassification: string; rule: CustomerTaxRulePin;
}): Promise<ApprovedRule> {
  const start = ((await tx.query("SELECT date_trunc('milliseconds',transaction_timestamp()) AS now")).rows[0].now as Date).getTime();
  const cutoff = new Date(Math.min(start,new Date(data.taxPointAt).getTime())).toISOString();
  const resolved = await resolveHandymanTaxRuleInSnapshot(tx,actor,{clientId:data.clientId,transactionContext:'CUSTOMER_SERVICE_BILLING',
    taxCode:'PPN',taxpayerClassification:data.taxpayerClassification,taxDate:data.taxDate,knownAt:cutoff});
  if (resolved.status === 'MISSING' || resolved.status === 'NOT_APPROVED') throw unverified();
  if (resolved.status !== 'APPROVED') throw integrity();
  const r=resolved.rule, p=r.snapshot, d=resolved.approval.decision, policy=customerTaxPolicy(data.taxpayerClassification);
  if (p.id!==data.rule.ruleId || p.version!==data.rule.ruleVersion || r.digest!==data.rule.ruleDigest || d.id!==data.rule.approvalDecisionId ||
      p.classificationDescription!==policy.description || !p.legalReference || !p.legalSource || !p.evidenceSource || !p.evidenceReference ||
      d.sourceValidation!=='FINANCE_VALIDATED') throw integrity();
  return resolved;
}
const SNAPSHOT_KEYS = new Set(['schema','id','version','previousClassificationId','clientId','buildingId','requestId','buyerTenantCompanyId',
  'buyerKind','buyerBindingId','buyerBindingVersion','buyerBindingDigest','buyerDecisionId','buyerDecisionDigest','ruleId','ruleVersion',
  'ruleDigest','ruleDecisionId','taxpayerClassification','applicability','taxDate','taxPointAt','currency','amountBasis','sourceAmount','documentClass',
  'identifierKind','identifierReferenceId','retailSellerEligible','retailDirect','retailFinalConsumption','retailForResale','retailEvidenceReferenceId',
  'transactionEvidenceReferenceId','distinctFromSupplier','createdByUserId']);
function view(row: { snapshot: CustomerTaxSnapshot; digest: string; created_at: Date }): CustomerTaxView {
  const s=row.snapshot, v2=s?.schema==='HANDYMAN_CUSTOMER_TAX_V2';
  if (!s || Object.keys(s).length!==SNAPSHOT_KEYS.size+(v2?1:0) ||
      Object.keys(s).some(k=>!SNAPSHOT_KEYS.has(k) && !(v2 && k==='invoice')) ||
      !(s.schema==='HANDYMAN_CUSTOMER_TAX_V1' && s.amountBasis==='PPN_EXCLUSIVE' ||
        v2 && s.amountBasis==='PPN_INCLUSIVE' && s.invoice) ||
      hash(s)!==row.digest || !(row.created_at instanceof Date) || !Number.isFinite(row.created_at.getTime())) throw integrity();
  return Object.freeze({snapshot:Object.freeze({...s}),digest:row.digest,digestAlgorithm:'SHA-256',createdAt:row.created_at.toISOString()});
}
function decision(row: Record<string, any>): CustomerTaxDecision {
  const body={id:row.id,classificationId:row.classification_id,clientId:row.client_id,buildingId:row.building_id,requestId:row.request_id,
    version:row.version,classificationDigest:row.classification_digest,decision:row.decision,evidenceReferenceId:row.evidence_reference_id,
    actorUserId:row.actor_user_id,occurredAt:row.occurred_at.toISOString()};
  if (row.decision_digest!==hash(body)) throw integrity();
  return Object.freeze({...body,decisionDigest:row.decision_digest});
}
function storedPins(s: CustomerTaxSnapshot): {buyer:BuyerBindingPin;rule:CustomerTaxRulePin} {
  try {
    return { buyer:buyerPin({bindingId:s.buyerBindingId,bindingVersion:s.buyerBindingVersion,bindingDigest:s.buyerBindingDigest,
      decisionId:s.buyerDecisionId,decisionDigest:s.buyerDecisionDigest}),
      rule:rulePin({ruleId:s.ruleId,ruleVersion:s.ruleVersion,ruleDigest:s.ruleDigest,approvalDecisionId:s.ruleDecisionId}) };
  } catch { throw integrity(); }
}
type InclusiveResolved = {
  supplier: ApprovedHandymanTaxIdentity;
  lineRules: Array<{ treatment: InclusiveLineTreatment; rule: ApprovedRule;
    amounts: { consideration: string; dpp: string; ppn: string } }>;
};
async function validateInclusiveSources(tx:PoolClient, actor:string, s:CustomerTaxSnapshot):Promise<InclusiveResolved> {
  const invoice=s.invoice;
  if (!invoice || !invoice.source || typeof invoice.source!=='object' || Array.isArray(invoice.source)) throw integrity();
  const normalized=invoiceProposal(invoice,true);
  if (hash({...normalized,source:invoice.source})!==hash(invoice) || normalized.supplier.owner.kind!=='HANDYMAN_ISSUER' ||
      normalized.supplier.owner.clientId!==s.clientId) throw integrity();
  const source=await readInclusiveCommercialSource(tx,s.clientId,s.requestId,normalized.executionScopeId,s.taxDate);
  if (hash(source)!==hash(invoice.source) || source.grossAmount!==s.sourceAmount || source.buildingId!==s.buildingId ||
      source.tenantCompanyId!==s.buyerTenantCompanyId) throw stale();
  if (source.lines.length!==normalized.lines.length ||
      source.lines.some(line=>!normalized.lines.some(t=>t.chargeLineId===line.chargeLineId))) throw integrity();
  const supplier=await requireApprovedIdentityAtInSnapshot(tx,actor,normalized.supplier.owner,s.taxPointAt);
  const readAt=((await tx.query("SELECT date_trunc('milliseconds',transaction_timestamp()) AS now")).rows[0].now as Date).toISOString();
  validateApprovedPpnIdentityPin(normalized.supplier,supplier,s.taxPointAt,readAt);
  const sp=supplier.snapshot, kind=sp.taxpayerKind==='LEGAL_ENTITY' && sp.individualResidency===null ? 'E' :
    sp.taxpayerKind==='INDIVIDUAL' && sp.individualResidency==='RESIDENT' ? 'IR' :
      sp.taxpayerKind==='INDIVIDUAL' && sp.individualResidency==='NON_RESIDENT' ? 'IN' : null;
  if (!kind || source.profiles.some(p=>p.providerStatus!==sp.pkpStatus)) throw integrity();
  const lineRules:InclusiveResolved['lineRules']=[];
  let primary=false;
  for (const treatment of normalized.lines) {
    const policy=customerTaxPolicy(treatment.taxpayerClassification);
    if (policy.buyerKind!==s.buyerKind || policy.documentClass!==s.documentClass || policy.identifierKind!==s.identifierKind ||
        policy.supplierKind!==kind || policy.supplierPkp!==sp.pkpStatus) throw integrity();
    const rule=await approvedRule(tx,actor,{clientId:s.clientId,taxDate:s.taxDate,taxPointAt:s.taxPointAt,
      taxpayerClassification:treatment.taxpayerClassification,rule:treatment.rule});
    validateApprovedPpnRule({clientId:s.clientId,transactionContext:'CUSTOMER_SERVICE_BILLING',taxDate:s.taxDate,
      taxpayerClassification:treatment.taxpayerClassification,rule:treatment.rule},rule,
      Math.min(Date.parse(s.taxPointAt),Date.parse(readAt)),policy.description);
    const line=source.lines.find(x=>x.chargeLineId===treatment.chargeLineId)!;
    const amounts=calculateInclusivePpnAmounts(line.grossAmount,policy.applicability,rule.rule.snapshot);
    if (treatment.taxpayerClassification===s.taxpayerClassification && treatment.rule.ruleId===s.ruleId &&
        treatment.rule.ruleVersion===s.ruleVersion && treatment.rule.ruleDigest===s.ruleDigest &&
        treatment.rule.approvalDecisionId===s.ruleDecisionId) primary=true;
    lineRules.push({treatment,rule,amounts});
  }
  if (!primary) throw integrity();
  return {supplier,lineRules};
}
async function validateSources(tx: PoolClient, actor: string, s: CustomerTaxSnapshot): Promise<{buyer:VerifiedBuyerBinding;rule:ApprovedRule;invoiceResolved?:InclusiveResolved}> {
  let policy;
  try {
    uuid(s.id,'id'); version(s.version,'version'); uuid(s.clientId,'clientId'); uuid(s.requestId,'requestId'); uuid(s.buildingId,'buildingId');
    uuid(s.buyerTenantCompanyId,'buyerTenantCompanyId'); uuid(s.createdByUserId,'createdByUserId');
    if (s.previousClassificationId!==null) uuid(s.previousClassificationId,'previousClassificationId');
    point(s.taxDate,s.taxPointAt); amount(s.sourceAmount); uuid(s.transactionEvidenceReferenceId,'transactionEvidenceReferenceId');
    if (s.currency!=='IDR' || !((s.schema==='HANDYMAN_CUSTOMER_TAX_V1' && s.amountBasis==='PPN_EXCLUSIVE' && !s.invoice) ||
        (s.schema==='HANDYMAN_CUSTOMER_TAX_V2' && s.amountBasis==='PPN_INCLUSIVE' && s.invoice))) throw integrity();
    policy=customerTaxPolicy(s.taxpayerClassification);
    if (s.distinctFromSupplier!==true || s.buyerTenantCompanyId===s.clientId || s.buyerKind!==policy.buyerKind ||
        s.applicability!==policy.applicability || s.documentClass!==policy.documentClass || s.identifierKind!==policy.identifierKind) throw integrity();
    if (s.identifierKind==='NONE' ? s.identifierReferenceId!==null : !uuid(s.identifierReferenceId,'identifierReferenceId')) throw integrity();
    if (s.documentClass==='ORDINARY') {
      if (s.retailSellerEligible!==null || s.retailDirect!==null || s.retailFinalConsumption!==null || s.retailForResale!==null || s.retailEvidenceReferenceId!==null) throw integrity();
    } else if (s.retailSellerEligible!==true || s.retailDirect!==true || s.retailFinalConsumption!==true || s.retailForResale!==false ||
               !uuid(s.retailEvidenceReferenceId,'retailEvidenceReferenceId')) throw integrity();
  } catch { throw integrity(); }
  const pins=storedPins(s);
  const buyer=await requireVerifiedBuyerBindingInSnapshot(tx,actor,{clientId:s.clientId,requestId:s.requestId,pin:pins.buyer,at:s.taxPointAt});
  if (buyer.binding.snapshot.buyerTenantCompanyId!==s.buyerTenantCompanyId || buyer.binding.snapshot.buyerKind!==s.buyerKind ||
      buyer.binding.snapshot.buildingId!==s.buildingId) throw stale();
  const rule=await approvedRule(tx,actor,{clientId:s.clientId,taxDate:s.taxDate,taxPointAt:s.taxPointAt,
    taxpayerClassification:s.taxpayerClassification,rule:pins.rule});
  if (s.schema==='HANDYMAN_CUSTOMER_TAX_V2') return {buyer,rule,invoiceResolved:await validateInclusiveSources(tx,actor,s)};
  return {buyer,rule};
}
async function writeTransaction<T>(work: (tx:PoolClient)=>Promise<T>): Promise<T> {
  const tx=await getPool().connect();
  try { await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ'); const value=await work(tx); await tx.query('COMMIT'); return value; }
  catch (error) { await tx.query('ROLLBACK').catch(()=>undefined); return databaseError(error); } finally { tx.release(); }
}

/** The maker selects an explicit Finance-approved policy and opaque, externally reviewed evidence references. */
export async function proposeCustomerTaxClassification(actorInput: string, input: ProposeCustomerTaxClassification): Promise<CustomerTaxView> {
  keys(input,['clientId','requestId','buyer','rule','taxpayerClassification','applicability','taxDate','taxPointAt','currency','amountBasis','sourceAmount',
    'identifierKind','identifierReferenceId','retail','transactionEvidenceReferenceId','distinctFromSupplier','expectedVersion','invoice'],'input');
  const actor=uuid(actorInput,'actor'),clientId=uuid(input.clientId,'clientId'),requestId=uuid(input.requestId,'requestId');
  const buyer=buyerPin(input.buyer),rule=rulePin(input.rule), dates=point(input.taxDate,input.taxPointAt),sourceAmount=amount(input.sourceAmount);
  const policy=customerTaxPolicy(input.taxpayerClassification);
  if (input.currency!=='IDR' || !['PPN_EXCLUSIVE','PPN_INCLUSIVE'].includes(input.amountBasis)) throw invalid('currency/amountBasis');
  const invoice=input.amountBasis==='PPN_INCLUSIVE' ? invoiceProposal(input.invoice!) : undefined;
  if (input.amountBasis==='PPN_EXCLUSIVE' && input.invoice!==undefined) throw invalid('invoice');
  if (input.applicability!==policy.applicability || input.identifierKind!==policy.identifierKind || input.distinctFromSupplier!==true) throw conflict();
  const identifierReferenceId=input.identifierKind==='NONE' ? (input.identifierReferenceId===null ? null : (()=>{throw invalid('identifierReferenceId');})()) :
    uuid(input.identifierReferenceId,'identifierReferenceId');
  let retailSellerEligible:boolean|null=null,retailDirect:boolean|null=null,retailFinalConsumption:boolean|null=null,retailForResale:boolean|null=null,retailEvidenceReferenceId:string|null=null;
  if (policy.documentClass==='FINAL_CONSUMER') {
    keys(input.retail,['sellerEligible','directRetail','finalConsumption','forResale','evidenceReferenceId'],'retail');
    if (!input.retail || input.retail.sellerEligible!==true || input.retail.directRetail!==true || input.retail.finalConsumption!==true || input.retail.forResale!==false) throw unverified();
    retailSellerEligible=true;retailDirect=true;retailFinalConsumption=true;retailForResale=false;retailEvidenceReferenceId=uuid(input.retail.evidenceReferenceId,'retail.evidenceReferenceId');
  } else if (input.retail!==null) throw invalid('retail');
  const transactionEvidenceReferenceId=uuid(input.transactionEvidenceReferenceId,'transactionEvidenceReferenceId');
  const expected=input.expectedVersion===null?0:version(input.expectedVersion,'expectedVersion');
  return writeTransaction(async tx=>{
    const buildingId=await access(tx,actor,clientId,requestId,'maker');
    await tx.query('INSERT INTO handyman_customer_tax_heads(request_id,client_id,building_id) VALUES($1,$2,$3) ON CONFLICT(request_id) DO NOTHING',
      [requestId,clientId,buildingId]);
    const head=(await tx.query('SELECT * FROM handyman_customer_tax_heads WHERE request_id=$1 FOR UPDATE',[requestId])).rows[0];
    if (!head || head.version!==expected) throw conflict();
    await tx.query('SELECT request_id FROM handyman_buyer_binding_heads WHERE request_id=$1 FOR SHARE',[requestId]);
    await tx.query('SELECT rule_id FROM handyman_tax_rule_windows WHERE rule_id=$1 FOR SHARE',[rule.ruleId]);
    const verified=await requireVerifiedBuyerBindingInSnapshot(tx,actor,{clientId,requestId,pin:buyer,at:dates.taxPointAt});
    if (verified.binding.snapshot.buyerKind!==policy.buyerKind || verified.binding.snapshot.buyerTenantCompanyId===clientId) throw conflict();
    await approvedRule(tx,actor,{clientId,...dates,taxpayerClassification:input.taxpayerClassification,rule});
    const invoiceSnapshot = invoice ? {...invoice,source:await readInclusiveCommercialSource(tx,clientId,requestId,invoice.executionScopeId,dates.taxDate)} : undefined;
    if (invoiceSnapshot && invoiceSnapshot.source.grossAmount!==sourceAmount) throw conflict();
    const id=randomUUID();
    const snapshot:CustomerTaxSnapshot={schema:invoiceSnapshot?'HANDYMAN_CUSTOMER_TAX_V2':'HANDYMAN_CUSTOMER_TAX_V1',id,version:head.version+1,previousClassificationId:head.classification_id,
      clientId,buildingId,requestId,buyerTenantCompanyId:verified.binding.snapshot.buyerTenantCompanyId,buyerKind:verified.binding.snapshot.buyerKind,
      buyerBindingId:buyer.bindingId,buyerBindingVersion:buyer.bindingVersion,buyerBindingDigest:buyer.bindingDigest,
      buyerDecisionId:buyer.decisionId,buyerDecisionDigest:buyer.decisionDigest,ruleId:rule.ruleId,ruleVersion:rule.ruleVersion,
      ruleDigest:rule.ruleDigest,ruleDecisionId:rule.approvalDecisionId,taxpayerClassification:input.taxpayerClassification,
      applicability:input.applicability,...dates,currency:'IDR',amountBasis:input.amountBasis,sourceAmount,documentClass:policy.documentClass,identifierKind:policy.identifierKind,
      identifierReferenceId,retailSellerEligible,retailDirect,retailFinalConsumption,retailForResale,retailEvidenceReferenceId,transactionEvidenceReferenceId,
      distinctFromSupplier:true,createdByUserId:actor,...(invoiceSnapshot?{invoice:invoiceSnapshot}:{})};
    if (invoiceSnapshot) await validateSources(tx,actor,snapshot);
    const result=await tx.query(`INSERT INTO handyman_customer_tax_classifications(id,request_id,client_id,building_id,version,previous_classification_id,
      buyer_binding_id,buyer_decision_id,rule_id,rule_decision_id,snapshot,digest,created_by_user_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING snapshot,digest,created_at`,
      [id,requestId,clientId,buildingId,snapshot.version,head.classification_id,buyer.bindingId,buyer.decisionId,rule.ruleId,rule.approvalDecisionId,
        JSON.stringify(snapshot),hash(snapshot),actor]);
    await tx.query('UPDATE handyman_customer_tax_heads SET version=$2,classification_id=$3,decision_id=NULL WHERE request_id=$1',[requestId,snapshot.version,id]);
    return view(result.rows[0]);
  });
}

/** A separate scoped checker attests the referenced identity and, where relevant, retail facts. */
export async function decideCustomerTaxClassification(actorInput: string, input: DecideCustomerTaxClassification): Promise<CustomerTaxDecision> {
  keys(input,['clientId','requestId','classificationId','version','digest','decision','evidenceReferenceId'],'input');
  const actor=uuid(actorInput,'actor'),clientId=uuid(input.clientId,'clientId'),requestId=uuid(input.requestId,'requestId');
  const id=uuid(input.classificationId,'classificationId'),v=version(input.version,'version'),d=digest(input.digest,'digest');
  if (input.decision!=='VERIFY' && input.decision!=='REJECT') throw invalid('decision');
  const evidence=uuid(input.evidenceReferenceId,'evidenceReferenceId');
  return writeTransaction(async tx=>{
    const buildingId=await access(tx,actor,clientId,requestId,'checker');
    const head=(await tx.query('SELECT * FROM handyman_customer_tax_heads WHERE request_id=$1 FOR UPDATE',[requestId])).rows[0];
    if (!head || head.classification_id!==id || head.version!==v || head.decision_id) throw stale();
    const row=(await tx.query('SELECT * FROM handyman_customer_tax_classifications WHERE id=$1',[id])).rows[0];
    if (!row || row.client_id!==clientId || row.request_id!==requestId || row.building_id!==buildingId || row.version!==v || row.digest!==d) throw integrity();
    const s=view(row).snapshot;
    if (s.createdByUserId===actor) throw new AppError({code:ERROR_CODES.PERMISSION_DENIED,statusCode:403,message:'The maker cannot verify their own classification.'});
    await tx.query('SELECT request_id FROM handyman_buyer_binding_heads WHERE request_id=$1 FOR SHARE',[requestId]);
    await tx.query('SELECT rule_id FROM handyman_tax_rule_windows WHERE rule_id=$1 FOR SHARE',[s.ruleId]);
    await validateSources(tx,actor,s);
    const eventId=randomUUID();
    const inserted=await tx.query(`INSERT INTO handyman_customer_tax_decisions(id,classification_id,request_id,client_id,building_id,version,
      classification_digest,decision,evidence_reference_id,actor_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [eventId,id,requestId,clientId,buildingId,v,d,input.decision,evidence,actor]);
    await tx.query('UPDATE handyman_customer_tax_heads SET decision_id=$2 WHERE request_id=$1',[requestId,eventId]);
    return decision(inserted.rows[0]);
  });
}

type ResolvedCustomerTax = VerifiedCustomerTaxClassification & { buyer: VerifiedBuyerBinding; rule: ApprovedRule; invoiceResolved?: InclusiveResolved };
/** Trusted caller must hold one repeatable-read snapshot. */
export async function requireVerifiedCustomerTaxInSnapshot(tx: PoolClient, actorInput:string,
  input:{clientId:string;requestId:string;pin:CustomerTaxClassificationPin}):Promise<ResolvedCustomerTax> {
  keys(input,['clientId','requestId','pin'],'input');
  const actor=uuid(actorInput,'actor'),clientId=uuid(input.clientId,'clientId'),requestId=uuid(input.requestId,'requestId'),pin=classificationPin(input.pin);
  const buildingId=await access(tx,actor,clientId,requestId,'read');
  const head=(await tx.query('SELECT * FROM handyman_customer_tax_heads WHERE request_id=$1',[requestId])).rows[0];
  if (!head || !head.classification_id) throw missing();
  if (head.client_id!==clientId || head.building_id!==buildingId || head.classification_id!==pin.classificationId || head.version!==pin.version) throw stale();
  if (!head.decision_id) throw unverified();
  if (head.decision_id!==pin.decisionId) throw stale();
  const row=(await tx.query('SELECT * FROM handyman_customer_tax_classifications WHERE id=$1',[head.classification_id])).rows[0];
  const d=(await tx.query('SELECT * FROM handyman_customer_tax_decisions WHERE id=$1',[head.decision_id])).rows[0];
  if (!row || !d || row.digest!==pin.digest || row.client_id!==clientId || row.request_id!==requestId || row.building_id!==buildingId ||
      row.version!==head.version || d.id!==pin.decisionId || d.decision_digest!==pin.decisionDigest || d.classification_id!==row.id ||
      d.client_id!==clientId || d.request_id!==requestId || d.building_id!==buildingId || d.version!==row.version ||
      d.classification_digest!==row.digest || d.actor_user_id===row.created_by_user_id || d.occurred_at.getTime()<=row.created_at.getTime()) throw integrity();
  const classification=view(row),s=classification.snapshot,review=decision(d);
  if (s.id!==row.id || s.version!==row.version || s.previousClassificationId!==row.previous_classification_id ||
      s.clientId!==clientId || s.requestId!==requestId || s.buildingId!==buildingId || s.createdByUserId!==row.created_by_user_id ||
      s.buyerBindingId!==row.buyer_binding_id || s.buyerDecisionId!==row.buyer_decision_id ||
      s.ruleId!==row.rule_id || s.ruleDecisionId!==row.rule_decision_id) throw integrity();
  if (review.decision!=='VERIFY') throw unverified();
  const now=((await tx.query("SELECT date_trunc('milliseconds',transaction_timestamp()) AS now")).rows[0].now as Date).getTime();
  if (d.occurred_at.getTime()>Math.min(now,new Date(s.taxPointAt).getTime())) throw unverified();
  const sources=await validateSources(tx,actor,s);
  return Object.freeze({classification,decision:review,...sources});
}
export async function requireVerifiedCustomerTaxClassification(actor:string,
  input:{clientId:string;requestId:string;pin:CustomerTaxClassificationPin}):Promise<VerifiedCustomerTaxClassification> {
  const tx=await getPool().connect();
  try { await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const {classification,decision}=await requireVerifiedCustomerTaxInSnapshot(tx,actor,input);await tx.query('COMMIT');
    return Object.freeze({classification,decision});
  } catch(error) { await tx.query('ROLLBACK').catch(()=>undefined);throw error; } finally { tx.release(); }
}
