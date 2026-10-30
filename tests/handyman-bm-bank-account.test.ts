import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir,rm } from 'node:fs/promises';
import { after,before,describe,it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool } from 'pg';
import { closePool,initDatabase,migrateDown,migrateUp } from '../src/database';
import { UNASSIGNED_BY_DEFAULT_PERMISSION_CODES } from '../src/database/seeds/foundation-access.seed';
import { registerHandymanBmLegalCounterparty,verifyHandymanBmLegalCounterparty } from '../src/modules/handyman-bm-binding';
import { proposeHandymanBmBankAccount,proposeHandymanBmBankAccountState,decideHandymanBmBankAccount,
  listHandymanBmBankAccounts,type ProposeBmBankAccountInput } from '../src/modules/handyman-bm-bank-account';
import { userService } from '../src/modules/users';
import { roleService } from '../src/modules/roles';
import { permissionRepository,permissionService } from '../src/modules/permissions';
import { buildingAssignmentService } from '../src/modules/building-assignments';

const DIR='/tmp/hm-bm-bank-0504-pg',PORT=55604;
Object.assign(process.env,{NODE_ENV:'test',LOG_LEVEL:'error',DB_HOST:'127.0.0.1',DB_PORT:String(PORT),DB_USER:'postgres',
  DB_PASSWORD:'postgres',DB_NAME:'asentra_test',DB_SSL:'false'});
let pool:Pool,pg:EmbeddedPostgres;
const id=()=>randomUUID(),q=(sql:string,params:unknown[]=[])=>pool.query(sql,params);
const code=(expected:string)=>(err:{code?:string})=>{assert.equal(err.code,expected);return true;};
const wait=(ms=10)=>new Promise(resolve=>setTimeout(resolve,ms));

before(async()=>{
  await rm(DIR,{recursive:true,force:true});await mkdir(DIR,{recursive:true});
  pg=new EmbeddedPostgres({databaseDir:DIR,port:PORT,user:'postgres',password:'',persistent:true,authMethod:'trust'});
  await pg.initialise();await pg.start();const system=pg.getPgClient('postgres','127.0.0.1');
  await system.connect();await system.query('CREATE DATABASE asentra_test');await system.end();
  const {ensureTestDatabase}=await import('./helpers/postgres');const config=await ensureTestDatabase();assert.ok(config);
  pool=await initDatabase(config);await migrateUp(pool);
});
after(async()=>{try{if(pool)await closePool(pool);if(pg)await pg.stop();}finally{await rm(DIR,{recursive:true,force:true});}});

async function scopedUser(buildingId:string,codes:string[]){
  const user=await userService.createUser({email:`${id()}@bm-bank.test`,displayName:'BM Bank Finance'});
  const role=await roleService.createRole({code:`BM_BANK_${id().replaceAll('-','')}`,name:'Explicit BM bank capability'});
  for(const code of codes){const p=await permissionRepository.findByCode(code);assert.ok(p);await permissionService.assignPermissionToRole(role.id,p.id);}
  await roleService.assignRoleToUser(user.id,role.id);await buildingAssignmentService.createAssignment(user.id,{buildingId});return user.id;
}
async function fixture(verified=true){
  const clientId=id(),propertyId=id(),buildingId=id();
  await q('INSERT INTO clients(id,code,name) VALUES($1,$2,$3)',[clientId,id(),'Client']);
  await q('INSERT INTO properties(id,client_id,code,name) VALUES($1,$2,$3,$4)',[propertyId,clientId,id(),'Property']);
  await q('INSERT INTO buildings(id,property_id,code,name) VALUES($1,$2,$3,$4)',[buildingId,propertyId,id(),'Building']);
  const maker=await scopedUser(buildingId,['handyman.finance.read','handyman.finance.manage','handyman.bm_bank_account.manage','handyman.bm_bank_account.approve']);
  const checker=await scopedUser(buildingId,['handyman.finance.read','handyman.bm_bank_account.approve']);
  const reader=await scopedUser(buildingId,['handyman.finance.read']);
  const party=await registerHandymanBmLegalCounterparty(maker,{clientId,legalName:'PT Building Management',registrationNumber:id(),
    representsClientOrganization:false,idempotencyKey:id()});
  if(verified){await verifyHandymanBmLegalCounterparty(maker,{clientId,counterpartyId:party.counterparty.id,evidenceReference:`identity/${id()}`});await wait();}
  return {clientId,buildingId,maker,checker,reader,counterpartyId:party.counterparty.id};
}
function content(f:Awaited<ReturnType<typeof fixture>>,overrides:Partial<ProposeBmBankAccountInput>={}):ProposeBmBankAccountInput{
  return {clientId:f.clientId,counterpartyId:f.counterpartyId,bankAccountId:null,expectedVersion:null,bankCode:'BCA',bankName:'Test Bank',
    accountNumber:'12345678901234',accountHolderName:'PT Building Management',currency:'IDR',verificationReference:`bank-reference/${id()}`,
    isDefault:true,evidenceReference:`maker-evidence/${id()}`,idempotencyKey:id(),...overrides};
}
function review(f:Awaited<ReturnType<typeof fixture>>,proposal:{id:string;version:number},decision:'APPROVE'|'REJECT'='APPROVE'){
  return {clientId:f.clientId,counterpartyId:f.counterpartyId,proposalId:proposal.id,version:proposal.version,decision,evidenceReference:`checker-review/${id()}`};
}
async function counts(){
  const result:Record<string,number>={};
  for(const name of ['handyman_document_issuer_bank_accounts','handyman_entitlement_facts','handyman_entitlement_corrections',
    'handyman_bm_commission_ledger','handyman_settlement_units','handyman_settlement_events'])
    result[name]=(await q(`SELECT count(*)::int AS n FROM ${name}`)).rows[0].n;
  return result;
}

