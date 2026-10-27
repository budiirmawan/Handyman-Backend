import { randomUUID,timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { AppError,ERROR_CODES } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { assertBuildingScopedResourceAccess } from '../context-access';
import { createEvidenceStorage,evidenceStorageKey } from '../evidence/storage';
import { computeEvidenceSha256 } from '../evidence/evidence-integrity';
import { maskHandymanDocumentAccountNumber } from '../handyman-documents/handyman-document-bank.types';
import { permissionRepository } from '../permissions';
import { lockBmTaxPostingScopeAndLedger } from '../handyman-bm-tax-case/handyman-bm-tax-case.service';
import { calculateHandymanBmCommissionTaxProjectionInLockedTransaction } from '../handyman-bm-tax-projection/handyman-bm-tax-projection.service';
import { calculateHandymanBmCorrectedTaxProjectionInLockedTransaction } from '../handyman-bm-correction-tax/handyman-bm-correction-tax.service';
import { hash } from '../handyman-pph-calculation/handyman-pph-core';

type Scope=Readonly<{clientId:string;settlementId:string}>;
export type PrepareBmSettlementInput=Readonly<{clientId:string;entitlementId:string;ledgerEntryIds:readonly string[];
  bankVersionId:string;idempotencyKey:string;evidenceReference:string}>;
export type ApproveBmSettlementInput=Scope & Readonly<{settlementDigest:string;evidenceReference:string}>;
export type RecordBmSettlementPaymentInput=Scope & Readonly<{transferReference:string;amount:string;transferredAt:string;
  idempotencyKey:string;file:Readonly<{buffer:Buffer;mimeType:string}>}>;
export type VerifyBmSettlementPaymentInput=Scope & Readonly<{evidenceReadId:string;contentSha256:string;transferReference:string;
  amount:string;transferredAt:string;confirmedAccountNumber:string;attestedActualPayment:true;evidenceReference:string}>;

type ErrorKey='HANDYMAN_BM_SETTLEMENT_INVALID'|'HANDYMAN_BM_SETTLEMENT_NOT_FOUND'|'HANDYMAN_BM_SETTLEMENT_CONFLICT'|
  'HANDYMAN_BM_SETTLEMENT_STALE'|'HANDYMAN_BM_SETTLEMENT_EVIDENCE_UNAVAILABLE';
const err=(key:ErrorKey,message:string,statusCode=409)=>new AppError({code:ERROR_CODES[key],message,statusCode});
const invalid=(field:string)=>err('HANDYMAN_BM_SETTLEMENT_INVALID',`Invalid ${field}.`,400);
const missing=()=>err('HANDYMAN_BM_SETTLEMENT_NOT_FOUND','BM settlement not found in this Client.',404);
const conflict=()=>err('HANDYMAN_BM_SETTLEMENT_CONFLICT','BM settlement, payment, evidence or idempotency conflicts.');
const stale=()=>err('HANDYMAN_BM_SETTLEMENT_STALE','The authoritative commission ledger, beneficiary or approved bank version is stale.');
const unavailable=()=>err('HANDYMAN_BM_SETTLEMENT_EVIDENCE_UNAVAILABLE','Protected payment evidence is missing, unreadable or inconsistent.',503);
function dbError(e:unknown):never {
  if(e instanceof AppError) throw e;
  // Database errors may contain sensitive parameters; return no raw SQL detail.
  if(typeof (e as {code?:unknown})?.code==='string') throw conflict();
  throw e;
}
function keys(value:unknown,allowed:readonly string[]):void {
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(k=>!allowed.includes(k))) throw invalid('input');
}
function uuid(value:unknown,field:string):string {
  if(typeof value!=='string' || !isValidUuid(value) || /^(?:0{32}|1{32}|f{32})$/i.test(value.replaceAll('-',''))) throw invalid(field);
  return value.toLowerCase();
}
function text(value:unknown,field:string,max:number,min=1):string {
  if(typeof value!=='string' || /[\u0000-\u001f\u007f]/.test(value)) throw invalid(field);
  const v=value.trim();if(v.length<min || v.length>max) throw invalid(field);return v;
}
function evidence(value:unknown,field='evidenceReference'):string {
  const v=text(value,field,500,3);
  if(['unknown','none','unspecified','n/a','tbd','pending','null','default'].includes(v.toLowerCase())) throw invalid(field);
  return v;
}
function sha(value:unknown):string {if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw invalid('contentSha256');return value;}
function money(value:unknown):string {
  if(typeof value!=='string'||!/^(?:0|[1-9]\d{0,15})\.\d{2}$/.test(value)||value==='0.00')throw invalid('amount');return value;
}
function instant(value:unknown):string {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw invalid('transferredAt');
  const date=new Date(value);if(!Number.isFinite(date.getTime())||date.toISOString()!==value)throw invalid('transferredAt');return value;
}
function accountNumber(value:unknown):string {
  if(typeof value!=='string'||/[\u0000-\u001f\u007f]/.test(value))throw invalid('confirmedAccountNumber');
  const v=value.replace(/\s+/g,'');if(!/^[A-Za-z0-9-]{4,34}$/.test(v))throw invalid('confirmedAccountNumber');return v;
}
function noNumber(number:string,...values:string[]):void {
  if(values.some(v=>v.toUpperCase().includes(number.toUpperCase())))throw invalid('reference');
}
function validFile(file:RecordBmSettlementPaymentInput['file']) {
  keys(file,['buffer','mimeType']);
  if(!Buffer.isBuffer(file.buffer)||file.buffer.length<1||file.buffer.length>10485760||typeof file.mimeType!=='string') throw invalid('file');
  const b=file.buffer,m=file.mimeType;
  const ok=(m==='application/pdf' && b.subarray(0,5).toString('ascii')==='%PDF-') ||
    (m==='image/jpeg' && b.subarray(0,3).equals(Buffer.from([0xff,0xd8,0xff]))) ||
    (m==='image/png' && b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) ||
    (m==='image/webp' && b.subarray(0,4).toString('ascii')==='RIFF' && b.subarray(8,12).toString('ascii')==='WEBP');
  if(!ok)throw invalid('file');return {buffer:b,mimeType:m,sha:computeEvidenceSha256(b),size:b.length};
}
async function access(tx:PoolClient,actor:string,clientId:string,buildingId:string,mode:'maker'|'approver'|'verifier'|'read') {
  const user=(await tx.query('SELECT status FROM users WHERE id=$1',[actor])).rows[0];
  const perms=await permissionRepository.listActivePermissionCodesForUser(actor,tx);
  const required=mode==='maker'?['handyman.finance.read','handyman.finance.manage','handyman.settlement.manage']:
    mode==='approver'?['handyman.finance.read','handyman.bm_settlement.approve']:
    mode==='verifier'?['handyman.finance.read','handyman.bm_settlement.verify_payment']:['handyman.finance.read'];
  if(user?.status!=='ACTIVE'||required.some(p=>!perms.includes(p)))
    throw new AppError({code:ERROR_CODES.PERMISSION_DENIED,statusCode:403,message:'Explicit scoped Finance settlement authority is required.'});
  await assertBuildingScopedResourceAccess(actor,{clientId,buildingId},tx);
}
async function load(tx:PoolClient,actor:string,clientId:string,settlementId:string,mode:'maker'|'approver'|'verifier'|'read') {
  const s=(await tx.query(`SELECT s.*,b.bank_account_id,b.bank_code,b.bank_name,b.account_holder_name,b.account_number,b.version AS bank_version
    FROM handyman_bm_settlements s JOIN handyman_bm_bank_account_versions b ON b.id=s.bank_version_id
    WHERE s.id=$1 AND s.client_id=$2`,[settlementId,clientId])).rows[0];
  if(!s)throw missing();await access(tx,actor,clientId,s.building_id,mode);return s;
}
async function ledger(tx:PoolClient,actor:string,clientId:string,entitlementId:string) {
  await lockBmTaxPostingScopeAndLedger(tx,clientId,entitlementId);
  const entries=(await tx.query(`SELECT * FROM handyman_bm_commission_ledger WHERE entitlement_id=$1 ORDER BY sequence`,[entitlementId])).rows;
  if(!entries.length || entries.length>2)throw stale();const first=entries[0],last=entries[entries.length-1];
  if(first.sequence!==1||last.sequence!==entries.length||first.client_id!==clientId||last.client_id!==clientId||
    first.entitlement_id!==last.entitlement_id||first.counterparty_id!==last.counterparty_id||first.building_id!==last.building_id||
    first.currency!==last.currency||first.digest!==hash(first.snapshot)||last.digest!==hash(last.snapshot)||
    (entries.length===2 && last.previous_entry_id!==first.id))throw stale();
  try {
    const base={clientId,entitlementId,determination:last.snapshot.approval};
    const projection=last.correction_id?
      await calculateHandymanBmCorrectedTaxProjectionInLockedTransaction(tx,actor,{...base,correctionFactId:last.correction_id}):
      await calculateHandymanBmCommissionTaxProjectionInLockedTransaction(tx,actor,base);
    if(projection.checksum!==last.projection_checksum)throw stale();
  } catch(e) {
    if(e instanceof AppError && (e.code==='PERMISSION_DENIED'||e.code==='BUILDING_ACCESS_DENIED'))throw e;
    throw stale();
  }
  return entries;
}
async function fresh(tx:PoolClient,actor:string,s:any,currentBank:boolean) {
  await tx.query('SELECT hm_bm_settlement_lock(s) FROM handyman_bm_settlements s WHERE s.id=$1',[s.id]);
  const ok=(await tx.query('SELECT hm_bm_settlement_anchors_valid(s,$2) AS valid FROM handyman_bm_settlements s WHERE id=$1',[s.id,currentBank])).rows[0]?.valid;
  if(!ok)throw stale();const rows=await ledger(tx,actor,s.client_id,s.entitlement_id);
  if(rows[0].id!==s.original_entry_id||rows[rows.length-1].id!==s.latest_entry_id||
    rows[rows.length-1].net_payable!==s.net_payable||hash(s.snapshot)!==s.digest)throw stale();
}
async function publicView(tx:PoolClient,s:any) {
  const a=(await tx.query('SELECT * FROM handyman_bm_settlement_approvals WHERE settlement_id=$1',[s.id])).rows[0];
  const p=(await tx.query('SELECT * FROM handyman_bm_settlement_payments WHERE settlement_id=$1',[s.id])).rows[0];
  const v=(await tx.query('SELECT * FROM handyman_bm_settlement_verifications WHERE settlement_id=$1',[s.id])).rows[0];
  return Object.freeze({snapshot:s.snapshot,digest:s.digest,status:(v?'SETTLED':p?'PAYMENT_RECORDED':a?'APPROVED':'PREPARED') as
    'PREPARED'|'APPROVED'|'PAYMENT_RECORDED'|'SETTLED',createdAt:(s.created_at as Date).toISOString(),
    bank:Object.freeze({versionId:s.bank_version_id,decisionId:s.bank_decision_id,bankAccountId:s.bank_account_id,
      bankCode:s.bank_code,bankName:s.bank_name,accountHolderName:s.account_holder_name,
      accountNumberMasked:maskHandymanDocumentAccountNumber(s.account_number),version:s.bank_version,bankVerificationStatus:'NOT_VERIFIED_BY_SYSTEM' as const}),
    approval:a?Object.freeze({id:a.id,actorUserId:a.actor_user_id,evidenceReference:a.evidence_reference,occurredAt:(a.occurred_at as Date).toISOString()}):null,
    payment:p?Object.freeze({id:p.id,transferReference:p.transfer_reference,amount:p.amount,currency:p.currency,
      transferredAt:(p.transferred_at as Date).toISOString(),evidenceId:p.evidence_id,recordedByUserId:p.recorded_by_user_id,
      occurredAt:(p.occurred_at as Date).toISOString()}):null,
    verification:v?Object.freeze({id:v.id,actorUserId:v.actor_user_id,method:v.method,evidenceReference:v.evidence_reference,
      occurredAt:(v.occurred_at as Date).toISOString()}):null});
}
async function stored(p:any):Promise<Buffer> {
  try {
    const data=await createEvidenceStorage().get(evidenceStorageKey(p.evidence_id));
    if(data.size!==p.file_size||data.buffer.length!==p.file_size||computeEvidenceSha256(data.buffer)!==p.content_sha256)throw unavailable();
    return data.buffer;
  }catch{throw unavailable();}
}

