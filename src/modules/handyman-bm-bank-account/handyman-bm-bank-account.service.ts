import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { buildingAccessDeniedError, canAccessClient } from '../context-access';
import { maskHandymanDocumentAccountNumber } from '../handyman-documents/handyman-document-bank.types';
import { permissionRepository } from '../permissions';

type Status='ACTIVE'|'SUSPENDED';
type Decision='APPROVE'|'REJECT';
type Scope=Readonly<{clientId:string;counterpartyId:string}>;
export type ProposeBmBankAccountInput=Scope & Readonly<{
  bankAccountId:string|null; expectedVersion:number|null; bankCode:string; bankName:string; accountNumber:string;
  accountHolderName:string; currency:string; verificationReference:string; isDefault:boolean;
  evidenceReference:string; idempotencyKey:string;
}>;
export type ProposeBmBankAccountStateInput=Scope & Readonly<{
  bankAccountId:string; expectedVersion:number; status:Status; isDefault:boolean; evidenceReference:string; idempotencyKey:string;
}>;
export type DecideBmBankAccountInput=Scope & Readonly<{
  proposalId:string; version:number; decision:Decision; evidenceReference:string;
}>;

type Code='HANDYMAN_BM_BANK_INVALID'|'HANDYMAN_BM_BANK_NOT_FOUND'|'HANDYMAN_BM_BANK_UNVERIFIED_BENEFICIARY'|
  'HANDYMAN_BM_BANK_CONFLICT'|'HANDYMAN_BM_BANK_CHECKER_REQUIRED';
