import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { stableJson } from '../../shared/stable-json';
import { isValidUuid } from '../clients';
import { readHandymanBmCommissionCorrectionLineageInSnapshot, readHandymanBmCommissionCorrectionLineageInLockedTransaction }
  from '../handyman-bm-correction-lineage/handyman-bm-correction-lineage.service';
import {
  accessBmTaxCase, lockBmTaxLedger, lockBmTaxSources, lockBmTaxPostingScopeAndLedger, resolveBmTaxCaseRuleAt, normalizeBmTaxCaseIntent,
  buildBmTaxCaseSnapshot, readBmTaxNow, readBmTaxCaseRow, readBmTaxCaseDecisionRow, normalizeBmTaxCasePin,
} from '../handyman-bm-tax-case/handyman-bm-tax-case.service';
import type { BmTaxCasePin, ProposeBmTaxCaseInput } from '../handyman-bm-tax-case';
import { cents, decimal, hash, normalizeCorrectedPphInput, validateBmCorrectedWithholdingFromResolved,
  calculateBmCorrectedWithholdingFromResolved, type CorrectedBmWithholdingInput } from '../handyman-pph-calculation/handyman-pph-core';
import { normalizePpnInput, normalizePpnTaxPoint, validatePpnFromResolved, calculatePpnFromResolved,
  validateApprovedPpnIdentityPin, ppnIdentityIdentifierClash, ppnIdentityReference, parsePpnWholeRupiah } from '../handyman-ppn-calculation/handyman-ppn-core';
import type { CalculateApprovedPpnInput } from '../handyman-ppn-calculation';
import { requireApprovedIdentityAtInSnapshot } from '../handyman-tax-identity/handyman-tax-identity.service';
import type { BmCorrectedCommissionSource, BmCorrectionTaxDecision, BmCorrectionTaxProjectionInput, BmCorrectionTaxSnapshot,
  BmCorrectionTaxView, DecideBmCorrectionTaxInput, ProposeBmCorrectionTaxInput, ReadBmCorrectionSourceInput } from './handyman-bm-correction-tax.types';

type Code='HANDYMAN_BM_TAX_CASE_INVALID'|'HANDYMAN_BM_TAX_CASE_MISSING'|'HANDYMAN_BM_TAX_CASE_CONFLICT'|
  'HANDYMAN_BM_TAX_CASE_STALE'|'HANDYMAN_BM_TAX_CASE_UNAPPROVED'|'HANDYMAN_BM_TAX_CASE_INTEGRITY_ERROR';
const err=(code:Code,message:string,statusCode=409)=>new AppError({code:ERROR_CODES[code],message,statusCode});
const invalid=(field:string)=>err('HANDYMAN_BM_TAX_CASE_INVALID',`Invalid ${field}.`,400);
const stale=(message:string)=>err('HANDYMAN_BM_TAX_CASE_STALE',message);
const conflict=()=>err('HANDYMAN_BM_TAX_CASE_CONFLICT','The correction tax case or its version conflicts.');
const unapproved=()=>err('HANDYMAN_BM_TAX_CASE_UNAPPROVED','An independently approved correction tax case is required.');
const integrity=()=>err('HANDYMAN_BM_TAX_CASE_INTEGRITY_ERROR','Correction tax provenance failed integrity checks.');
const iso=(value:Date)=>value.toISOString();
function keys(value:unknown,allowed:readonly string[],field:string):void {
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(k=>!allowed.includes(k))) throw invalid(field);
}
function uuid(value:unknown,field:string):string {
  if(typeof value!=='string' || !isValidUuid(value) || /^(?:0{32}|1{32}|f{32})$/i.test(value.replaceAll('-',''))) throw invalid(field);
  return value.toLowerCase();
}
function digest(value:unknown,field:string):string {
  if(typeof value!=='string' || !/^[0-9a-f]{64}$/.test(value)) throw invalid(field);
  return value;
}
function version(value:unknown,field:string):number {
  if(!Number.isSafeInteger(value) || (value as number)<1 || (value as number)>2147483647) throw invalid(field);
  return value as number;
}
function dbError(error:unknown):never {
  if(error instanceof AppError) throw error;
  if(['23503','23505','23514','22P02','40001','40P01'].includes((error as {code?:string})?.code??'')) throw conflict();
  throw error;
}
function normalizeSourceInput(value:ReadBmCorrectionSourceInput):ReadBmCorrectionSourceInput {
  keys(value,['clientId','entitlementId','correctionFactId','baseline'],'correction source');
  return {clientId:uuid(value.clientId,'clientId'),entitlementId:uuid(value.entitlementId,'entitlementId'),
    correctionFactId:uuid(value.correctionFactId,'correctionFactId'),baseline:normalizeBmTaxCasePin(value.baseline)};
}

