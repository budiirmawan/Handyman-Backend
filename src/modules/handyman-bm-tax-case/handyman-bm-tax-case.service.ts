import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { stableJson } from '../../shared/stable-json';
import { isValidUuid } from '../clients';
import { assertBuildingScopedResourceAccess } from '../context-access';
import { permissionRepository } from '../permissions';
import { readHandymanBmCommissionSourceInSnapshot } from '../handyman-pph-calculation/handyman-pph.service';
import { validateBmWithholdingFromResolved, normalizePphInput } from '../handyman-pph-calculation/handyman-pph-core';
import type { BmCommissionSource, CalculateApprovedBmWithholdingInput } from '../handyman-pph-calculation';
import { validatePpnFromResolved, normalizePpnInput, normalizePpnTaxPoint, normalizePpnIdentityPin,
  validateApprovedPpnIdentityPin, ppnIdentityIdentifierClash } from '../handyman-ppn-calculation/handyman-ppn-core';
import type { CalculateApprovedPpnInput, PpnIdentityPin, PpnRulePin } from '../handyman-ppn-calculation';
import { requireApprovedIdentityAtInSnapshot } from '../handyman-tax-identity/handyman-tax-identity.service';
import { resolveHandymanTaxRuleInSnapshot } from '../handyman-tax-rules/handyman-tax-rules.service';
import type { ApprovedHandymanTaxIdentity } from '../handyman-tax-identity';
import type { TaxRuleResolution } from '../handyman-tax-rules';
import type { BmNonApplicabilityProvenance, BmTaxCaseDecision, BmTaxCasePin, BmTaxCaseReference, BmTaxCaseSnapshot,
  BmTaxCaseSnapshotV1, BmTaxCaseView, BmVerifiedCalculationInput, DecideBmTaxCaseInput, ProposeBmTaxCaseInput } from './handyman-bm-tax-case.types';

type Code = 'HANDYMAN_BM_TAX_CASE_INVALID'|'HANDYMAN_BM_TAX_CASE_MISSING'|'HANDYMAN_BM_TAX_CASE_CONFLICT'|
  'HANDYMAN_BM_TAX_CASE_STALE'|'HANDYMAN_BM_TAX_CASE_UNAPPROVED'|'HANDYMAN_BM_TAX_CASE_INTEGRITY_ERROR';