const error=(code:Code,message:string,statusCode=409)=>new AppError({code:ERROR_CODES[code],message,statusCode});
const invalid=(field:string)=>error('HANDYMAN_BM_BANK_INVALID',`Invalid ${field}.`,400);
const missing=()=>error('HANDYMAN_BM_BANK_NOT_FOUND','The BM bank account was not found in this Client and beneficiary.',404);
const unverified=()=>error('HANDYMAN_BM_BANK_UNVERIFIED_BENEFICIARY','An exact verified BM legal beneficiary and active Client are required.');
const conflict=()=>error('HANDYMAN_BM_BANK_CONFLICT','The BM bank account version, default or idempotency key conflicts.');
const checkerRequired=()=>error('HANDYMAN_BM_BANK_CHECKER_REQUIRED','An independent authorized checker must review the exact proposal.',403);
function dbError(err:unknown):never {
  if(err instanceof AppError) throw err;
  // Never return SQL detail or parameters: they may include an account number.
  if(typeof (err as {code?:unknown})?.code==='string') throw conflict();
  throw err;
}
function keys(value:unknown,allowed:readonly string[],field='input'):void {
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(k=>!allowed.includes(k))) throw invalid(field);
}
function uuid(value:unknown,field:string):string {
  if(typeof value!=='string' || !isValidUuid(value) || /^(?:0{32}|1{32}|f{32})$/i.test(value.replaceAll('-',''))) throw invalid(field);
  return value.toLowerCase();
}
function text(value:unknown,field:string,max:number,min=1):string {
  if(typeof value!=='string' || /[\u0000-\u001f\u007f]/.test(value)) throw invalid(field);
  const result=value.trim();
  if(result.length<min || result.length>max) throw invalid(field);
  return result;
}
function evidence(value:unknown,field:string,max:number):string {
  const result=text(value,field,max,3);
  if(['unknown','none','unspecified','n/a','na','tbd','pending','null','default'].includes(result.toLowerCase())) throw invalid(field);
  return result;
}
function version(value:unknown,field='version'):number {
  if(!Number.isSafeInteger(value) || (value as number)<1 || (value as number)>2147483647) throw invalid(field);
  return value as number;
}
function scope(value:Scope):Scope {return {clientId:uuid(value.clientId,'clientId'),counterpartyId:uuid(value.counterpartyId,'counterpartyId')};}
function preventNumberDisclosure(number:string,...values:string[]):void {
  if(values.some(value=>value.toUpperCase().includes(number.toUpperCase()))) throw invalid('evidence or account description');
}
async function access(tx:PoolClient,actor:string,clientId:string,mode:'read'|'maker'|'checker'):Promise<void> {
  const user=(await tx.query('SELECT status FROM users WHERE id=$1',[actor])).rows[0];
  const permissions=await permissionRepository.listActivePermissionCodesForUser(actor,tx);
  if(user?.status!=='ACTIVE' || !permissions.includes('handyman.finance.read') ||
    (mode==='maker' && (!permissions.includes('handyman.finance.manage') || !permissions.includes('handyman.bm_bank_account.manage'))) ||
    (mode==='checker' && !permissions.includes('handyman.bm_bank_account.approve')))
    throw new AppError({code:ERROR_CODES.PERMISSION_DENIED,statusCode:403,message:'Explicit scoped BM bank account authority is required.'});
  if(!(await canAccessClient(actor,clientId,tx))) throw buildingAccessDeniedError();
}
async function lockBeneficiary(tx:PoolClient,s:Scope) {
  const r=(await tx.query(`SELECT p.id,proof.id AS verification_id FROM handyman_bm_legal_counterparties p
    JOIN clients c ON c.id=p.client_id LEFT JOIN handyman_bm_counterparty_verifications proof ON proof.counterparty_id=p.id
    WHERE p.id=$1 AND p.client_id=$2 AND c.status='ACTIVE' FOR UPDATE OF p`,[s.counterpartyId,s.clientId])).rows[0];
  if(!r?.verification_id) throw unverified();
  const proof=(await tx.query('SELECT verified_at<=clock_timestamp() AS valid FROM handyman_bm_counterparty_verifications WHERE id=$1',[r.verification_id])).rows[0];
  if(!proof?.valid) throw unverified();
  return r.verification_id as string;
}
async function latest(tx:PoolClient,accountId:string,s:Scope) {
  const row=(await tx.query(`SELECT * FROM handyman_bm_bank_account_versions WHERE bank_account_id=$1 ORDER BY version DESC LIMIT 1`,[accountId])).rows[0];
  if(!row || row.client_id!==s.clientId || row.counterparty_id!==s.counterpartyId) throw missing();
  return row;
}
async function current(tx:PoolClient,accountId:string,s:Scope) {
  return (await tx.query(`SELECT v.* FROM handyman_bm_bank_account_versions v JOIN handyman_bm_bank_account_decisions d
    ON d.proposal_id=v.id AND d.decision='APPROVE' WHERE v.bank_account_id=$1 AND v.client_id=$2 AND v.counterparty_id=$3
    ORDER BY v.version DESC LIMIT 1`,[accountId,s.clientId,s.counterpartyId])).rows[0]??null;
}
async function assertNext(tx:PoolClient,row:any,expected:number):Promise<void> {
  if(row.version!==expected || !(await tx.query('SELECT id FROM handyman_bm_bank_account_decisions WHERE proposal_id=$1',[row.id])).rowCount) throw conflict();
}
function publicVersion(row:any) {
  return Object.freeze({id:row.id as string,bankAccountId:row.bank_account_id as string,clientId:row.client_id as string,
    counterpartyId:row.counterparty_id as string,beneficiaryVerificationId:row.beneficiary_verification_id as string,
    version:row.version as number,previousVersionId:row.previous_version_id as string|null,proposalType:row.proposal_type as 'CONTENT'|'STATE',
    bankCode:row.bank_code as string,bankName:row.bank_name as string,accountNumberMasked:maskHandymanDocumentAccountNumber(row.account_number),
    accountHolderName:row.account_holder_name as string,currency:row.currency as string,proposedStatus:row.proposed_status as Status,
    isDefault:row.is_default as boolean,verificationReference:row.verification_reference as string,
    // A reference and an internal checker are not bank-origin verification.
    bankVerificationStatus:'NOT_VERIFIED_BY_SYSTEM' as const,evidenceReference:row.evidence_reference as string,
    createdByUserId:row.created_by_user_id as string,createdAt:(row.created_at as Date).toISOString(),
    reviewStatus:(row.decision==='APPROVE'?'APPROVED':row.decision==='REJECT'?'REJECTED':'PENDING_REVIEW') as 'APPROVED'|'REJECTED'|'PENDING_REVIEW',
    decision:row.decision_id?Object.freeze({id:row.decision_id as string,decision:row.decision as Decision,
      actorUserId:row.checker_id as string,evidenceReference:row.checker_evidence as string,occurredAt:(row.decision_at as Date).toISOString()}):null});
}
async function view(tx:PoolClient,id:string) {
  const r=(await tx.query(`SELECT v.*,d.id AS decision_id,d.decision,d.actor_user_id AS checker_id,
    d.evidence_reference AS checker_evidence,d.occurred_at AS decision_at FROM handyman_bm_bank_account_versions v
    LEFT JOIN handyman_bm_bank_account_decisions d ON d.proposal_id=v.id WHERE v.id=$1`,[id])).rows[0];
  if(!r) throw missing();return publicVersion(r);
}
function contentInput(input:ProposeBmBankAccountInput) {
  keys(input,['clientId','counterpartyId','bankAccountId','expectedVersion','bankCode','bankName','accountNumber',
    'accountHolderName','currency','verificationReference','isDefault','evidenceReference','idempotencyKey']);
  const s=scope(input),accountId=input.bankAccountId===null?null:uuid(input.bankAccountId,'bankAccountId');
  const expected=input.expectedVersion===null?null:version(input.expectedVersion,'expectedVersion');
  if((accountId===null)!==(expected===null)) throw invalid('expectedVersion');
  const bankCode=text(input.bankCode,'bankCode',16).toUpperCase(),currency=text(input.currency,'currency',3).toUpperCase();
  const bankName=text(input.bankName,'bankName',200),holder=text(input.accountHolderName,'accountHolderName',200);
  if(typeof input.accountNumber!=='string' || /[\u0000-\u001f\u007f]/.test(input.accountNumber)) throw invalid('accountNumber');
  const number=input.accountNumber.replace(/\s+/g,'');
  if(!/^[A-Z][A-Z0-9]{1,15}$/.test(bankCode) || !/^[A-Z]{3}$/.test(currency) ||
    !/^[A-Za-z0-9-]{4,34}$/.test(number) || !/[0-9]/.test(number) || !/[A-Za-z0-9]/.test(bankName) || !/[A-Za-z0-9]/.test(holder) ||
    typeof input.isDefault!=='boolean') throw invalid('bank account details');
  const reference=evidence(input.verificationReference,'verificationReference',300),audit=evidence(input.evidenceReference,'evidenceReference',500);
  preventNumberDisclosure(number,bankCode,bankName,holder,reference,audit);
  return {...s,accountId,expected,bankCode,bankName,number,holder,currency,reference,isDefault:input.isDefault,
    audit,key:text(input.idempotencyKey,'idempotencyKey',200)};
}