/** Read a historical 0500 approval solely as a witness to its original source checksum. */
async function baselineAt(tx:PoolClient,n:ReadBmCorrectionSourceInput,buildingId:string) {
  const p=n.baseline;
  const head=(await tx.query('SELECT * FROM handyman_bm_tax_case_heads WHERE entitlement_id=$1',[n.entitlementId])).rows[0];
  if(!head || head.client_id!==n.clientId || head.building_id!==buildingId || head.case_id!==p.caseId ||
    head.version!==p.version || head.decision_id!==p.decisionId)
    throw stale(`A current approved 0500 original-source witness is missing for entitlement ${n.entitlementId}.`);
  const c=(await tx.query('SELECT * FROM handyman_bm_tax_cases WHERE id=$1',[p.caseId])).rows[0];
  const d=(await tx.query('SELECT * FROM handyman_bm_tax_case_decisions WHERE id=$1',[p.decisionId])).rows[0];
  if(!c || !d) throw integrity();
  const original=readBmTaxCaseRow(c),review=readBmTaxCaseDecisionRow(d),s=original.snapshot;
  if(original.digest!==p.digest || review.decisionDigest!==p.decisionDigest || review.caseId!==s.id ||
    review.caseDigest!==original.digest || review.version!==s.version || review.clientId!==n.clientId ||
    review.entitlementId!==n.entitlementId || review.buildingId!==buildingId || s.clientId!==n.clientId ||
    s.entitlementId!==n.entitlementId || s.buildingId!==buildingId || review.actorUserId===s.createdByUserId ||
    Date.parse(review.occurredAt)<=Date.parse(original.createdAt)) throw integrity();
  if(review.decision!=='APPROVE' || Date.parse(review.occurredAt)>Date.parse(await readBmTaxNow(tx))) throw unapproved();
  return {original,review};
}

/** Resolve only a case whose original checksum proves the sole adjustment was excluded from the old source. */
async function sourceInSnapshot(tx:PoolClient,actor:string,input:ReadBmCorrectionSourceInput,locked=false):Promise<BmCorrectedCommissionSource> {
  const n=normalizeSourceInput(input),request={clientId:n.clientId,entitlementId:n.entitlementId};
  const lineage=locked ? await readHandymanBmCommissionCorrectionLineageInLockedTransaction(tx,actor,request) :
    await readHandymanBmCommissionCorrectionLineageInSnapshot(tx,actor,request);
  const a=lineage.original.anchor;
  if(lineage.original.bindingStatus!=='VERIFIED_HISTORICAL_BINDING' || a.schema!=='HANDYMAN_BM_EARNED_COMMISSION_ANCHOR_V1')
    throw stale(`Verified earning-time Building and BM beneficiary are missing for entitlement ${n.entitlementId}.`);
  const event=lineage.ledgerCorrections.length===1?lineage.ledgerCorrections[0]:null;
  const fact=event?.entitlementCorrection;
  if(!event || event.status!=='RECORDED_LEDGER_FACT' || !fact || fact.id!==n.correctionFactId ||
    fact.status!=='RECORDED_LINKED_FACT' || !fact.signedRecordedCommissionImpact ||
    !['ADJUSTED_DECREASE','REVERSED'].includes(fact.factKind) || lineage.unlinkedEntitlementCorrections.length || lineage.variations.length ||
    lineage.blockers.some(b=>!(b.code==='LEDGER_BASELINE_OR_COMMISSION_EFFECT_UNPROVEN' && b.sourceId===event.id) &&
      !(b.code==='CURRENT_LEDGER_BASIS_DIFFERS_FROM_EARNED' && b.sourceId===n.entitlementId)))
    throw stale(`Authoritative linked 0417 commission amount or correction linkage is missing for correction ${n.correctionFactId}.`);
  const original=await baselineAt(tx,n,a.buildingId);
  if(original.original.snapshot.commissionGross!==a.commissionGross ||
    Date.parse(original.review.occurredAt)>=Date.parse(event.occurredAt))
    throw stale(`The approved 0500 original-source witness must precede ledger correction ${event.id}.`);

  // The old V1 checksum commits to sorted charge/adjustment IDs. With exactly
  // one current adjustment, recomputing its pre-correction candidate (empty
  // adjustments) proves that the old approved source excluded this cause.
  const charges=(await tx.query(`SELECT id, quotation_line_id, line_kind, currency, amount::text AS amount
    FROM handyman_charge_lines WHERE transaction_id=$1 ORDER BY id`,[a.transactionId])).rows;
  if(!charges.length) throw integrity();
  const basisDigest=hash({schema:'HANDYMAN_BM_LEDGER_BASIS_V1',transactionId:a.transactionId,charges,adjustments:[]});
  const {schema:_schema,checksumAlgorithm:_algorithm,checksum:_checksum,...anchors}=a;
  const originalChecksum=hash({schema:'HANDYMAN_BM_COMMISSION_SOURCE_V1',...anchors,ledgerBasisDigest:basisDigest});
  if(originalChecksum!==original.original.snapshot.sourceChecksum)
    throw stale(`The 0500 source checksum does not prove that ledger correction ${event.id} was excluded from the earned baseline.`);
  const signed=fact.signedRecordedCommissionImpact;
  if(signed!==`-${fact.recordedAmount}` || cents(fact.recordedAmount)>cents(a.commissionGross)) throw integrity();
  const factBody={schema:'HANDYMAN_BM_CORRECTION_FACT_V1',id:fact.id,entitlementId:n.entitlementId,ledgerCorrectionId:event.id,
    factKind:fact.factKind,recordedAmount:fact.recordedAmount,signedAmount:signed,actorUserId:fact.actorUserId,
    occurredAt:fact.occurredAt,idempotencyKey:fact.idempotencyKey,sourceVersion:fact.sourceVersion};
  const body=Object.freeze({schema:'HANDYMAN_BM_CORRECTED_COMMISSION_SOURCE_V1' as const,clientId:a.clientId,buildingId:a.buildingId,
    executionScopeId:a.executionScopeId,transactionId:a.transactionId,entitlementId:a.entitlementId,ledgerPostedAt:a.ledgerPostedAt,
    currency:'IDR' as const,commissionBasis:'CORRECTED_BM_COMMISSION' as const,
    commissionGross:decimal(cents(a.commissionGross)-cents(fact.recordedAmount)),beneficiary:a.beneficiary,coverage:a.coverage,agreement:a.agreement,
    originalCommissionGross:a.commissionGross,originalAnchorChecksum:a.checksum,originalSourceChecksum:originalChecksum,baseline:n.baseline,
    correctionFactId:fact.id,correctionFactChecksum:hash(factBody),ledgerCorrectionId:event.id,signedAmount:signed,lineageChecksum:lineage.checksum});
  return Object.freeze({...body,checksumAlgorithm:'SHA-256' as const,checksum:hash(body)});
}