/** One entitlement per immutable settlement; every original/correction ledger entry is pinned. */
export async function prepareHandymanBmSettlement(actorInput:string,input:PrepareBmSettlementInput) {
  keys(input,['clientId','entitlementId','ledgerEntryIds','bankVersionId','idempotencyKey','evidenceReference']);
  const actor=uuid(actorInput,'actorUserId'),clientId=uuid(input.clientId,'clientId'),entitlementId=uuid(input.entitlementId,'entitlementId');
  const bankVersionId=uuid(input.bankVersionId,'bankVersionId'),key=text(input.idempotencyKey,'idempotencyKey',200),audit=evidence(input.evidenceReference);
  if(!Array.isArray(input.ledgerEntryIds)||input.ledgerEntryIds.length<1||input.ledgerEntryIds.length>2)throw invalid('ledgerEntryIds');
  const ids=input.ledgerEntryIds.map(v=>uuid(v,'ledgerEntryIds'));if(new Set(ids).size!==ids.length)throw invalid('ledgerEntryIds');
  try{return await withTransaction(async tx=>{
    await tx.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    const f=(await tx.query(`SELECT f.agreement_version_id,x.building_id FROM handyman_entitlement_facts f
      JOIN handyman_execution_scopes x ON x.id=f.execution_scope_id AND x.client_id=f.client_id
      WHERE f.id=$1 AND f.client_id=$2 AND f.entitlement_kind='BM_FEE'`,[entitlementId,clientId])).rows[0];
    if(!f)throw missing();await access(tx,actor,clientId,f.building_id,'maker');
    await lockBmTaxPostingScopeAndLedger(tx,clientId,entitlementId);
    const prior=(await tx.query('SELECT id FROM handyman_bm_settlements WHERE client_id=$1 AND idempotency_key=$2',[clientId,key])).rows[0];
    if(prior){const s=await load(tx,actor,clientId,prior.id,'maker');
      if(s.entitlement_id!==entitlementId||s.created_by_user_id!==actor||s.bank_version_id!==bankVersionId||s.evidence_reference!==audit||
        JSON.stringify(s.snapshot.ledgerEntries.map((e:any)=>e.id))!==JSON.stringify(ids))throw conflict();
      return {settlement:await publicView(tx,s),replayed:true};}
    const rows=await ledger(tx,actor,clientId,entitlementId),last=rows[rows.length-1];
    if(JSON.stringify(ids)!==JSON.stringify(rows.map(r=>r.id))||last.net_payable==='0.00')throw stale();
    const bank=(await tx.query(`SELECT b.*,d.id AS decision_id FROM handyman_bm_bank_account_versions b
      JOIN handyman_bm_bank_account_decisions d ON d.proposal_id=b.id AND d.decision='APPROVE'
      WHERE b.id=$1 AND b.client_id=$2 AND b.counterparty_id=$3`,[bankVersionId,clientId,last.counterparty_id])).rows[0];
    if(!bank||bank.currency!==last.currency||bank.proposed_status!=='ACTIVE')throw stale();noNumber(bank.account_number,audit,key);
    const id=randomUUID(),snapshot={schema:'HANDYMAN_BM_SETTLEMENT_V1',id,clientId,buildingId:f.building_id,counterpartyId:last.counterparty_id,
      entitlementId,agreementVersionId:f.agreement_version_id,bankVersionId,bankDecisionId:bank.decision_id,
      ledgerEntries:rows.map(r=>({id:r.id,digest:r.digest})),currency:last.currency,netPayable:last.net_payable,
      pphWithholdingProjection:last.pph_withholding_projection,assertions:{withholding:'NOT_ASSERTED',remittance:'NOT_ASSERTED'},
      createdByUserId:actor,idempotencyKey:key,evidenceReference:audit};
    await tx.query(`INSERT INTO handyman_bm_settlements(id,client_id,building_id,counterparty_id,entitlement_id,agreement_version_id,
      original_entry_id,latest_entry_id,bank_version_id,bank_decision_id,currency,net_payable,snapshot,digest,idempotency_key,evidence_reference,created_by_user_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [id,clientId,f.building_id,last.counterparty_id,entitlementId,f.agreement_version_id,rows[0].id,last.id,bankVersionId,bank.decision_id,
        last.currency,last.net_payable,JSON.stringify(snapshot),hash(snapshot),key,audit,actor]);
    return {settlement:await publicView(tx,await load(tx,actor,clientId,id,'maker')),replayed:false};
  });}catch(e){return dbError(e);}
}

export async function approveHandymanBmSettlement(actorInput:string,input:ApproveBmSettlementInput) {
  keys(input,['clientId','settlementId','settlementDigest','evidenceReference']);const actor=uuid(actorInput,'actorUserId'),clientId=uuid(input.clientId,'clientId');
  const settlementId=uuid(input.settlementId,'settlementId'),digest=sha(input.settlementDigest),audit=evidence(input.evidenceReference);
  try{return await withTransaction(async tx=>{
    await tx.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');const s=await load(tx,actor,clientId,settlementId,'approver');
    await fresh(tx,actor,s,true);if(s.created_by_user_id===actor||s.digest!==digest)throw conflict();noNumber(s.account_number,audit);
    const prior=(await tx.query('SELECT * FROM handyman_bm_settlement_approvals WHERE settlement_id=$1',[s.id])).rows[0];
    if(prior){if(prior.actor_user_id!==actor||prior.settlement_digest!==digest||prior.evidence_reference!==audit)throw conflict();
      return {settlement:await publicView(tx,s),replayed:true};}
    await tx.query('INSERT INTO handyman_bm_settlement_approvals(id,settlement_id,settlement_digest,evidence_reference,actor_user_id) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(),s.id,digest,audit,actor]);return {settlement:await publicView(tx,s),replayed:false};
  });}catch(e){return dbError(e);}
}

/** Records a manual transfer claim with stored bytes. This does not settle or verify a payment. */
export async function recordHandymanBmSettlementPayment(actorInput:string,input:RecordBmSettlementPaymentInput) {
  keys(input,['clientId','settlementId','transferReference','amount','transferredAt','idempotencyKey','file']);
  const actor=uuid(actorInput,'actorUserId'),clientId=uuid(input.clientId,'clientId'),settlementId=uuid(input.settlementId,'settlementId');
  const reference=text(input.transferReference,'transferReference',200,3),amount=money(input.amount),at=instant(input.transferredAt);
  const key=text(input.idempotencyKey,'idempotencyKey',200),file=validFile(input.file);
  try{return await withTransaction(async tx=>{
    await tx.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');const s=await load(tx,actor,clientId,settlementId,'maker');await fresh(tx,actor,s,true);
    noNumber(s.account_number,reference,key);if(amount!==s.net_payable)throw conflict();
    const approval=(await tx.query('SELECT * FROM handyman_bm_settlement_approvals WHERE settlement_id=$1',[s.id])).rows[0];
    if(!approval||Date.parse(at)<approval.occurred_at.getTime()||Date.parse(at)>Date.now())throw conflict();
    const prior=(await tx.query('SELECT * FROM handyman_bm_settlement_payments WHERE settlement_id=$1',[s.id])).rows[0];
    if(prior){if(prior.recorded_by_user_id!==actor||prior.idempotency_key!==key||prior.transfer_reference!==reference||prior.amount!==amount||
      prior.transferred_at.toISOString()!==at||prior.content_sha256!==file.sha||prior.mime_type!==file.mimeType||prior.file_size!==file.size)throw conflict();
      await stored(prior);return {settlement:await publicView(tx,s),replayed:true};}
    const evidenceId=randomUUID(),storage=createEvidenceStorage(),storageKey=evidenceStorageKey(evidenceId);
    try {await storage.put(storageKey,{buffer:file.buffer,mimeType:file.mimeType});
      const check=await storage.get(storageKey);if(check.size!==file.size||check.buffer.length!==file.size||computeEvidenceSha256(check.buffer)!==file.sha)throw unavailable();
    }catch{throw unavailable();}
    // No eager removal on rollback: an ambiguous DB commit must never delete recorded evidence.
    await tx.query(`INSERT INTO handyman_bm_settlement_payments(id,settlement_id,client_id,approval_id,transfer_reference,amount,currency,
      transferred_at,evidence_id,storage_key,content_sha256,file_size,mime_type,idempotency_key,recorded_by_user_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [randomUUID(),s.id,clientId,approval.id,reference,amount,s.currency,at,evidenceId,storageKey,file.sha,file.size,file.mimeType,key,actor]);
    return {settlement:await publicView(tx,s),replayed:false};
  });}catch(e){return dbError(e);}
}

/** Authorized verifier gets the actual protected bytes, not a caller-supplied URL or metadata-only claim. */
export async function readHandymanBmSettlementEvidence(actorInput:string,input:Scope) {
  keys(input,['clientId','settlementId']);const actor=uuid(actorInput,'actorUserId'),clientId=uuid(input.clientId,'clientId'),settlementId=uuid(input.settlementId,'settlementId');
  try{return await withTransaction(async tx=>{
    await tx.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');const s=await load(tx,actor,clientId,settlementId,'verifier');await fresh(tx,actor,s,false);
    const p=(await tx.query('SELECT * FROM handyman_bm_settlement_payments WHERE settlement_id=$1',[s.id])).rows[0];
    if(!p||actor===s.created_by_user_id||actor===p.recorded_by_user_id)throw conflict();
    const buffer=await stored(p),readId=randomUUID();
    await tx.query('INSERT INTO handyman_bm_settlement_evidence_reads(id,payment_id,actor_user_id,content_sha256) VALUES($1,$2,$3,$4)',
      [readId,p.id,actor,p.content_sha256]);
    return {evidenceReadId:readId,contentSha256:p.content_sha256,mimeType:p.mime_type,buffer,settlement:await publicView(tx,s)};
  });}catch(e){return dbError(e);}
}

/** A human Finance reviewer attests an actual document and exact transfer; this is not bank-origin verification. */
export async function verifyHandymanBmSettlementPayment(actorInput:string,input:VerifyBmSettlementPaymentInput) {
  keys(input,['clientId','settlementId','evidenceReadId','contentSha256','transferReference','amount','transferredAt',
    'confirmedAccountNumber','attestedActualPayment','evidenceReference']);
  const actor=uuid(actorInput,'actorUserId'),clientId=uuid(input.clientId,'clientId'),settlementId=uuid(input.settlementId,'settlementId');
  const readId=uuid(input.evidenceReadId,'evidenceReadId'),checksum=sha(input.contentSha256),reference=text(input.transferReference,'transferReference',200,3);
  const amount=money(input.amount),at=instant(input.transferredAt),number=accountNumber(input.confirmedAccountNumber),audit=evidence(input.evidenceReference);
  if(input.attestedActualPayment!==true)throw invalid('attestedActualPayment');
  try{return await withTransaction(async tx=>{
    await tx.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');const s=await load(tx,actor,clientId,settlementId,'verifier');await fresh(tx,actor,s,false);
    const p=(await tx.query('SELECT * FROM handyman_bm_settlement_payments WHERE settlement_id=$1',[s.id])).rows[0];
    if(!p||actor===s.created_by_user_id||actor===p.recorded_by_user_id)throw conflict();noNumber(s.account_number,audit,reference);
    const actual=Buffer.from(s.account_number),submitted=Buffer.from(number);
    if(actual.length!==submitted.length||!timingSafeEqual(actual,submitted)||p.transfer_reference!==reference||p.amount!==amount||
      p.transferred_at.toISOString()!==at||p.content_sha256!==checksum)throw conflict();
    const r=(await tx.query('SELECT * FROM handyman_bm_settlement_evidence_reads WHERE id=$1 AND payment_id=$2 AND actor_user_id=$3',
      [readId,p.id,actor])).rows[0];if(!r||r.content_sha256!==checksum)throw conflict();await stored(p);
    const prior=(await tx.query('SELECT * FROM handyman_bm_settlement_verifications WHERE settlement_id=$1',[s.id])).rows[0];
    if(prior){if(prior.actor_user_id!==actor||prior.payment_id!==p.id||prior.evidence_read_id!==readId||prior.content_sha256!==checksum||
      prior.evidence_reference!==audit)throw conflict();return {settlement:await publicView(tx,s),replayed:true};}
    await tx.query(`INSERT INTO handyman_bm_settlement_verifications(id,settlement_id,payment_id,evidence_read_id,content_sha256,evidence_reference,method,actor_user_id)
      VALUES($1,$2,$3,$4,$5,$6,'FINANCE_MANUAL_DOCUMENT_REVIEW',$7)`,[randomUUID(),s.id,p.id,readId,checksum,audit,actor]);
    return {settlement:await publicView(tx,s),replayed:false};
  });}catch(e){return dbError(e);}
}
export async function getHandymanBmSettlement(actorInput:string,input:Scope) {
  keys(input,['clientId','settlementId']);const actor=uuid(actorInput,'actorUserId'),clientId=uuid(input.clientId,'clientId'),settlementId=uuid(input.settlementId,'settlementId');
  return withTransaction(async tx=>publicView(tx,await load(tx,actor,clientId,settlementId,'read')));
}