const error=(code:Code,message:string,statusCode=409)=>new AppError({code:ERROR_CODES[code],message,statusCode});
const invalid=(field:string)=>error('HANDYMAN_BM_TAX_CASE_INVALID',`Invalid ${field}.`,400);
const missing=()=>error('HANDYMAN_BM_TAX_CASE_MISSING','No current BM tax determination exists.');
const conflict=()=>error('HANDYMAN_BM_TAX_CASE_CONFLICT','BM tax case, evidence or version conflicts.');
const stale=()=>error('HANDYMAN_BM_TAX_CASE_STALE','The determination or its pinned sources have changed.');
const unapproved=()=>error('HANDYMAN_BM_TAX_CASE_UNAPPROVED','An independently approved BM tax determination is required.');
const integrity=()=>error('HANDYMAN_BM_TAX_CASE_INTEGRITY_ERROR','BM tax case provenance failed integrity checks.');
const hash=(value:unknown)=>createHash('sha256').update(stableJson(value),'utf8').digest('hex');
const iso=(value:Date)=>value.toISOString();
function keys(value:unknown,allowed:readonly string[],field:string):void {
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(k=>!allowed.includes(k))) throw invalid(field);
}
function uuid(value:unknown,field:string):string {
  if(typeof value!=='string' || !isValidUuid(value) || /^(?:0{32}|1{32}|f{32})$/i.test(value.replaceAll('-',''))) throw invalid(field);
  return value.toLowerCase();
}
function validEvidence(value:unknown):boolean {
  return typeof value==='string' && value===value.toLowerCase() && isValidUuid(value) &&
    !/^(?:0{32}|1{32}|f{32})$/.test(value.replaceAll('-',''));
}
function validLegalText(value:unknown):value is string {
  return typeof value==='string' && [...value].length>=4 && [...value].length<=512 && value===value.trim() &&
    /[A-Za-z]/.test(value) && !/[\u0000-\u001f\u007f]/.test(value) &&
    !['unknown','none','unspecified','n/a','na','tbd','pending','default','null','not applicable'].includes(value.toLowerCase());
}
function legalText(value:unknown,field:string):string {
  if(!validLegalText(value)) throw invalid(field);
  return value;
}
function digest(value:unknown,field:string):string {
  if(typeof value!=='string' || !/^[0-9a-f]{64}$/.test(value)) throw invalid(field);
  return value;
}
function version(value:unknown,field:string):number {
  if(!Number.isSafeInteger(value) || (value as number)<1 || (value as number)>2147483647) throw invalid(field);
  return value as number;
}
function code(value:unknown,field:string):string {
  if(typeof value!=='string' || !/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/.test(value) || value.length<2 || value.length>64 ||
    value.split('_').some(v=>['UNKNOWN','UNSPECIFIED','ANY','ALL','DEFAULT','NONE'].includes(v))) throw invalid(field);
  return value;
}
function key(value:unknown):string {
  if(typeof value!=='string' || !value || value!==value.trim() || value.length>200 || /[\u0000-\u001f\u007f]/.test(value)) throw invalid('idempotencyKey');
  return value;
}
function pin(value:BmTaxCasePin):BmTaxCasePin {
  keys(value,['caseId','version','digest','decisionId','decisionDigest'],'determination');
  return {caseId:uuid(value.caseId,'caseId'),version:version(value.version,'version'),digest:digest(value.digest,'digest'),
    decisionId:uuid(value.decisionId,'decisionId'),decisionDigest:digest(value.decisionDigest,'decisionDigest')};
}
export function normalizeBmVerifiedCalculationInput(value:BmVerifiedCalculationInput):BmVerifiedCalculationInput {
  keys(value,['clientId','entitlementId','determination'],'input');
  return {clientId:uuid(value.clientId,'clientId'),entitlementId:uuid(value.entitlementId,'entitlementId'),determination:pin(value.determination)};
}
function dbError(err:unknown):never {
  if(err instanceof AppError) throw err;
  if(['23503','23505','23514','22P02','40001','40P01'].includes((err as {code?:string})?.code??'')) throw conflict();
  throw err;
}
async function access(tx:PoolClient,actor:string,clientId:string,entitlementId:string,mode:'maker'|'checker'|'read'):Promise<string> {
  const user=await tx.query('SELECT status FROM users WHERE id=$1',[actor]);
  const permissions=await permissionRepository.listActivePermissionCodesForUser(actor,tx);
  if(user.rows[0]?.status!=='ACTIVE' || !permissions.includes('handyman.finance.read') ||
    (mode==='maker' && !permissions.includes('handyman.finance.manage')) ||
    (mode==='checker' && !permissions.includes('handyman.bm_tax_case.approve')))
    throw new AppError({code:ERROR_CODES.PERMISSION_DENIED,statusCode:403,message:'Explicit scoped Finance authority is required.'});
  const row=(await tx.query(`SELECT s.building_id FROM handyman_entitlement_facts f
    JOIN handyman_execution_scopes s ON s.id=f.execution_scope_id AND s.client_id=f.client_id
    WHERE f.id=$1 AND f.client_id=$2 AND f.entitlement_kind='BM_FEE' AND f.fact_state='EARNED'`,[entitlementId,clientId])).rows[0];
  if(!row) throw missing();
  await assertBuildingScopedResourceAccess(actor,{clientId,buildingId:row.building_id},tx);
  return row.building_id;
}
async function lockLedger(tx:PoolClient,entitlementId:string):Promise<void> {
  const result=await tx.query(`SELECT t.id FROM handyman_customer_transactions t JOIN handyman_entitlement_facts f ON f.transaction_id=t.id
    WHERE f.id=$1 FOR UPDATE OF t`,[entitlementId]);
  if(!result.rowCount) throw missing();
}
/** Posting also fences FINAL_CHARGE_ELIGIBILITY transitions, which lock the scope first. */
async function lockPostingScopeAndLedger(tx:PoolClient,clientId:string,entitlementId:string):Promise<void> {
  const scope=await tx.query(`SELECT s.id FROM handyman_execution_scopes s
    JOIN handyman_entitlement_facts f ON f.execution_scope_id=s.id AND f.client_id=s.client_id
    WHERE f.id=$1 AND f.client_id=$2 FOR UPDATE OF s`,[entitlementId,clientId]);
  if(!scope.rowCount) throw missing();
  await lockLedger(tx,entitlementId);
}
async function lockSources(tx:PoolClient,s:Pick<BmTaxCaseSnapshot,
  'ppnBeneficiaryProfileId'|'ppnIssuerProfileId'|'pphBeneficiaryProfileId'|'ppnRuleId'|'pphRuleId'|'coverageId'|'agreementVersionId'>):Promise<void> {
  // READ COMMITTED gets a fresh statement snapshot after each lock. Stable order avoids deadlocks between cases.
  await tx.query('SELECT profile_id FROM handyman_tax_identity_windows WHERE profile_id=ANY($1::uuid[]) ORDER BY profile_id FOR SHARE',
    [[s.ppnBeneficiaryProfileId,s.ppnIssuerProfileId,s.pphBeneficiaryProfileId]]);
  await tx.query(`SELECT i.id FROM handyman_document_issuer_profiles i JOIN handyman_tax_identity_profiles p ON p.issuer_profile_id=i.id
    WHERE p.id=$1 FOR SHARE OF i`,[s.ppnIssuerProfileId]);
  await tx.query('SELECT rule_id FROM handyman_tax_rule_windows WHERE rule_id=ANY($1::uuid[]) ORDER BY rule_id FOR SHARE',[[s.ppnRuleId,s.pphRuleId]]);
  // A coverage or agreement closure must not race the final source revalidation.
  await tx.query(`SELECT c.id FROM handyman_bm_building_coverages c
    JOIN handyman_commercial_agreement_versions v ON v.id=c.agreement_version_id
    WHERE c.id=$1 AND v.id=$2 FOR SHARE OF c,v`,[s.coverageId,s.agreementVersionId]);
}
type ApprovedRule=Extract<TaxRuleResolution,{status:'APPROVED'}>;
async function ruleAt(tx:PoolClient,actor:string,clientId:string,family:'PPN'|'PPH_WITHHOLDING',taxDate:string,taxPointAt:string,
  taxpayerClassification:string,pin:PpnRulePin,readAt:string):Promise<ApprovedRule> {
  const knownAt=new Date(Math.min(Date.parse(taxPointAt),Date.parse(readAt))).toISOString();
  const result=await resolveHandymanTaxRuleInSnapshot(tx,actor,{clientId,transactionContext:'BM_COMMISSION',taxCode:family,taxDate,taxpayerClassification,knownAt});
  if(result.status==='MISSING' || result.status==='AMBIGUOUS') throw stale();
  if(result.status==='NOT_APPROVED') throw unapproved();
  if(result.status!=='APPROVED') throw integrity();
  if(result.rule.snapshot.id!==pin.ruleId || result.rule.snapshot.version!==pin.ruleVersion || result.rule.digest!==pin.ruleDigest ||
     result.approval.decision.id!==pin.approvalDecisionId) throw stale();
  return result;
}
function bmIdentity(clientId:string,counterpartyId:string,profileId:string,profileVersion:number,profileDigest:string,approvalDecisionId:string):PpnIdentityPin {
  return {owner:{kind:'BM_BENEFICIARY',clientId,counterpartyId},profileId,profileVersion,profileDigest,approvalDecisionId};
}
function issuerIdentity(clientId:string,profileId:string,profileVersion:number,profileDigest:string,approvalDecisionId:string):PpnIdentityPin {
  return {owner:{kind:'HANDYMAN_ISSUER',clientId},profileId,profileVersion,profileDigest,approvalDecisionId};
}
function assertCaseTreatments(s:BmTaxCaseSnapshot):void {
  const ppn=s.ppnApplicability,pph=s.pphTreatment;
  if(s.schema==='HANDYMAN_BM_TAX_CASE_V1') {
    if(!['TAXABLE','EXEMPT','NON_TAXABLE'].includes(ppn) || !['WITHHOLD','EXEMPT','NON_WITHHOLD'].includes(pph)) throw integrity();
    return;
  }
  if(s.schema!=='HANDYMAN_BM_TAX_CASE_V2' || Object.keys(s).length!==60 ||
    Object.values(s).some(v=>v!==null && typeof v==='object') || (ppn!=='NOT_APPLICABLE' && pph!=='NOT_APPLICABLE')) throw integrity();
  if(ppn==='NOT_APPLICABLE') {
    if(s.ppnTaxpayerClassification!==null || s.ppnRuleId!==null || s.ppnRuleVersion!==null || s.ppnRuleDigest!==null ||
       s.ppnRuleDecisionId!==null || !validLegalText(s.ppnLegalReference) || !validLegalText(s.ppnLegalSource)) throw integrity();
  } else if(!['TAXABLE','EXEMPT','NON_TAXABLE'].includes(ppn) || s.ppnLegalReference!==null || s.ppnLegalSource!==null) throw integrity();
  if(pph==='NOT_APPLICABLE') {
    if(s.pphTaxpayerClassification!==null || s.pphRuleId!==null || s.pphRuleVersion!==null || s.pphRuleDigest!==null ||
       s.pphRuleDecisionId!==null || !validLegalText(s.pphLegalReference) || !validLegalText(s.pphLegalSource)) throw integrity();
  } else if(!['WITHHOLD','EXEMPT','NON_WITHHOLD'].includes(pph) || s.pphLegalReference!==null || s.pphLegalSource!==null) throw integrity();
}
function storedPpn(s:BmTaxCaseSnapshot,amount:string):CalculateApprovedPpnInput {
  if(s.ppnApplicability==='NOT_APPLICABLE' || !s.ppnTaxpayerClassification || !s.ppnRuleId || !s.ppnRuleVersion ||
     !s.ppnRuleDigest || !s.ppnRuleDecisionId) throw integrity();
  return {clientId:s.clientId,transactionContext:'BM_COMMISSION',taxDate:s.ppnTaxDate,taxPointAt:s.ppnTaxPointAt,currency:'IDR',
    amountBasis:s.ppnAmountBasis,sourceAmount:amount,applicability:s.ppnApplicability,taxpayerClassification:s.ppnTaxpayerClassification,
    supplier:bmIdentity(s.clientId,s.counterpartyId,s.ppnBeneficiaryProfileId,s.ppnBeneficiaryVersion,s.ppnBeneficiaryDigest,s.ppnBeneficiaryDecisionId),
    recipient:issuerIdentity(s.clientId,s.ppnIssuerProfileId,s.ppnIssuerVersion,s.ppnIssuerDigest,s.ppnIssuerDecisionId),
    rule:{ruleId:s.ppnRuleId,ruleVersion:s.ppnRuleVersion,ruleDigest:s.ppnRuleDigest,approvalDecisionId:s.ppnRuleDecisionId}};
}
function storedPph(s:BmTaxCaseSnapshot):CalculateApprovedBmWithholdingInput {
  if(s.pphTreatment==='NOT_APPLICABLE' || !s.pphTaxpayerClassification || !s.pphRuleId || !s.pphRuleVersion ||
     !s.pphRuleDigest || !s.pphRuleDecisionId) throw integrity();
  return {clientId:s.clientId,entitlementId:s.entitlementId,sourceChecksum:s.sourceChecksum,currency:s.currency,commissionBasis:s.commissionBasis,
    commissionGross:s.commissionGross,taxDate:s.pphTaxDate,taxPointAt:s.pphTaxPointAt,treatment:s.pphTreatment,
    taxpayerClassification:s.pphTaxpayerClassification,
    beneficiary:bmIdentity(s.clientId,s.counterpartyId,s.pphBeneficiaryProfileId,s.pphBeneficiaryVersion,s.pphBeneficiaryDigest,s.pphBeneficiaryDecisionId),
    rule:{ruleId:s.pphRuleId,ruleVersion:s.pphRuleVersion,ruleDigest:s.pphRuleDigest,approvalDecisionId:s.pphRuleDecisionId}};
}
export type ResolvedBmTaxCase = Readonly<{
  classification:BmTaxCaseView; decision:BmTaxCaseDecision; reference:BmTaxCaseReference; source:BmCommissionSource;
  ppnInput:CalculateApprovedPpnInput|null; pphInput:CalculateApprovedBmWithholdingInput|null;
  ppnBeneficiary:ApprovedHandymanTaxIdentity; ppnIssuer:ApprovedHandymanTaxIdentity; pphBeneficiary:ApprovedHandymanTaxIdentity;
  ppnRule:ApprovedRule|null; pphRule:ApprovedRule|null; readAt:string;
}>;
async function validateSources(tx:PoolClient,actor:string,s:BmTaxCaseSnapshot,readAt:string):Promise<Omit<ResolvedBmTaxCase,'classification'|'decision'|'reference'>> {
  assertCaseTreatments(s);
  const source=await readHandymanBmCommissionSourceInSnapshot(tx,actor,s.clientId,s.entitlementId);
  if(source.checksum!==s.sourceChecksum || source.commissionGross!==s.commissionGross || source.buildingId!==s.buildingId ||
    source.transactionId!==s.transactionId || source.executionScopeId!==s.executionScopeId || source.beneficiary.counterpartyId!==s.counterpartyId ||
    source.beneficiary.verificationId!==s.verificationId || source.coverage.id!==s.coverageId || source.agreement.id!==s.agreementId ||
    source.agreement.versionId!==s.agreementVersionId || source.agreement.versionNumber!==s.agreementVersionNumber) throw stale();
  const ppnPoint=normalizePpnTaxPoint(s.ppnTaxDate,s.ppnTaxPointAt),pphPoint=normalizePpnTaxPoint(s.pphTaxDate,s.pphTaxPointAt);
  if(ppnPoint.taxPointAt!==s.ppnTaxPointAt || pphPoint.taxPointAt!==s.pphTaxPointAt ||
    Date.parse(s.ppnTaxPointAt)<Date.parse(source.ledgerPostedAt) || Date.parse(s.pphTaxPointAt)<Date.parse(source.ledgerPostedAt)) throw integrity();
  const ppnSupplier=bmIdentity(s.clientId,s.counterpartyId,s.ppnBeneficiaryProfileId,s.ppnBeneficiaryVersion,s.ppnBeneficiaryDigest,s.ppnBeneficiaryDecisionId);
  const ppnRecipient=issuerIdentity(s.clientId,s.ppnIssuerProfileId,s.ppnIssuerVersion,s.ppnIssuerDigest,s.ppnIssuerDecisionId);
  const pphPin=bmIdentity(s.clientId,s.counterpartyId,s.pphBeneficiaryProfileId,s.pphBeneficiaryVersion,s.pphBeneficiaryDigest,s.pphBeneficiaryDecisionId);
  const ppnBeneficiary=await requireApprovedIdentityAtInSnapshot(tx,actor,ppnSupplier.owner,ppnPoint.taxPointAt);
  const ppnIssuer=await requireApprovedIdentityAtInSnapshot(tx,actor,ppnRecipient.owner,ppnPoint.taxPointAt);
  const pphBeneficiary=await requireApprovedIdentityAtInSnapshot(tx,actor,pphPin.owner,pphPoint.taxPointAt);
  if(ppnBeneficiary.snapshot.verificationId!==s.verificationId || pphBeneficiary.snapshot.verificationId!==s.verificationId) throw stale();
  let ppnInput:CalculateApprovedPpnInput|null=null,pphInput:CalculateApprovedBmWithholdingInput|null=null;
  let ppnRule:ApprovedRule|null=null,pphRule:ApprovedRule|null=null;
  if(s.ppnApplicability==='NOT_APPLICABLE') {
    validateApprovedPpnIdentityPin(ppnSupplier,ppnBeneficiary,ppnPoint.taxPointAt,readAt);
    validateApprovedPpnIdentityPin(ppnRecipient,ppnIssuer,ppnPoint.taxPointAt,readAt);
    if(ppnIdentityIdentifierClash(ppnBeneficiary,ppnIssuer)) throw integrity();
  } else {
    const ppn=normalizePpnInput(storedPpn(s,'0.00'));
    ppnRule=await ruleAt(tx,actor,s.clientId,'PPN',ppn.taxDate,ppn.taxPointAt,ppn.taxpayerClassification,ppn.rule,readAt);
    validatePpnFromResolved(ppn,ppnBeneficiary,ppnIssuer,ppnRule,readAt);
    ppnInput=storedPpn(s,source.commissionGross);
  }
  if(s.pphTreatment==='NOT_APPLICABLE') validateApprovedPpnIdentityPin(pphPin,pphBeneficiary,pphPoint.taxPointAt,readAt);
  else {
    pphInput=storedPph(s);const pph=normalizePphInput(pphInput);
    pphRule=await ruleAt(tx,actor,s.clientId,'PPH_WITHHOLDING',pph.taxDate,pph.taxPointAt,pph.taxpayerClassification,pph.rule,readAt);
    validateBmWithholdingFromResolved(pph,source,pphBeneficiary,pphRule,readAt);
  }
  return {source,ppnInput,pphInput,ppnBeneficiary,ppnIssuer,pphBeneficiary,ppnRule,pphRule,readAt};
}
/** Only call after the current independently approved case has been re-resolved in the same snapshot. */
export function nonApplicabilityProvenance(v:ResolvedBmTaxCase,family:'PPN'|'PPH_WITHHOLDING'):BmNonApplicabilityProvenance {
  const s=v.classification.snapshot;
  if(s.schema!=='HANDYMAN_BM_TAX_CASE_V2') throw integrity();
  const isPpn=family==='PPN',reference=isPpn?s.ppnLegalReference:s.pphLegalReference,source=isPpn?s.ppnLegalSource:s.pphLegalSource;
  if((isPpn?s.ppnApplicability:s.pphTreatment)!=='NOT_APPLICABLE' || !validLegalText(reference) || !validLegalText(source)) throw integrity();
  return Object.freeze({legalReference:reference,legalSource:source,evidenceReferenceId:isPpn?s.ppnEvidenceReferenceId:s.pphEvidenceReferenceId,
    reviewEvidenceReferenceId:isPpn?v.decision.ppnReviewEvidenceReferenceId:v.decision.pphReviewEvidenceReferenceId,
    makerUserId:s.createdByUserId,checkerUserId:v.decision.actorUserId});
}
function view(row:Record<string,any>,replayed=false):BmTaxCaseView {
  const snapshot=row.snapshot as BmTaxCaseSnapshot;
  if(!snapshot || row.digest!==hash(snapshot) || snapshot.id!==row.id || snapshot.version!==row.version ||
     snapshot.clientId!==row.client_id || snapshot.buildingId!==row.building_id || snapshot.entitlementId!==row.entitlement_id ||
     snapshot.previousCaseId!==row.previous_case_id || snapshot.createdByUserId!==row.created_by_user_id || snapshot.idempotencyKey!==row.idempotency_key ||
     !validEvidence(snapshot.transactionEvidenceReferenceId) || !validEvidence(snapshot.ppnEvidenceReferenceId) || !validEvidence(snapshot.pphEvidenceReferenceId))
    throw integrity();
  assertCaseTreatments(snapshot);
  return Object.freeze({snapshot:Object.freeze(snapshot),digestAlgorithm:'SHA-256',digest:row.digest,createdAt:iso(row.created_at),replayed});
}
function decision(row:Record<string,any>,replayed=false):BmTaxCaseDecision {
  const body={id:row.id,caseId:row.case_id,clientId:row.client_id,buildingId:row.building_id,entitlementId:row.entitlement_id,
    version:row.version,caseDigest:row.case_digest,decision:row.decision as 'APPROVE'|'REJECT',
    ppnReviewEvidenceReferenceId:row.ppn_evidence_id,pphReviewEvidenceReferenceId:row.pph_evidence_id,
    actorUserId:row.actor_user_id,occurredAt:iso(row.occurred_at)};
  if(hash(body)!==row.decision_digest || !validEvidence(body.ppnReviewEvidenceReferenceId) || !validEvidence(body.pphReviewEvidenceReferenceId)) throw integrity();
  return Object.freeze({...body,decisionDigest:row.decision_digest,replayed});
}
function normalizeIntent(input:ProposeBmTaxCaseInput) {
  keys(input,['clientId','entitlementId','sourceChecksum','transactionClassification','serviceClassification','transactionEvidenceReferenceId',
    'ppn','pph','expectedVersion','idempotencyKey'],'input');
  keys(input.ppn,['taxDate','taxPointAt','amountBasis','applicability','taxpayerClassification','supplier','recipient','rule',
    'legalReference','legalSource','evidenceReferenceId'],'ppn');
  keys(input.pph,['taxDate','taxPointAt','treatment','taxpayerClassification','beneficiary','rule','legalReference','legalSource','evidenceReferenceId'],'pph');
  const clientId=uuid(input.clientId,'clientId'),entitlementId=uuid(input.entitlementId,'entitlementId'),sourceChecksum=digest(input.sourceChecksum,'sourceChecksum');
  const ppn=(()=>{
    if(input.ppn.applicability==='NOT_APPLICABLE') {
      keys(input.ppn,['taxDate','taxPointAt','amountBasis','applicability','supplier','recipient','legalReference','legalSource','evidenceReferenceId'],'ppn');
      const point=normalizePpnTaxPoint(input.ppn.taxDate,input.ppn.taxPointAt),supplier=normalizePpnIdentityPin(input.ppn.supplier,'supplier');
      const recipient=normalizePpnIdentityPin(input.ppn.recipient,'recipient');
      if(input.ppn.amountBasis!=='PPN_EXCLUSIVE' || supplier.owner.kind!=='BM_BENEFICIARY' || recipient.owner.kind!=='HANDYMAN_ISSUER' ||
         supplier.owner.clientId!==clientId || recipient.owner.clientId!==clientId || supplier.profileId===recipient.profileId) throw invalid('ppn parties or amount basis');
      return {...point,amountBasis:'PPN_EXCLUSIVE' as const,applicability:'NOT_APPLICABLE' as const,supplier,recipient,
        legalReference:legalText(input.ppn.legalReference,'ppn legalReference'),legalSource:legalText(input.ppn.legalSource,'ppn legalSource'),
        evidenceReferenceId:uuid(input.ppn.evidenceReferenceId,'ppn evidence')};
    }
    keys(input.ppn,['taxDate','taxPointAt','amountBasis','applicability','taxpayerClassification','supplier','recipient','rule','evidenceReferenceId'],'ppn');
    const p=normalizePpnInput({clientId,transactionContext:'BM_COMMISSION',currency:'IDR',sourceAmount:'0.00',
      taxDate:input.ppn.taxDate,taxPointAt:input.ppn.taxPointAt,amountBasis:input.ppn.amountBasis,applicability:input.ppn.applicability,
      taxpayerClassification:input.ppn.taxpayerClassification,supplier:input.ppn.supplier,recipient:input.ppn.recipient,rule:input.ppn.rule});
    return {taxDate:p.taxDate,taxPointAt:p.taxPointAt,amountBasis:p.amountBasis,applicability:p.applicability,
      taxpayerClassification:p.taxpayerClassification,supplier:p.supplier,recipient:p.recipient,rule:p.rule,evidenceReferenceId:uuid(input.ppn.evidenceReferenceId,'ppn evidence')};
  })();
  const pph=(()=>{
    if(input.pph.treatment==='NOT_APPLICABLE') {
      keys(input.pph,['taxDate','taxPointAt','treatment','beneficiary','legalReference','legalSource','evidenceReferenceId'],'pph');
      const point=normalizePpnTaxPoint(input.pph.taxDate,input.pph.taxPointAt),beneficiary=normalizePpnIdentityPin(input.pph.beneficiary,'beneficiary');
      if(beneficiary.owner.kind!=='BM_BENEFICIARY' || beneficiary.owner.clientId!==clientId) throw invalid('pph beneficiary');
      return {...point,treatment:'NOT_APPLICABLE' as const,beneficiary,legalReference:legalText(input.pph.legalReference,'pph legalReference'),
        legalSource:legalText(input.pph.legalSource,'pph legalSource'),evidenceReferenceId:uuid(input.pph.evidenceReferenceId,'pph evidence')};
    }
    keys(input.pph,['taxDate','taxPointAt','treatment','taxpayerClassification','beneficiary','rule','evidenceReferenceId'],'pph');
    const p=normalizePphInput({clientId,entitlementId,sourceChecksum,currency:'IDR',commissionBasis:'EARNED_BM_COMMISSION',commissionGross:'0.00',
      taxDate:input.pph.taxDate,taxPointAt:input.pph.taxPointAt,treatment:input.pph.treatment,taxpayerClassification:input.pph.taxpayerClassification,
      beneficiary:input.pph.beneficiary,rule:input.pph.rule});
    return {taxDate:p.taxDate,taxPointAt:p.taxPointAt,treatment:p.treatment,taxpayerClassification:p.taxpayerClassification,
      beneficiary:p.beneficiary,rule:p.rule,evidenceReferenceId:uuid(input.pph.evidenceReferenceId,'pph evidence')};
  })();
  return {clientId,entitlementId,sourceChecksum,transactionClassification:code(input.transactionClassification,'transactionClassification'),
    serviceClassification:code(input.serviceClassification,'serviceClassification'),transactionEvidenceReferenceId:uuid(input.transactionEvidenceReferenceId,'transactionEvidenceReferenceId'),
    ppn,pph,expectedVersion:input.expectedVersion===null?null:version(input.expectedVersion,'expectedVersion'),idempotencyKey:key(input.idempotencyKey)};
}
function snapshotFrom(input:ReturnType<typeof normalizeIntent>,source:Pick<BmCommissionSource,
  'buildingId'|'executionScopeId'|'transactionId'|'commissionGross'|'beneficiary'|'coverage'|'agreement'>,
  actor:string,id:string,v:number,previous:string|null,intentDigest:string):BmTaxCaseSnapshot {
  const ppn=input.ppn,pph=input.pph;
  if(ppn.supplier.owner.kind!=='BM_BENEFICIARY' || pph.beneficiary.owner.kind!=='BM_BENEFICIARY' ||
    ppn.supplier.owner.counterpartyId!==source.beneficiary.counterpartyId || pph.beneficiary.owner.counterpartyId!==source.beneficiary.counterpartyId) throw stale();
  const pn='rule' in ppn?ppn.rule:null,ph='rule' in pph?pph.rule:null;
  const common={id,version:v,previousCaseId:previous,clientId:input.clientId,buildingId:source.buildingId,
    entitlementId:input.entitlementId,executionScopeId:source.executionScopeId,transactionId:source.transactionId,sourceChecksum:input.sourceChecksum,
    commissionGross:source.commissionGross,currency:'IDR' as const,commissionBasis:'EARNED_BM_COMMISSION' as const,counterpartyId:source.beneficiary.counterpartyId,
    verificationId:source.beneficiary.verificationId,coverageId:source.coverage.id,agreementId:source.agreement.id,agreementVersionId:source.agreement.versionId,
    agreementVersionNumber:source.agreement.versionNumber,transactionClassification:input.transactionClassification,serviceClassification:input.serviceClassification,
    transactionEvidenceReferenceId:input.transactionEvidenceReferenceId,
    ppnTaxDate:ppn.taxDate,ppnTaxPointAt:ppn.taxPointAt,ppnAmountBasis:ppn.amountBasis,ppnApplicability:ppn.applicability,
    ppnTaxpayerClassification:'taxpayerClassification' in ppn?(ppn.taxpayerClassification??null):null,ppnEvidenceReferenceId:ppn.evidenceReferenceId,
    ppnRuleId:pn?.ruleId??null,ppnRuleVersion:pn?.ruleVersion??null,ppnRuleDigest:pn?.ruleDigest??null,ppnRuleDecisionId:pn?.approvalDecisionId??null,
    ppnBeneficiaryProfileId:ppn.supplier.profileId,ppnBeneficiaryVersion:ppn.supplier.profileVersion,ppnBeneficiaryDigest:ppn.supplier.profileDigest,
    ppnBeneficiaryDecisionId:ppn.supplier.approvalDecisionId,ppnIssuerProfileId:ppn.recipient.profileId,ppnIssuerVersion:ppn.recipient.profileVersion,
    ppnIssuerDigest:ppn.recipient.profileDigest,ppnIssuerDecisionId:ppn.recipient.approvalDecisionId,
    pphTaxDate:pph.taxDate,pphTaxPointAt:pph.taxPointAt,pphTreatment:pph.treatment,
    pphTaxpayerClassification:'taxpayerClassification' in pph?(pph.taxpayerClassification??null):null,pphEvidenceReferenceId:pph.evidenceReferenceId,
    pphRuleId:ph?.ruleId??null,pphRuleVersion:ph?.ruleVersion??null,pphRuleDigest:ph?.ruleDigest??null,pphRuleDecisionId:ph?.approvalDecisionId??null,
    pphBeneficiaryProfileId:pph.beneficiary.profileId,pphBeneficiaryVersion:pph.beneficiary.profileVersion,
    pphBeneficiaryDigest:pph.beneficiary.profileDigest,pphBeneficiaryDecisionId:pph.beneficiary.approvalDecisionId,
    createdByUserId:actor,idempotencyKey:input.idempotencyKey,intentDigest};
  if(ppn.applicability==='NOT_APPLICABLE' || pph.treatment==='NOT_APPLICABLE') return {...common,schema:'HANDYMAN_BM_TAX_CASE_V2',
    ppnLegalReference:ppn.applicability==='NOT_APPLICABLE'?ppn.legalReference:null,ppnLegalSource:ppn.applicability==='NOT_APPLICABLE'?ppn.legalSource:null,
    pphLegalReference:pph.treatment==='NOT_APPLICABLE'?pph.legalReference:null,pphLegalSource:pph.treatment==='NOT_APPLICABLE'?pph.legalSource:null};
  // V1's normalized intent and snapshot fields remain exactly as before 0501.
  return {...common,schema:'HANDYMAN_BM_TAX_CASE_V1'} as BmTaxCaseSnapshotV1;
}
async function readNow(tx:PoolClient):Promise<string> {
  return iso((await tx.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS now")).rows[0].now);
}

/** A scoped Finance maker proposes both independently evidenced tax treatments; it is not authority. */
export async function proposeHandymanBmTaxCase(actorInput:string,input:ProposeBmTaxCaseInput):Promise<BmTaxCaseView> {
  const actor=uuid(actorInput,'actor'),n=normalizeIntent(input);
  const schema=n.ppn.applicability==='NOT_APPLICABLE' || n.pph.treatment==='NOT_APPLICABLE'?'HANDYMAN_BM_TAX_CASE_INTENT_V2':'HANDYMAN_BM_TAX_CASE_INTENT_V1';
  const intentDigest=hash({schema,actor,...n});
  try{return await withTransaction(async tx=>{
    await tx.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    const buildingId=await access(tx,actor,n.clientId,n.entitlementId,'maker');await lockLedger(tx,n.entitlementId);
    const prior=(await tx.query('SELECT * FROM handyman_bm_tax_cases WHERE entitlement_id=$1 AND idempotency_key=$2',[n.entitlementId,n.idempotencyKey])).rows[0];
    if(prior){const found=view(prior,true);if(found.snapshot.intentDigest!==intentDigest || found.snapshot.createdByUserId!==actor) throw conflict();return found;}
    await tx.query(`INSERT INTO handyman_bm_tax_case_heads(entitlement_id,client_id,building_id) VALUES($1,$2,$3)
      ON CONFLICT(entitlement_id) DO NOTHING`,[n.entitlementId,n.clientId,buildingId]);
    const head=(await tx.query('SELECT * FROM handyman_bm_tax_case_heads WHERE entitlement_id=$1 FOR UPDATE',[n.entitlementId])).rows[0];
    if(!head || head.client_id!==n.clientId || head.building_id!==buildingId ||
       (head.version===0 ? n.expectedVersion!==null : n.expectedVersion!==head.version) || (head.version>0 && !head.decision_id)) throw conflict();
    const source=await readHandymanBmCommissionSourceInSnapshot(tx,actor,n.clientId,n.entitlementId);
    if(source.checksum!==n.sourceChecksum) throw stale();
    const s=snapshotFrom(n,source,actor,randomUUID(),head.version+1,head.case_id,intentDigest);
    await lockSources(tx,s);await validateSources(tx,actor,s,await readNow(tx));
    const result=await tx.query(`INSERT INTO handyman_bm_tax_cases(id,entitlement_id,client_id,building_id,version,previous_case_id,
      idempotency_key,snapshot,digest,created_by_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [s.id,s.entitlementId,s.clientId,s.buildingId,s.version,s.previousCaseId,s.idempotencyKey,JSON.stringify(s),hash(s),actor]);
    await tx.query('UPDATE handyman_bm_tax_case_heads SET version=$2,case_id=$3,decision_id=NULL WHERE entitlement_id=$1',[s.entitlementId,s.version,s.id]);
    return view(result.rows[0]);
  });}catch(err){return dbError(err);}
}

/** A different scoped checker explicitly reviews both tax selections; rejection never grants authority. */
export async function decideHandymanBmTaxCase(actorInput:string,input:DecideBmTaxCaseInput):Promise<BmTaxCaseDecision> {
  keys(input,['clientId','entitlementId','caseId','version','digest','decision','ppnReviewEvidenceReferenceId','pphReviewEvidenceReferenceId'],'input');
  const actor=uuid(actorInput,'actor'),clientId=uuid(input.clientId,'clientId'),entitlementId=uuid(input.entitlementId,'entitlementId');
  const caseId=uuid(input.caseId,'caseId'),v=version(input.version,'version'),d=digest(input.digest,'digest');
  const ppnEvidence=uuid(input.ppnReviewEvidenceReferenceId,'ppn review evidence'),pphEvidence=uuid(input.pphReviewEvidenceReferenceId,'pph review evidence');
  if(input.decision!=='APPROVE' && input.decision!=='REJECT') throw invalid('decision');
  try{return await withTransaction(async tx=>{
    await tx.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    const buildingId=await access(tx,actor,clientId,entitlementId,'checker');await lockLedger(tx,entitlementId);
    const existing=(await tx.query('SELECT * FROM handyman_bm_tax_case_decisions WHERE case_id=$1',[caseId])).rows[0];
    if(existing){const prior=decision(existing,true);
      if(prior.clientId!==clientId || prior.entitlementId!==entitlementId || prior.version!==v || prior.caseDigest!==d || prior.actorUserId!==actor ||
        prior.decision!==input.decision || prior.ppnReviewEvidenceReferenceId!==ppnEvidence || prior.pphReviewEvidenceReferenceId!==pphEvidence) throw conflict();
      return prior;}
    const head=(await tx.query('SELECT * FROM handyman_bm_tax_case_heads WHERE entitlement_id=$1 FOR UPDATE',[entitlementId])).rows[0];
    if(!head || head.client_id!==clientId || head.building_id!==buildingId || head.case_id!==caseId || head.version!==v || head.decision_id) throw stale();
    const row=(await tx.query('SELECT * FROM handyman_bm_tax_cases WHERE id=$1',[caseId])).rows[0];
    if(!row) throw integrity();const classification=view(row),s=classification.snapshot;
    if(classification.digest!==d || s.clientId!==clientId || s.entitlementId!==entitlementId || s.buildingId!==buildingId) throw integrity();
    if(s.createdByUserId===actor) throw new AppError({code:ERROR_CODES.PERMISSION_DENIED,statusCode:403,message:'A maker cannot decide their own BM tax case.'});
    if(input.decision==='APPROVE'){await lockSources(tx,s);await validateSources(tx,actor,s,await readNow(tx));}
    const inserted=await tx.query(`INSERT INTO handyman_bm_tax_case_decisions(id,case_id,entitlement_id,client_id,building_id,version,case_digest,
      decision,ppn_evidence_id,pph_evidence_id,actor_user_id,decision_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [randomUUID(),caseId,entitlementId,clientId,buildingId,v,d,input.decision,ppnEvidence,pphEvidence,actor,'0'.repeat(64)]);
    await tx.query('UPDATE handyman_bm_tax_case_heads SET decision_id=$2 WHERE entitlement_id=$1',[entitlementId,inserted.rows[0].id]);
    return decision(inserted.rows[0]);
  });}catch(err){return dbError(err);}
}

/** Trusted callers share one repeatable-read, read-only snapshot with the final calculator. */
export async function requireApprovedBmTaxCaseInSnapshot(tx:PoolClient,actorInput:string,input:BmVerifiedCalculationInput):Promise<ResolvedBmTaxCase> {
  const actor=uuid(actorInput,'actor'),n=normalizeBmVerifiedCalculationInput(input);
  const buildingId=await access(tx,actor,n.clientId,n.entitlementId,'read');
  const head=(await tx.query('SELECT * FROM handyman_bm_tax_case_heads WHERE entitlement_id=$1',[n.entitlementId])).rows[0];
  if(!head || !head.case_id) throw missing();
  const p=n.determination;
  if(head.client_id!==n.clientId || head.building_id!==buildingId || head.case_id!==p.caseId || head.version!==p.version) throw stale();
  if(!head.decision_id) throw unapproved();
  if(head.decision_id!==p.decisionId) throw stale();
  const row=(await tx.query('SELECT * FROM handyman_bm_tax_cases WHERE id=$1',[p.caseId])).rows[0];
  const dr=(await tx.query('SELECT * FROM handyman_bm_tax_case_decisions WHERE id=$1',[p.decisionId])).rows[0];
  if(!row || !dr) throw integrity();
  const classification=view(row),review=decision(dr),s=classification.snapshot;
  if(classification.digest!==p.digest || review.decisionDigest!==p.decisionDigest || review.caseId!==s.id || review.caseDigest!==p.digest ||
    review.version!==s.version || review.clientId!==n.clientId || review.buildingId!==buildingId || review.entitlementId!==n.entitlementId ||
    review.actorUserId===s.createdByUserId || Date.parse(review.occurredAt)<=Date.parse(classification.createdAt)) throw integrity();
  if(review.decision!=='APPROVE') throw unapproved();
  const readAt=await readNow(tx);
  if(Date.parse(review.occurredAt)>Date.parse(readAt)) throw unapproved();
  const sources=await validateSources(tx,actor,s,readAt);
  const reference=Object.freeze({caseId:s.id,version:s.version,digest:classification.digest,decisionId:review.id,decisionDigest:review.decisionDigest,
    actorUserId:review.actorUserId,occurredAt:review.occurredAt,transactionClassification:s.transactionClassification,serviceClassification:s.serviceClassification});
  return Object.freeze({classification,decision:review,reference,...sources});
}

/** Read a current approved determination without producing financial facts. */
export async function requireApprovedHandymanBmTaxCase(actor:string,input:BmVerifiedCalculationInput):Promise<{case:BmTaxCaseView;decision:BmTaxCaseDecision}> {
  const tx=await getPool().connect();try{await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result=await requireApprovedBmTaxCaseInSnapshot(tx,actor,input);await tx.query('COMMIT');return {case:result.classification,decision:result.decision};
  }catch(err){await tx.query('ROLLBACK').catch(()=>undefined);throw err;}finally{tx.release();}
}

// Internal reuse by the separately approved correction bridge; none of these
// helpers makes a caller-supplied correction into an approved tax case.
export { access as accessBmTaxCase, lockLedger as lockBmTaxLedger, lockSources as lockBmTaxSources,
  lockPostingScopeAndLedger as lockBmTaxPostingScopeAndLedger,
  ruleAt as resolveBmTaxCaseRuleAt, normalizeIntent as normalizeBmTaxCaseIntent,
  snapshotFrom as buildBmTaxCaseSnapshot, readNow as readBmTaxNow,
  view as readBmTaxCaseRow, decision as readBmTaxCaseDecisionRow,
  pin as normalizeBmTaxCasePin };