/** Finance read only; no tax treatment, corrected approval or financial write is inferred here. */
export async function readHandymanBmCorrectedCommissionSource(actorInput:string,input:ReadBmCorrectionSourceInput):Promise<BmCorrectedCommissionSource> {
  const actor=uuid(actorInput,'actor'),n=normalizeSourceInput(input),tx=await getPool().connect();
  try {await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const result=await sourceInSnapshot(tx,actor,n);
    await tx.query('COMMIT');return result;
  } catch(error) {await tx.query('ROLLBACK').catch(()=>undefined);throw error;} finally {tx.release();}
}

type Intent=ReturnType<typeof normalizeBmTaxCaseIntent>;
function correctionSnapshot(n:Intent,source:BmCorrectedCommissionSource,actor:string,id:string,v:number,previous:string|null):BmCorrectionTaxSnapshot {
  const intentDigest=hash({schema:'HANDYMAN_BM_CORRECTION_TAX_INTENT_V1',actor,correctionFactId:source.correctionFactId,
    baseline:source.baseline,...n});
  const base=buildBmTaxCaseSnapshot(n,source,actor,id,v,previous,intentDigest);
  return {...base,schema:'HANDYMAN_BM_CORRECTION_TAX_CASE_V1',commissionBasis:'CORRECTED_BM_COMMISSION',
    ppnLegalReference:base.schema==='HANDYMAN_BM_TAX_CASE_V2'?base.ppnLegalReference:null,
    ppnLegalSource:base.schema==='HANDYMAN_BM_TAX_CASE_V2'?base.ppnLegalSource:null,
    pphLegalReference:base.schema==='HANDYMAN_BM_TAX_CASE_V2'?base.pphLegalReference:null,
    pphLegalSource:base.schema==='HANDYMAN_BM_TAX_CASE_V2'?base.pphLegalSource:null,
    correctionFactId:source.correctionFactId,correctionFactChecksum:source.correctionFactChecksum,ledgerCorrectionId:source.ledgerCorrectionId,
    signedAmount:source.signedAmount,originalCommissionGross:source.originalCommissionGross,originalAnchorChecksum:source.originalAnchorChecksum,
    originalSourceChecksum:source.originalSourceChecksum,lineageChecksum:source.lineageChecksum,
    baselineCaseId:source.baseline.caseId,baselineCaseVersion:source.baseline.version,baselineCaseDigest:source.baseline.digest,
    baselineDecisionId:source.baseline.decisionId,baselineDecisionDigest:source.baseline.decisionDigest,intent:n};
}
function view(row:Record<string,any>,replayed=false):BmCorrectionTaxView {
  const s=row.snapshot as BmCorrectionTaxSnapshot;
  if(!s || s.schema!=='HANDYMAN_BM_CORRECTION_TAX_CASE_V1' || row.digest!==hash(s) || s.id!==row.id || s.version!==row.version ||
    s.correctionFactId!==row.correction_id || s.entitlementId!==row.entitlement_id || s.clientId!==row.client_id ||
    s.buildingId!==row.building_id || s.previousCaseId!==row.previous_case_id || s.createdByUserId!==row.created_by_user_id ||
    s.idempotencyKey!==row.idempotency_key) throw integrity();
  return Object.freeze({snapshot:Object.freeze(s),digestAlgorithm:'SHA-256',digest:row.digest,createdAt:iso(row.created_at),replayed});
}
function decision(row:Record<string,any>,replayed=false):BmCorrectionTaxDecision {
  const body={id:row.id,caseId:row.case_id,clientId:row.client_id,buildingId:row.building_id,entitlementId:row.entitlement_id,
    correctionFactId:row.correction_id,version:row.version,caseDigest:row.case_digest,decision:row.decision as 'APPROVE'|'REJECT',
    ppnReviewEvidenceReferenceId:row.ppn_evidence_id,pphReviewEvidenceReferenceId:row.pph_evidence_id,
    actorUserId:row.actor_user_id,occurredAt:iso(row.occurred_at)};
  if(hash(body)!==row.decision_digest) throw integrity();
  uuid(body.ppnReviewEvidenceReferenceId,'ppn review evidence');uuid(body.pphReviewEvidenceReferenceId,'pph review evidence');
  return Object.freeze({...body,decisionDigest:row.decision_digest,replayed});
}
function baselineOf(s:BmCorrectionTaxSnapshot):BmTaxCasePin {
  return normalizeBmTaxCasePin({caseId:s.baselineCaseId,version:s.baselineCaseVersion,digest:s.baselineCaseDigest,
    decisionId:s.baselineDecisionId,decisionDigest:s.baselineDecisionDigest});
}
function assertSnapshot(s:BmCorrectionTaxSnapshot,source:BmCorrectedCommissionSource):Intent {
  const n=normalizeBmTaxCaseIntent(s.intent);
  const expected=correctionSnapshot(n,source,s.createdByUserId,s.id,s.version,s.previousCaseId);
  if(stableJson(expected)!==stableJson(s) || n.sourceChecksum!==source.checksum) throw stale('Correction facts, tax points or the approved source have changed.');
  return n;
}