describe('CR-HM-BM-SETTLEMENT-03 PART 01 beneficiary bank account',()=>{
  it('requires exact verified beneficiary, explicit permissions, and separated checker approval',async()=>{
    assert.ok(UNASSIGNED_BY_DEFAULT_PERMISSION_CODES.has('handyman.bm_bank_account.manage'));
    assert.ok(UNASSIGNED_BY_DEFAULT_PERMISSION_CODES.has('handyman.bm_bank_account.approve'));
    const grants=(await q(`SELECT count(*)::int n FROM role_permission_assignments a JOIN permissions p ON p.id=a.permission_id
      WHERE p.code IN ('handyman.bm_bank_account.manage','handyman.bm_bank_account.approve') AND a.status='ACTIVE'`)).rows[0].n;
    assert.equal(grants,0);
    const unverified=await fixture(false);
    await assert.rejects(proposeHandymanBmBankAccount(unverified.maker,content(unverified)),code('HANDYMAN_BM_BANK_UNVERIFIED_BENEFICIARY'));
    const f=await fixture(),other=await fixture(),original=content(f),before=await counts();
    await assert.rejects(proposeHandymanBmBankAccount(f.reader,original),code('PERMISSION_DENIED'));
    await assert.rejects(proposeHandymanBmBankAccount(other.maker,original),code('BUILDING_ACCESS_DENIED'));
    await assert.rejects(proposeHandymanBmBankAccount(f.maker,{...original,counterpartyId:other.counterpartyId}),code('HANDYMAN_BM_BANK_UNVERIFIED_BENEFICIARY'));
    await assert.rejects(proposeHandymanBmBankAccount(f.maker,{...original,verificationReference:'unknown'}),code('HANDYMAN_BM_BANK_INVALID'));
    await assert.rejects(proposeHandymanBmBankAccount(f.maker,{...original,evidenceReference:`account ${original.accountNumber}`}),code('HANDYMAN_BM_BANK_INVALID'));
    const pending=await proposeHandymanBmBankAccount(f.maker,original);
    assert.equal(pending.proposal.reviewStatus,'PENDING_REVIEW');assert.equal(pending.proposal.proposedStatus,'ACTIVE');
    assert.equal(pending.proposal.accountNumberMasked,'****1234');assert.equal(pending.proposal.bankVerificationStatus,'NOT_VERIFIED_BY_SYSTEM');
    assert.ok(!JSON.stringify(pending).includes(original.accountNumber));
    assert.equal((await listHandymanBmBankAccounts(f.reader,{clientId:f.clientId,counterpartyId:f.counterpartyId}))[0].current,null);
    const r=review(f,pending.proposal);
    await assert.rejects(decideHandymanBmBankAccount(f.maker,r),code('HANDYMAN_BM_BANK_CHECKER_REQUIRED'));
    await assert.rejects(decideHandymanBmBankAccount(f.reader,r),code('PERMISSION_DENIED'));
    await assert.rejects(decideHandymanBmBankAccount(other.checker,r),code('BUILDING_ACCESS_DENIED'));
    const decided=await decideHandymanBmBankAccount(f.checker,r);
    assert.equal(decided.proposal.reviewStatus,'APPROVED');assert.equal(decided.proposal.decision?.actorUserId,f.checker);
    assert.equal(decided.proposal.decision?.evidenceReference,r.evidenceReference);
    const list=await listHandymanBmBankAccounts(f.reader,{clientId:f.clientId,counterpartyId:f.counterpartyId});
    assert.equal(list[0].current?.status,'ACTIVE');assert.equal(list[0].current?.isDefault,true);
    assert.equal(list[0].current?.bankVerificationStatus,'NOT_VERIFIED_BY_SYSTEM');
    assert.ok(!JSON.stringify(list).includes(original.accountNumber));assert.deepEqual(await counts(),before);
    await assert.rejects(q('UPDATE handyman_bm_bank_account_versions SET account_number=$2 WHERE id=$1',[pending.proposal.id,'998877665544']),/immutable/);
    await assert.rejects(q('DELETE FROM handyman_bm_bank_account_decisions WHERE proposal_id=$1',[pending.proposal.id]),/immutable/);
    assert.equal(await migrateDown(pool),'0508_handyman_inspection_work_links');
    assert.equal(await migrateDown(pool),'0507_handyman_tenant_payment_receipts');
    assert.equal(await migrateDown(pool),'0506_handyman_bm_document_issuance');
    assert.equal(await migrateDown(pool),'0505_handyman_bm_settlement_payment_evidence');
    try { await assert.rejects(migrateDown(pool),/Refusing to remove populated BM bank account history/); }
    finally { await migrateUp(pool); }
  });

  it('preserves prior approved versions through rejection, replacement, suspension and reactivation',async()=>{
    const f=await fixture(),firstInput=content(f),first=(await proposeHandymanBmBankAccount(f.maker,firstInput)).proposal;
    await decideHandymanBmBankAccount(f.checker,review(f,first));
    const other=await registerHandymanBmLegalCounterparty(f.maker,{clientId:f.clientId,legalName:'Different BM',registrationNumber:id(),
      representsClientOrganization:false,idempotencyKey:id()});
    await verifyHandymanBmLegalCounterparty(f.maker,{clientId:f.clientId,counterpartyId:other.counterparty.id,evidenceReference:`identity/${id()}`});await wait();
    await assert.rejects(proposeHandymanBmBankAccount(f.maker,content(f,{counterpartyId:other.counterparty.id,
      bankAccountId:first.bankAccountId,expectedVersion:1})),code('HANDYMAN_BM_BANK_NOT_FOUND'));
    const changed=content(f,{bankAccountId:first.bankAccountId,expectedVersion:1,accountNumber:'98765432101234',isDefault:true});
    const pending=(await proposeHandymanBmBankAccount(f.maker,changed)).proposal;
    assert.equal(pending.version,2);assert.equal(pending.previousVersionId,first.id);
    assert.equal((await listHandymanBmBankAccounts(f.reader,{clientId:f.clientId,counterpartyId:f.counterpartyId}))[0].current?.id,first.id);
    await assert.rejects(proposeHandymanBmBankAccount(f.maker,{...changed,idempotencyKey:id()}),code('HANDYMAN_BM_BANK_CONFLICT'));
    const reject=review(f,pending,'REJECT');await decideHandymanBmBankAccount(f.checker,reject);
    await assert.rejects(decideHandymanBmBankAccount(f.checker,{...reject,decision:'APPROVE'}),code('HANDYMAN_BM_BANK_CONFLICT'));
    const replacement=(await proposeHandymanBmBankAccount(f.maker,{...changed,expectedVersion:2,idempotencyKey:id()})).proposal;
    assert.equal(replacement.version,3);await decideHandymanBmBankAccount(f.checker,review(f,replacement));
    const suspend={clientId:f.clientId,counterpartyId:f.counterpartyId,bankAccountId:first.bankAccountId,expectedVersion:3,
      status:'SUSPENDED' as const,isDefault:false,evidenceReference:`suspend/${id()}`,idempotencyKey:id()};
    const suspended=(await proposeHandymanBmBankAccountState(f.maker,suspend)).proposal;
    assert.equal(suspended.proposalType,'STATE');assert.equal(suspended.accountNumberMasked,'****1234');
    assert.equal((await listHandymanBmBankAccounts(f.reader,{clientId:f.clientId,counterpartyId:f.counterpartyId}))[0].current?.status,'ACTIVE');
    await decideHandymanBmBankAccount(f.checker,review(f,suspended));
    assert.equal((await listHandymanBmBankAccounts(f.reader,{clientId:f.clientId,counterpartyId:f.counterpartyId}))[0].current?.status,'SUSPENDED');
    const activation=(await proposeHandymanBmBankAccountState(f.maker,{...suspend,expectedVersion:4,status:'ACTIVE',isDefault:true,
      evidenceReference:`reactivate/${id()}`,idempotencyKey:id()})).proposal;
    await decideHandymanBmBankAccount(f.checker,review(f,activation));
    const list=await listHandymanBmBankAccounts(f.reader,{clientId:f.clientId,counterpartyId:f.counterpartyId});
    assert.equal(list[0].current?.id,activation.id);assert.equal(list[0].current?.status,'ACTIVE');assert.equal(list[0].current?.version,5);
    assert.equal(list[0].current?.bankVerificationStatus,'NOT_VERIFIED_BY_SYSTEM');
    const rows=(await q('SELECT id,account_number FROM handyman_bm_bank_account_versions WHERE bank_account_id=$1 ORDER BY version',[first.bankAccountId])).rows;
    assert.equal(rows[0].account_number,firstInput.accountNumber);assert.equal(rows[2].account_number,changed.accountNumber);
    assert.equal(rows[3].account_number,changed.accountNumber);assert.equal(rows[4].account_number,changed.accountNumber);
    assert.ok(!JSON.stringify(list).includes(changed.accountNumber));
  });

  it('serializes retries and competing default approvals without an extra pool connection',async()=>{
    const f=await fixture(),input=content(f),requests=await Promise.all(Array.from({length:12},()=>proposeHandymanBmBankAccount(f.maker,input)));
    assert.equal(new Set(requests.map(x=>x.proposal.id)).size,1);assert.equal(requests.filter(x=>!x.replayed).length,1);
    const second=(await proposeHandymanBmBankAccount(f.maker,content(f,{accountNumber:'777766665555',idempotencyKey:id()}))).proposal;
    const first=requests[0].proposal,r1=review(f,first),r2=review(f,second);
    const outcomes=await Promise.allSettled([decideHandymanBmBankAccount(f.checker,r1),decideHandymanBmBankAccount(f.checker,r2)]);
    assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
    const failed=outcomes.find(x=>x.status==='rejected') as PromiseRejectedResult;assert.equal(failed.reason.code,'HANDYMAN_BM_BANK_CONFLICT');
    const accepted=outcomes[0].status==='fulfilled'?r1:r2;
    const retries=await Promise.all(Array.from({length:12},()=>decideHandymanBmBankAccount(f.checker,accepted)));
    assert.ok(retries.every(x=>x.replayed));assert.equal(new Set(retries.map(x=>x.proposal.decision?.id)).size,1);
    const accounts=await listHandymanBmBankAccounts(f.reader,{clientId:f.clientId,counterpartyId:f.counterpartyId});
    assert.equal(accounts.filter(x=>x.current?.status==='ACTIVE' && x.current?.isDefault).length,1);
  });

  it('enforces immutable scope and checker separation against direct SQL',async()=>{
    const f=await fixture(),pending=(await proposeHandymanBmBankAccount(f.maker,content(f))).proposal;
    const insert=`INSERT INTO handyman_bm_bank_account_decisions(id,proposal_id,client_id,counterparty_id,bank_account_id,version,decision,evidence_reference,actor_user_id)
      VALUES($1,$2,$3,$4,$5,$6,'APPROVE',$7,$8)`;
    const args=[id(),pending.id,f.clientId,f.counterpartyId,pending.bankAccountId,pending.version,`direct-review/${id()}`,f.maker];
    await assert.rejects(q(insert,args),/independent authorized checker/);
    const other=await fixture();
    await assert.rejects(q(insert,[id(),pending.id,other.clientId,other.counterpartyId,pending.bankAccountId,pending.version,`direct/${id()}`,other.checker]),
      /independent authorized checker/);
    const tx=await pool.connect();try{
      await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await assert.rejects(tx.query(insert,[id(),pending.id,f.clientId,f.counterpartyId,pending.bankAccountId,pending.version,`direct/${id()}`,f.checker]),/READ COMMITTED/);
    }finally{await tx.query('ROLLBACK').catch(()=>undefined);tx.release();}
    await assert.rejects(q('DELETE FROM handyman_bm_bank_account_versions WHERE id=$1',[pending.id]),/immutable/);
    assert.equal((await listHandymanBmBankAccounts(f.reader,{clientId:f.clientId,counterpartyId:f.counterpartyId}))[0].current,null);
  });
});