/** Submit complete account content; nothing becomes ACTIVE until a different checker approves. */
export async function proposeHandymanBmBankAccount(actorInput:string,input:ProposeBmBankAccountInput) {
  const actor=uuid(actorInput,'actorUserId'),n=contentInput(input);
  try{return await withTransaction(async tx=>{
    await tx.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');await access(tx,actor,n.clientId,'maker');
    const proof=await lockBeneficiary(tx,n);
    const prior=(await tx.query('SELECT * FROM handyman_bm_bank_account_versions WHERE counterparty_id=$1 AND idempotency_key=$2',[n.counterpartyId,n.key])).rows[0];
    if(prior) {
      if(prior.client_id!==n.clientId || prior.created_by_user_id!==actor || prior.proposal_type!=='CONTENT' ||
        (n.accountId===null?prior.version!==1:prior.bank_account_id!==n.accountId || prior.version!==n.expected!+1) ||
        prior.bank_code!==n.bankCode || prior.bank_name!==n.bankName || prior.account_number!==n.number || prior.account_holder_name!==n.holder ||
        prior.currency!==n.currency || prior.verification_reference!==n.reference || prior.is_default!==n.isDefault || prior.evidence_reference!==n.audit) throw conflict();
      return {proposal:await view(tx,prior.id),replayed:true};
    }
    const old=n.accountId?await latest(tx,n.accountId,n):null;
    if(old) await assertNext(tx,old,n.expected!);
    const id=randomUUID(),accountId=n.accountId??id;
    await tx.query(`INSERT INTO handyman_bm_bank_account_versions(id,bank_account_id,client_id,counterparty_id,beneficiary_verification_id,
      version,previous_version_id,proposal_type,bank_code,bank_name,account_number,account_holder_name,currency,proposed_status,is_default,
      verification_reference,evidence_reference,idempotency_key,created_by_user_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,'CONTENT',$8,$9,$10,$11,$12,'ACTIVE',$13,$14,$15,$16,$17)`,
      [id,accountId,n.clientId,n.counterpartyId,proof,old?old.version+1:1,old?.id??null,n.bankCode,n.bankName,n.number,n.holder,
        n.currency,n.isDefault,n.reference,n.audit,n.key,actor]);
    return {proposal:await view(tx,id),replayed:false};
  });}catch(err){return dbError(err);}
}