/** The exact existing identity, tax-rule, classification and rounding policies are re-resolved for each correction point. */
async function taxPolicy(tx:PoolClient,actor:string,n:Intent,source:BmCorrectedCommissionSource,readAt:string) {
  const pn=n.ppn,ph=n.pph,ppnPoint=normalizePpnTaxPoint(pn.taxDate,pn.taxPointAt),pphPoint=normalizePpnTaxPoint(ph.taxDate,ph.taxPointAt);
  if(Date.parse(ppnPoint.taxPointAt)<Date.parse(source.ledgerPostedAt) || Date.parse(pphPoint.taxPointAt)<Date.parse(source.ledgerPostedAt)) throw integrity();
  if(pn.supplier.owner.kind!=='BM_BENEFICIARY' || ph.beneficiary.owner.kind!=='BM_BENEFICIARY' ||
    pn.supplier.owner.counterpartyId!==source.beneficiary.counterpartyId || ph.beneficiary.owner.counterpartyId!==source.beneficiary.counterpartyId) throw integrity();
  const ppnBeneficiary=await requireApprovedIdentityAtInSnapshot(tx,actor,pn.supplier.owner,ppnPoint.taxPointAt);
  const ppnIssuer=await requireApprovedIdentityAtInSnapshot(tx,actor,pn.recipient.owner,ppnPoint.taxPointAt);
  const pphBeneficiary=await requireApprovedIdentityAtInSnapshot(tx,actor,ph.beneficiary.owner,pphPoint.taxPointAt);
  if(ppnBeneficiary.snapshot.verificationId!==source.beneficiary.verificationId || pphBeneficiary.snapshot.verificationId!==source.beneficiary.verificationId) throw integrity();
  let ppnInput:CalculateApprovedPpnInput|null=null,pphInput:CorrectedBmWithholdingInput|null=null;
  let ppnRule:Awaited<ReturnType<typeof resolveBmTaxCaseRuleAt>>|null=null,pphRule:Awaited<ReturnType<typeof resolveBmTaxCaseRuleAt>>|null=null;
  if(pn.applicability==='NOT_APPLICABLE') {
    validateApprovedPpnIdentityPin(pn.supplier,ppnBeneficiary,ppnPoint.taxPointAt,readAt);
    validateApprovedPpnIdentityPin(pn.recipient,ppnIssuer,ppnPoint.taxPointAt,readAt);
    if(ppnIdentityIdentifierClash(ppnBeneficiary,ppnIssuer)) throw integrity();
  } else {
    ppnInput={clientId:n.clientId,transactionContext:'BM_COMMISSION',currency:'IDR',sourceAmount:source.commissionGross,
      taxDate:pn.taxDate,taxPointAt:pn.taxPointAt,amountBasis:pn.amountBasis,applicability:pn.applicability,
      taxpayerClassification:pn.taxpayerClassification,supplier:pn.supplier,recipient:pn.recipient,rule:pn.rule};
    const zero=normalizePpnInput({...ppnInput,sourceAmount:'0.00'});
    ppnRule=await resolveBmTaxCaseRuleAt(tx,actor,n.clientId,'PPN',pn.taxDate,pn.taxPointAt,pn.taxpayerClassification,pn.rule,readAt);
    validatePpnFromResolved(zero,ppnBeneficiary,ppnIssuer,ppnRule,readAt);
  }
  if(ph.treatment==='NOT_APPLICABLE') validateApprovedPpnIdentityPin(ph.beneficiary,pphBeneficiary,pphPoint.taxPointAt,readAt);
  else {
    pphInput={clientId:n.clientId,entitlementId:n.entitlementId,sourceChecksum:source.checksum,currency:'IDR',
      commissionBasis:'CORRECTED_BM_COMMISSION',commissionGross:source.commissionGross,taxDate:ph.taxDate,taxPointAt:ph.taxPointAt,
      treatment:ph.treatment,taxpayerClassification:ph.taxpayerClassification,beneficiary:ph.beneficiary,rule:ph.rule};
    pphInput=normalizeCorrectedPphInput(pphInput);
    pphRule=await resolveBmTaxCaseRuleAt(tx,actor,n.clientId,'PPH_WITHHOLDING',ph.taxDate,ph.taxPointAt,ph.taxpayerClassification,ph.rule,readAt);
    validateBmCorrectedWithholdingFromResolved(pphInput,source,pphBeneficiary,pphRule,readAt);
  }
  return {ppnBeneficiary,ppnIssuer,pphBeneficiary,ppnInput,pphInput,ppnRule,pphRule,readAt};
}