/** State/default proposals copy the last approved number; they cannot substitute account content. */
export async function proposeHandymanBmBankAccountState(actorInput:string,input:ProposeBmBankAccountStateInput) {
  keys(input,['clientId','counterpartyId','bankAccountId','expectedVersion','status','isDefault','evidenceReference','idempotencyKey']);
  const actor=uuid(actorInput,'actorUserId'),s=scope(input),accountId=uuid(input.bankAccountId,'bankAccountId'),expected=version(input.expectedVersion,'expectedVersion');
  if(!['ACTIVE','SUSPENDED'].includes(input.status) || typeof input.isDefault!=='boolean' || (input.status==='SUSPENDED' && input.isDefault)) throw invalid('status or isDefault');
  const audit=evidence(input.evidenceReference,'evidenceReference',500),key=text(input.idempotencyKey,'idempotencyKey',200);
  try{return await withTransaction(async tx=>{
    await tx.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');await access(tx,actor,s.clientId,'maker');
    const proof=await lockBeneficiary(tx,s);
    const prior=(await tx.query('SELECT * FROM handyman_bm_bank_account_versions WHERE counterparty_id=$1 AND idempotency_key=$2',[s.counterpartyId,key])).rows[0];
    if(prior) {
      if(prior.client_id!==s.clientId || prior.created_by_user_id!==actor || prior.proposal_type!=='STATE' || prior.bank_account_id!==accountId ||
        prior.version!==expected+1 || prior.proposed_status!==input.status || prior.is_default!==input.isDefault || prior.evidence_reference!==audit) throw conflict();
      return {proposal:await view(tx,prior.id),replayed:true};
    }
    const old=await latest(tx,accountId,s);await assertNext(tx,old,expected);
    const approved=await current(tx,accountId,s);if(!approved) throw conflict();
    preventNumberDisclosure(approved.account_number,audit);
    const id=randomUUID();
    await tx.query(`INSERT INTO handyman_bm_bank_account_versions(id,bank_account_id,client_id,counterparty_id,beneficiary_verification_id,
      version,previous_version_id,proposal_type,bank_code,bank_name,account_number,account_holder_name,currency,proposed_status,is_default,
      verification_reference,evidence_reference,idempotency_key,created_by_user_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,'STATE',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [id,accountId,s.clientId,s.counterpartyId,proof,old.version+1,old.id,approved.bank_code,approved.bank_name,approved.account_number,
        approved.account_holder_name,approved.currency,input.status,input.isDefault,approved.verification_reference,audit,key,actor]);
    return {proposal:await view(tx,id),replayed:false};
  });}catch(err){return dbError(err);}
}

/** Internal maker-checker authorization only; it never claims the bank verified the account. */
export async function decideHandymanBmBankAccount(actorInput:string,input:DecideBmBankAccountInput) {
  keys(input,['clientId','counterpartyId','proposalId','version','decision','evidenceReference']);
  const actor=uuid(actorInput,'actorUserId'),s=scope(input),proposalId=uuid(input.proposalId,'proposalId'),v=version(input.version);
  if(input.decision!=='APPROVE' && input.decision!=='REJECT') throw invalid('decision');
  const audit=evidence(input.evidenceReference,'evidenceReference',500);
  try{return await withTransaction(async tx=>{
    await tx.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');await access(tx,actor,s.clientId,'checker');await lockBeneficiary(tx,s);
    const row=(await tx.query('SELECT * FROM handyman_bm_bank_account_versions WHERE id=$1 AND client_id=$2 AND counterparty_id=$3',
      [proposalId,s.clientId,s.counterpartyId])).rows[0];
    if(!row) throw missing();if(row.version!==v) throw conflict();if(row.created_by_user_id===actor) throw checkerRequired();
    preventNumberDisclosure(row.account_number,audit);
    const prior=(await tx.query('SELECT * FROM handyman_bm_bank_account_decisions WHERE proposal_id=$1',[proposalId])).rows[0];
    if(prior) {
      if(prior.actor_user_id!==actor || prior.decision!==input.decision || prior.evidence_reference!==audit) throw conflict();
      return {proposal:await view(tx,proposalId),replayed:true};
    }
    const last=await latest(tx,row.bank_account_id,s);if(last.id!==proposalId) throw conflict();
    await tx.query(`INSERT INTO handyman_bm_bank_account_decisions(id,proposal_id,client_id,counterparty_id,bank_account_id,version,decision,evidence_reference,actor_user_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[randomUUID(),proposalId,s.clientId,s.counterpartyId,row.bank_account_id,v,input.decision,audit,actor]);
    return {proposal:await view(tx,proposalId),replayed:false};
  });}catch(err){return dbError(err);}
}

/** Current means latest approved internal state; no settlement or bank validation is implied. */
export async function listHandymanBmBankAccounts(actorInput:string,input:Scope) {
  keys(input,['clientId','counterpartyId']);const actor=uuid(actorInput,'actorUserId'),s=scope(input);
  return withTransaction(async tx=>{
    await access(tx,actor,s.clientId,'read');
    const party=(await tx.query('SELECT id FROM handyman_bm_legal_counterparties WHERE id=$1 AND client_id=$2',[s.counterpartyId,s.clientId])).rows[0];
    if(!party) throw missing();
    const rows=(await tx.query(`SELECT v.*,d.id AS decision_id,d.decision,d.actor_user_id AS checker_id,
      d.evidence_reference AS checker_evidence,d.occurred_at AS decision_at FROM handyman_bm_bank_account_versions v
      LEFT JOIN handyman_bm_bank_account_decisions d ON d.proposal_id=v.id
      WHERE v.client_id=$1 AND v.counterparty_id=$2 ORDER BY v.bank_account_id,v.version DESC`,[s.clientId,s.counterpartyId])).rows;
    const accounts=new Map<string,{latest:ReturnType<typeof publicVersion>;current:(ReturnType<typeof publicVersion>&{status:Status})|null}>();
    for(const row of rows){
      const item=accounts.get(row.bank_account_id)??{latest:publicVersion(row),current:null};
      if(!item.current && row.decision==='APPROVE') item.current=Object.freeze({...publicVersion(row),status:row.proposed_status as Status});
      accounts.set(row.bank_account_id,item);
    }
    return [...accounts.values()];
  });
}