function proposal(value:ProposeBmCorrectionTaxInput) {
  keys(value,['clientId','entitlementId','correctionFactId','baseline','sourceChecksum','transactionClassification','serviceClassification',
    'transactionEvidenceReferenceId','ppn','pph','expectedVersion','idempotencyKey'],'input');
  if(!value.ppn?.taxDate || !value.ppn.taxPointAt) throw err('HANDYMAN_BM_TAX_CASE_INVALID','Correction PPN tax date and tax point (ppn.taxDate/ppn.taxPointAt) are required.',400);
  if(!value.pph?.taxDate || !value.pph.taxPointAt) throw err('HANDYMAN_BM_TAX_CASE_INVALID','Correction PPh tax date and tax point (pph.taxDate/pph.taxPointAt) are required.',400);
  const {correctionFactId,baseline,...ordinary}=value;
  return {correctionFactId:uuid(correctionFactId,'correctionFactId'),baseline:normalizeBmTaxCasePin(baseline),n:normalizeBmTaxCaseIntent(ordinary)};
}

/** Maker assertion; both tax points and treatments remain unauthorized until a different Finance checker approves. */
export async function proposeHandymanBmCorrectionTaxCase(actorInput:string,input:ProposeBmCorrectionTaxInput):Promise<BmCorrectionTaxView> {
  const actor=uuid(actorInput,'actor'),{correctionFactId,baseline,n}=proposal(input);
  const intentDigest=hash({schema:'HANDYMAN_BM_CORRECTION_TAX_INTENT_V1',actor,correctionFactId,baseline,...n});
  try {return await withTransaction(async tx=>{
    await tx.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    const buildingId=await accessBmTaxCase(tx,actor,n.clientId,n.entitlementId,'maker');await lockBmTaxLedger(tx,n.entitlementId);
    const prior=(await tx.query('SELECT * FROM handyman_bm_correction_tax_cases WHERE correction_id=$1 AND idempotency_key=$2',
      [correctionFactId,n.idempotencyKey])).rows[0];
    if(prior){const result=view(prior,true);if(result.snapshot.intentDigest!==intentDigest || result.snapshot.createdByUserId!==actor) throw conflict();return result;}
    const latest=(await tx.query('SELECT * FROM handyman_bm_correction_tax_cases WHERE correction_id=$1 ORDER BY version DESC LIMIT 1',[correctionFactId])).rows[0];
    if(latest && (!(await tx.query('SELECT 1 FROM handyman_bm_correction_tax_decisions WHERE case_id=$1',[latest.id])).rowCount ||
      latest.client_id!==n.clientId || latest.entitlement_id!==n.entitlementId || latest.building_id!==buildingId)) throw conflict();
    if((latest?n.expectedVersion!==latest.version:n.expectedVersion!==null)) throw conflict();
    // Reuse 02D-A's checks while holding the ledger lock, without needing a second pool connection.
    const source=await sourceInSnapshot(tx,actor,{clientId:n.clientId,entitlementId:n.entitlementId,correctionFactId,baseline},true);
    if(source.checksum!==n.sourceChecksum || source.buildingId!==buildingId) throw stale('The pinned correction source is stale.');
    const s=correctionSnapshot(n,source,actor,randomUUID(),latest?latest.version+1:1,latest?.id??null);
    await lockBmTaxSources(tx,s);await taxPolicy(tx,actor,n,source,await readBmTaxNow(tx));
    const row=(await tx.query(`INSERT INTO handyman_bm_correction_tax_cases(id,correction_id,entitlement_id,client_id,building_id,version,
      previous_case_id,idempotency_key,snapshot,digest,created_by_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [s.id,correctionFactId,s.entitlementId,s.clientId,s.buildingId,s.version,s.previousCaseId,s.idempotencyKey,JSON.stringify(s),hash(s),actor])).rows[0];
    return view(row);
  });} catch(error){return dbError(error);}
}

/** Revalidates the correction and both tax treatments before independent approval. */
export async function decideHandymanBmCorrectionTaxCase(actorInput:string,input:DecideBmCorrectionTaxInput):Promise<BmCorrectionTaxDecision> {
  keys(input,['clientId','entitlementId','correctionFactId','caseId','version','digest','decision','ppnReviewEvidenceReferenceId','pphReviewEvidenceReferenceId'],'input');
  const actor=uuid(actorInput,'actor'),clientId=uuid(input.clientId,'clientId'),entitlementId=uuid(input.entitlementId,'entitlementId');
  const correctionFactId=uuid(input.correctionFactId,'correctionFactId'),caseId=uuid(input.caseId,'caseId'),v=version(input.version,'version');
  const d=digest(input.digest,'digest'),pn=uuid(input.ppnReviewEvidenceReferenceId,'ppn review evidence'),ph=uuid(input.pphReviewEvidenceReferenceId,'pph review evidence');
  if(input.decision!=='APPROVE' && input.decision!=='REJECT') throw invalid('decision');
  try{return await withTransaction(async tx=>{
    await tx.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    const buildingId=await accessBmTaxCase(tx,actor,clientId,entitlementId,'checker');await lockBmTaxLedger(tx,entitlementId);
    const prior=(await tx.query('SELECT * FROM handyman_bm_correction_tax_decisions WHERE case_id=$1',[caseId])).rows[0];
    if(prior){const result=decision(prior,true);
      if(result.clientId!==clientId || result.entitlementId!==entitlementId || result.correctionFactId!==correctionFactId || result.version!==v ||
        result.caseDigest!==d || result.actorUserId!==actor || result.decision!==input.decision || result.ppnReviewEvidenceReferenceId!==pn ||
        result.pphReviewEvidenceReferenceId!==ph) throw conflict();return result;}
    const row=(await tx.query('SELECT * FROM handyman_bm_correction_tax_cases WHERE correction_id=$1 ORDER BY version DESC LIMIT 1',[correctionFactId])).rows[0];
    if(!row || row.id!==caseId || row.version!==v || row.client_id!==clientId || row.entitlement_id!==entitlementId || row.building_id!==buildingId)
      throw stale('The correction tax case is no longer current.');
    const c=view(row),s=c.snapshot;if(c.digest!==d) throw integrity();
    if(s.createdByUserId===actor) throw new AppError({code:ERROR_CODES.PERMISSION_DENIED,statusCode:403,message:'A maker cannot decide their own correction tax case.'});
    if(input.decision==='APPROVE') {
      const source=await sourceInSnapshot(tx,actor,{clientId,entitlementId,correctionFactId,baseline:baselineOf(s)},true);
      const n=assertSnapshot(s,source);await lockBmTaxSources(tx,s);await taxPolicy(tx,actor,n,source,await readBmTaxNow(tx));
    }
    const inserted=(await tx.query(`INSERT INTO handyman_bm_correction_tax_decisions(id,case_id,correction_id,entitlement_id,client_id,building_id,
      version,case_digest,decision,ppn_evidence_id,pph_evidence_id,actor_user_id,decision_digest)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [randomUUID(),caseId,correctionFactId,entitlementId,clientId,buildingId,v,d,input.decision,pn,ph,actor,'0'.repeat(64)])).rows[0];
    return decision(inserted);
  });}catch(error){return dbError(error);}
}

/** Only the current correction-specific checker decision can authorize a read-only projection. */
export async function calculateHandymanBmCorrectedTaxProjection(actorInput:string,input:BmCorrectionTaxProjectionInput) {
  const tx=await getPool().connect();
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result=await calculateCorrectedComponents(tx,actorInput,input,false);
    await tx.query('COMMIT');return result;
  } catch(error) {await tx.query('ROLLBACK').catch(()=>undefined);throw error;} finally {tx.release();}
}

/** Internal posting path; all original and correction sources remain fenced through commit. */
export async function calculateHandymanBmCorrectedTaxProjectionInLockedTransaction(tx:PoolClient,actorInput:string,input:BmCorrectionTaxProjectionInput) {
  if(tx.getTransactionStatus()!=='T') throw integrity();
  const mode=(await tx.query(`SELECT current_setting('transaction_isolation') AS isolation,
    current_setting('transaction_read_only') AS read_only`)).rows[0];
  if(tx.getTransactionStatus()!=='T' || mode.isolation!=='read committed' || mode.read_only!=='off') throw integrity();
  keys(input,['clientId','entitlementId','correctionFactId','determination'],'input');
  await lockBmTaxPostingScopeAndLedger(tx,uuid(input.clientId,'clientId'),uuid(input.entitlementId,'entitlementId'));
  return calculateCorrectedComponents(tx,actorInput,input,true);
}

async function calculateCorrectedComponents(tx:PoolClient,actorInput:string,input:BmCorrectionTaxProjectionInput,locked:boolean) {
  keys(input,['clientId','entitlementId','correctionFactId','determination'],'input');
  const actor=uuid(actorInput,'actor'),clientId=uuid(input.clientId,'clientId'),entitlementId=uuid(input.entitlementId,'entitlementId');
  const correctionFactId=uuid(input.correctionFactId,'correctionFactId'),pin=normalizeBmTaxCasePin(input.determination);
    const buildingId=await accessBmTaxCase(tx,actor,clientId,entitlementId,'read');
    const row=(await tx.query('SELECT * FROM handyman_bm_correction_tax_cases WHERE correction_id=$1 ORDER BY version DESC LIMIT 1',[correctionFactId])).rows[0];
    if(!row || row.id!==pin.caseId || row.version!==pin.version || row.client_id!==clientId || row.entitlement_id!==entitlementId || row.building_id!==buildingId)
      throw stale('The pinned correction tax case is no longer current.');
    const dr=(await tx.query('SELECT * FROM handyman_bm_correction_tax_decisions WHERE case_id=$1',[pin.caseId])).rows[0];
    if(!dr) throw unapproved();
    const c=view(row),review=decision(dr),s=c.snapshot;
    if(locked) await lockBmTaxSources(tx,s);
    if(c.digest!==pin.digest || review.id!==pin.decisionId || review.decisionDigest!==pin.decisionDigest || review.caseId!==s.id ||
      review.caseDigest!==c.digest || review.correctionFactId!==correctionFactId || review.clientId!==clientId ||
      review.entitlementId!==entitlementId || review.buildingId!==buildingId || review.version!==s.version ||
      review.actorUserId===s.createdByUserId || Date.parse(review.occurredAt)<=Date.parse(c.createdAt)) throw integrity();
    const readAt=await readBmTaxNow(tx);
    if(review.decision!=='APPROVE' || Date.parse(review.occurredAt)>Date.parse(readAt)) throw unapproved();
    const source=await sourceInSnapshot(tx,actor,{clientId,entitlementId,correctionFactId,baseline:baselineOf(s)},locked);
    const n=assertSnapshot(s,source),resolved=await taxPolicy(tx,actor,n,source,readAt);
    const determination=Object.freeze({caseId:s.id,version:s.version,digest:c.digest,decisionId:review.id,decisionDigest:review.decisionDigest,
      makerUserId:s.createdByUserId,checkerUserId:review.actorUserId,occurredAt:review.occurredAt});
    // Preserve the original PPN whole-rupiah requirement, even for non-applicability.
    parsePpnWholeRupiah(source.commissionGross);
    const ppn=(()=>{
      if(n.ppn.applicability==='NOT_APPLICABLE') {
        const body=Object.freeze({schema:'HANDYMAN_VERIFIED_CORRECTED_BM_PPN_NOT_APPLICABLE_V1' as const,clientId,currency:'IDR' as const,
          taxDate:n.ppn.taxDate,taxPointAt:n.ppn.taxPointAt,applicability:'NOT_APPLICABLE' as const,sourceAmount:source.commissionGross,
          dppAmount:null,ppnRatePercent:null,ppnAmount:'0.00' as const,totalIncludingPpn:source.commissionGross,rounding:null,rule:null,
          supplier:ppnIdentityReference(resolved.ppnBeneficiary),recipient:ppnIdentityReference(resolved.ppnIssuer),
          nonApplicability:Object.freeze({legalReference:n.ppn.legalReference,legalSource:n.ppn.legalSource,
            evidenceReferenceId:n.ppn.evidenceReferenceId,reviewEvidenceReferenceId:review.ppnReviewEvidenceReferenceId,
            makerUserId:s.createdByUserId,checkerUserId:review.actorUserId}),source,determination,
          transactionPartyBinding:'VERIFIED_BM_CORRECTION_FINANCE_APPROVED' as const});
        return Object.freeze({...body,checksumAlgorithm:'SHA-256' as const,checksum:hash(body)});
      }
      if(!resolved.ppnInput || !resolved.ppnRule) throw integrity();
      const pure=calculatePpnFromResolved(normalizePpnInput(resolved.ppnInput),resolved.ppnBeneficiary,resolved.ppnIssuer,resolved.ppnRule,readAt);
      const {schema:_schema,transactionPartyBinding:_unverified,checksumAlgorithm:_algorithm,checksum:_checksum,...rest}=pure;
      const body=Object.freeze({...rest,schema:'HANDYMAN_VERIFIED_CORRECTED_BM_PPN_V1' as const,source,determination,
        transactionPartyBinding:'VERIFIED_BM_CORRECTION_FINANCE_APPROVED' as const});
      return Object.freeze({...body,checksumAlgorithm:'SHA-256' as const,checksum:hash(body)});
    })();
    const pph=(()=>{
      if(n.pph.treatment==='NOT_APPLICABLE') {
        const body=Object.freeze({schema:'HANDYMAN_VERIFIED_CORRECTED_BM_PPH_NOT_APPLICABLE_V1' as const,clientId,currency:'IDR' as const,
          taxDate:n.pph.taxDate,taxPointAt:n.pph.taxPointAt,commissionBasis:'CORRECTED_BM_COMMISSION' as const,
          commissionGross:source.commissionGross,treatment:'NOT_APPLICABLE' as const,taxableWithholdingBasis:null,ratePercent:null,
          pphWithheld:'0.00' as const,projectedNetCommission:source.commissionGross,rounding:null,rule:null,
          beneficiaryTaxIdentity:ppnIdentityReference(resolved.pphBeneficiary),
          nonApplicability:Object.freeze({legalReference:n.pph.legalReference,legalSource:n.pph.legalSource,
            evidenceReferenceId:n.pph.evidenceReferenceId,reviewEvidenceReferenceId:review.pphReviewEvidenceReferenceId,
            makerUserId:s.createdByUserId,checkerUserId:review.actorUserId}),source,determination,
          caseApplicability:'INDEPENDENTLY_FINANCE_APPROVED' as const,authority:'READ_ONLY_PROJECTION' as const});
        return Object.freeze({...body,checksumAlgorithm:'SHA-256' as const,checksum:hash(body)});
      }
      if(!resolved.pphInput || !resolved.pphRule) throw integrity();
      const pure=calculateBmCorrectedWithholdingFromResolved(resolved.pphInput,source,resolved.pphBeneficiary,resolved.pphRule,readAt);
      const {schema:_schema,caseApplicability:_unverified,checksumAlgorithm:_algorithm,checksum:_checksum,...rest}=pure;
      const body=Object.freeze({...rest,schema:'HANDYMAN_VERIFIED_CORRECTED_BM_PPH_V1' as const,determination,
        caseApplicability:'INDEPENDENTLY_FINANCE_APPROVED' as const});
      return Object.freeze({...body,checksumAlgorithm:'SHA-256' as const,checksum:hash(body)});
    })();
    const body=Object.freeze({schema:'HANDYMAN_CORRECTED_BM_COMMISSION_TAX_PROJECTION_V1' as const,
      authority:'READ_ONLY_PROJECTION' as const,currency:'IDR' as const,source,determination,
      signedRecordedCommissionImpact:source.signedAmount,commissionGross:source.commissionGross,
      ppnBasis:ppn.dppAmount,ppnAmount:ppn.ppnAmount,pphWithholdingBasis:pph.taxableWithholdingBasis,pphWithheld:pph.pphWithheld,
      netCommissionProjection:decimal(cents(source.commissionGross)+cents(ppn.ppnAmount)-cents(pph.pphWithheld)),ppn,pph});
    return Object.freeze({...body,checksumAlgorithm:'SHA-256' as const,checksum:hash(body)});
}
