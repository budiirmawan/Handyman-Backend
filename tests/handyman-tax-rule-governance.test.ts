import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import type { Pool, PoolClient } from 'pg';
import { closePool, initDatabase, migrateDown, migrateUp, migrations } from '../src/database';
import { seedFoundationAccess, UNASSIGNED_BY_DEFAULT_PERMISSION_CODES } from '../src/database/seeds/foundation-access.seed';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { permissionRepository, permissionService } from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { userService } from '../src/modules/users';
import {
  closeHandymanTaxRule, createHandymanTaxRule, decideHandymanTaxRule, listHandymanTaxRuleApprovalHistory,
  resolveHandymanTaxRule, submitHandymanTaxRule, type CreateHandymanTaxRule, type HandymanTaxRuleView,
  type TaxRuleApprovalEvent, type TaxRuleReviewCommand,
} from '../src/modules/handyman-tax-rules';
import { createAdminUser } from './helpers/access';

const DIR = '/tmp/hm-tax-rules-pg', PORT = 55533;
Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'error', DB_HOST: '127.0.0.1',
  DB_PORT: String(PORT), DB_USER: 'postgres', DB_PASSWORD: 'postgres', DB_NAME: 'asentra_test', DB_SSL: 'false' });
let pg: EmbeddedPostgres, pool: Pool, admin: string;
const id = () => randomUUID();
const q = (sql: string, params: unknown[] = []) => pool.query(sql,params);
const code = (expected: string) => (err: { code?: string }) => { assert.equal(err.code,expected); return true; };
const caseCode = () => `CASE_${id().replace(/-/g,'').toUpperCase()}`;
function day(offset: number): string {
  const jakarta = new Date(Date.now() + 7 * 60 * 60 * 1000);
  return new Date(Date.UTC(jakarta.getUTCFullYear(),jakarta.getUTCMonth(),jakarta.getUTCDate() + offset)).toISOString().slice(0,10);
}
const pause = () => new Promise(resolve => setTimeout(resolve,5));

before(async () => {
  await rm(DIR,{ recursive: true, force: true }); await mkdir(DIR,{ recursive: true });
  pg = new EmbeddedPostgres({ databaseDir: DIR, port: PORT, user: 'postgres', password: '', persistent: true, authMethod: 'trust' });
  await pg.initialise(); await pg.start();
  const connection = pg.getPgClient('postgres','127.0.0.1');
  await connection.connect(); await connection.query('CREATE DATABASE asentra_test'); await connection.end();
  const { ensureTestDatabase } = await import('./helpers/postgres');
  const config = await ensureTestDatabase(); assert.ok(config);
  pool = await initDatabase(config); await migrateUp(pool); admin = (await createAdminUser()).userId;
});
after(async () => {
  try { if (pool) await closePool(pool); if (pg) await pg.stop(); }
  finally { await rm(DIR,{ recursive: true, force: true }); }
});
async function scopedUser(buildingId: string, codes: string[]) {
  const user = await userService.createUser({ email: `${id()}@taxrules.test`, displayName: 'Tax rules Finance' });
  const role = await roleService.createRole({ code: `RULE_${id()}`, name: 'Explicit tax rule role' });
  for (const c of codes) {
    const record = await permissionRepository.findByCode(c); assert.ok(record);
    await permissionService.assignPermissionToRole(role.id,record.id);
  }
  await roleService.assignRoleToUser(user.id,role.id);
  await buildingAssignmentService.createAssignment(user.id,{ buildingId });
  return user.id;
}
async function fixture() {
  const clientId=id(), propertyId=id(), buildingId=id();
  await q('INSERT INTO clients (id,code,name) VALUES ($1,$2,$3)',[clientId,id(),'Provider']);
  await q('INSERT INTO properties (id,client_id,code,name) VALUES ($1,$2,$3,$4)',[propertyId,clientId,id(),'Property']);
  await q('INSERT INTO buildings (id,property_id,code,name) VALUES ($1,$2,$3,$4)',[buildingId,propertyId,id(),'Building']);
  const maker = await scopedUser(buildingId,['handyman.finance.manage','handyman.finance.read']);
  const checker = await scopedUser(buildingId,['handyman.finance.read','handyman.tax_rule.approve']);
  return { clientId,buildingId,maker,checker };
}
function ruleInput(clientId: string, overrides: Partial<CreateHandymanTaxRule> = {}): CreateHandymanTaxRule {
  return { clientId, transactionContext: 'CUSTOMER_SERVICE_BILLING', taxCode: 'PPN', taxpayerClassification: caseCode(),
    classificationDescription: 'Test-only expressly reviewed case', effectiveFrom: day(-3), effectiveTo: day(10),
    basisMethodCode: 'TEST_BASIS', basisDescription: 'Test-only basis description', ratePercent: '7.125000',
    roundingMode: 'HALF_UP', roundingScale: 2, legalReference: 'TEST-ONLY reference',
    legalSource: 'TEST-ONLY example source', evidenceSource: 'FINANCE_REVIEW', evidenceReference: `case/${id()}`,
    expectedVersion: null, ...overrides };
}
function review(r: HandymanTaxRuleView): TaxRuleReviewCommand {
  return { clientId: r.snapshot.clientId, ruleId: r.snapshot.id, ruleVersion: r.snapshot.version, ruleDigest: r.digest,
    evidenceSource: 'FINANCE_CASE', evidenceReference: `submit/${id()}` };
}
function decide(input: TaxRuleReviewCommand, submitted: TaxRuleApprovalEvent, decision: 'APPROVE' | 'REJECT') {
  return { ...input, submissionId: submitted.id, decision,
    sourceValidation: decision === 'APPROVE' ? 'FINANCE_VALIDATED' as const : null,
    evidenceSource: 'INDEPENDENT_REVIEW', evidenceReference: `decision/${id()}` };
}
function selector(input: CreateHandymanTaxRule, taxDate = day(0)) {
  return { clientId: input.clientId, transactionContext: input.transactionContext, taxCode: input.taxCode,
    taxpayerClassification: input.taxpayerClassification, taxDate };
}
async function approved(f: Awaited<ReturnType<typeof fixture>>, input: CreateHandymanTaxRule) {
  const rule = await createHandymanTaxRule(f.maker,input), pin = review(rule);
  const submission = await submitHandymanTaxRule(f.maker,pin);
  const decision = await decideHandymanTaxRule(f.checker,decide(pin,submission,'APPROVE'));
  await pause();
  return { rule,pin,submission,decision };
}
async function rawRule(tx: Pick<PoolClient,'query'>, input: CreateHandymanTaxRule, actor: string, version: number) {
  return (await tx.query(`INSERT INTO handyman_tax_rules
    (id,client_id,transaction_context,tax_code,taxpayer_classification,classification_description,version,effective_from,
     declared_effective_to,basis_method_code,basis_description,rate_percent,rounding_mode,rounding_scale,legal_reference,
     legal_source,evidence_source,evidence_reference,created_by_user_id,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'2000-01-01') RETURNING *`,
  [id(),input.clientId,input.transactionContext,input.taxCode,input.taxpayerClassification,input.classificationDescription,version,
    input.effectiveFrom,input.effectiveTo,input.basisMethodCode,input.basisDescription,input.ratePercent,input.roundingMode,input.roundingScale,
    input.legalReference,input.legalSource,input.evidenceSource,input.evidenceReference,actor])).rows[0];
}
async function rawEvent(tx: Pick<PoolClient,'query'>, pin: TaxRuleReviewCommand, actor: string,
  eventType: 'SUBMIT' | 'APPROVE' | 'REJECT', submissionId: string | null = null, override: {
    clientId?: string; version?: number; digest?: string; validation?: string | null;
  } = {}) {
  return (await tx.query(`INSERT INTO handyman_tax_rule_approval_events
    (id,rule_id,client_id,rule_version,rule_digest,event_type,submission_id,source_validation,actor_user_id,evidence_source,evidence_reference,occurred_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'TEST','raw-review','2000-01-01') RETURNING *`,
  [id(),pin.ruleId,override.clientId ?? pin.clientId,override.version ?? pin.ruleVersion,override.digest ?? pin.ruleDigest,eventType,submissionId,
    override.validation === undefined ? (eventType === 'APPROVE' ? 'FINANCE_VALIDATED' : null) : override.validation,actor])).rows[0];
}
async function waitForBlock(waiter: number, blocker: number) {
  for (let i=0;i<100;i++) {
    if ((await q('SELECT $2 = ANY(pg_blocking_pids($1)) AS blocked',[waiter,blocker])).rows[0].blocked) return;
    await new Promise(resolve => setTimeout(resolve,20));
  }
  assert.fail('Expected the concurrent rule operation to block on the exact Client.');
}

describe('CR-HM-TAX-INDONESIA-01 PART 01C Finance rule governance', () => {
  it('adds an unassigned checker capability and safely migrates an empty registry down and up', async () => {
    assert.deepEqual(migrations.slice(-5).map(m => m.id), ['0496_handyman_tax_identity_approval','0497_handyman_tax_rule_governance', '0498_handyman_request_buyer_bindings', '0499_handyman_customer_tax_classifications', '0500_handyman_bm_commission_tax_cases']);
    assert.ok(UNASSIGNED_BY_DEFAULT_PERMISSION_CODES.has('handyman.tax_rule.approve'));
    const grants = async () => (await q(`SELECT count(*)::int AS n FROM role_permission_assignments rpa
      JOIN permissions p ON p.id=rpa.permission_id WHERE p.code='handyman.tax_rule.approve' AND rpa.status='ACTIVE'`)).rows[0].n;
    assert.equal(await grants(),0);
    const tx = await pool.connect();
    try { await tx.query('BEGIN'); await seedFoundationAccess(tx); await tx.query('COMMIT'); }
    finally { tx.release(); }
    assert.equal(await grants(),0);
    assert.equal(await migrateDown(pool), '0500_handyman_bm_commission_tax_cases');
    assert.equal(await migrateDown(pool),'0499_handyman_customer_tax_classifications');
    assert.equal(await migrateDown(pool),'0498_handyman_request_buyer_bindings');
    assert.equal(await migrateDown(pool),'0497_handyman_tax_rule_governance');
    assert.deepEqual(await migrateUp(pool),['0497_handyman_tax_rule_governance', '0498_handyman_request_buyer_bindings', '0499_handyman_customer_tax_classifications', '0500_handyman_bm_commission_tax_cases']);
    assert.ok(await permissionRepository.findByCode('handyman.tax_rule.approve'));
  });

  it('validates explicit family, context, classification, rate, source and basis without defaults', async () => {
    const f = await fixture(), input = ruleInput(f.clientId, { classificationDescription: 'Café "Bali" \\ reviewed' });
    assert.deepEqual(await resolveHandymanTaxRule(f.maker,selector(input)),{ status:'MISSING' });
    const row = await createHandymanTaxRule(f.maker,input);
    assert.equal(row.snapshot.ratePercent,'7.125000');
    assert.equal((await q('SELECT hm_tax_rule_payload_digest($1) AS hash',[row.snapshot.id])).rows[0].hash,row.digest);
    assert.deepEqual(await resolveHandymanTaxRule(f.maker,selector(input)),{ status:'NOT_APPROVED' });
    for (const bad of [
      { taxCode:'PPH_23' }, { transactionContext:'OTHER' }, { taxpayerClassification:'UNKNOWN' },
      { taxpayerClassification:'PKP' }, { taxpayerClassification:'ANY' }, { basisMethodCode:'UNKNOWN' },
      { effectiveFrom:'2025-02-30' }, { ratePercent:undefined }, { ratePercent:2.5 }, { ratePercent:'101' },
      { ratePercent:'0.0000001' }, { legalSource:'' }, { legalReference:'' }, { evidenceReference:'' },
      { roundingMode:'MAGIC' }, { roundingMode:'NO_ROUNDING',roundingScale:2 },
    ]) {
      await assert.rejects(createHandymanTaxRule(f.maker,{ ...ruleInput(f.clientId),...bad } as CreateHandymanTaxRule),code('HANDYMAN_TAX_RULE_INVALID'));
    }
    await assert.rejects(resolveHandymanTaxRule(f.maker,{ ...selector(input), taxpayerClassification:'PKP' }),code('HANDYMAN_TAX_RULE_INVALID'));
    await assert.rejects(resolveHandymanTaxRule(f.maker,{ ...selector(input), taxDate:'2025-02-30' }),code('HANDYMAN_TAX_RULE_INVALID'));
    await assert.rejects(resolveHandymanTaxRule(f.maker,{ ...selector(input), knownAt:'2025-02-30T09:00:00Z' }),code('HANDYMAN_TAX_RULE_INVALID'));
  });

  it('enforces Finance maker/checker separation, source attestation and exact Client reach', async () => {
    const f = await fixture(), other = await fixture(), input = ruleInput(f.clientId);
    const commercial = await scopedUser(f.buildingId,['handyman.commercial.manage','handyman.finance.read']);
    const identityChecker = await scopedUser(f.buildingId,['handyman.finance.read','handyman.tax_identity.approve']);
    const makerChecker = await scopedUser(f.buildingId,['handyman.finance.manage','handyman.finance.read','handyman.tax_rule.approve']);
    await assert.rejects(createHandymanTaxRule(commercial,input),code('PERMISSION_DENIED'));
    await assert.rejects(createHandymanTaxRule(other.maker,input),code('BUILDING_ACCESS_DENIED'));
    await assert.rejects(rawRule(pool,input,commercial,1),/active scoped Finance maker/);
    const r = await createHandymanTaxRule(makerChecker,input), pin = review(r), sub = await submitHandymanTaxRule(f.maker,pin);
    await assert.rejects(decideHandymanTaxRule(makerChecker,decide(pin,sub,'APPROVE')),code('HANDYMAN_TAX_RULE_APPROVAL_FORBIDDEN'));
    await assert.rejects(decideHandymanTaxRule(identityChecker,decide(pin,sub,'APPROVE')),code('PERMISSION_DENIED'));
    await assert.rejects(decideHandymanTaxRule(other.checker,decide(pin,sub,'APPROVE')),code('BUILDING_ACCESS_DENIED'));
    await assert.rejects(decideHandymanTaxRule(f.checker,{ ...decide(pin,sub,'APPROVE'), sourceValidation:null }),code('HANDYMAN_TAX_RULE_INVALID'));
    await assert.rejects(rawEvent(pool,pin,makerChecker,'APPROVE',sub.id),/maker or author cannot check/);
    await assert.rejects(rawEvent(pool,pin,f.checker,'APPROVE',sub.id,{ validation:null }),/check constraint/);
    await assert.rejects(rawEvent(pool,pin,f.checker,'APPROVE',sub.id,{ digest:'0'.repeat(64) }),/digest does not match/);
    await assert.rejects(rawEvent(pool,pin,f.checker,'APPROVE',sub.id,{ clientId:other.clientId }),/exact Client, rule and version/);
    await assert.rejects(resolveHandymanTaxRule(other.maker,selector(input)),code('BUILDING_ACCESS_DENIED'));
    assert.deepEqual(await resolveHandymanTaxRule(other.maker,{ ...selector(input),clientId:other.clientId }),{status:'MISSING'});
    const a = await decideHandymanTaxRule(f.checker,decide(pin,sub,'APPROVE'));
    assert.equal(a.sourceValidation,'FINANCE_VALIDATED');
    const own = await createHandymanTaxRule(makerChecker,ruleInput(f.clientId));
    const ownSub = await submitHandymanTaxRule(makerChecker,review(own));
    await assert.rejects(decideHandymanTaxRule(makerChecker,decide(review(own),ownSub,'REJECT')),code('HANDYMAN_TAX_RULE_APPROVAL_FORBIDDEN'));
  });

  it('resolves exact approved PPN and PPh family, context, date and knowledge boundaries without identity inference', async () => {
    const f = await fixture(), ppn = ruleInput(f.clientId), withholding = ruleInput(f.clientId, { transactionContext:'BM_COMMISSION',
      taxCode:'PPH_WITHHOLDING', effectiveFrom:day(-2),effectiveTo:day(3),roundingMode:'NO_ROUNDING',roundingScale:null,ratePercent:'0' });
    const first = await approved(f,ppn), second = await approved(f,withholding);
    const one = await resolveHandymanTaxRule(f.maker,selector(ppn,ppn.effectiveFrom));
    assert.equal(one.status,'APPROVED');
    if (one.status === 'APPROVED') assert.equal(one.rule.digest,first.rule.digest);
    assert.equal((await resolveHandymanTaxRule(f.maker,selector(withholding,day(2)))).status,'APPROVED');
    assert.deepEqual(await resolveHandymanTaxRule(f.maker,selector(withholding,withholding.effectiveTo!)),{status:'MISSING'});
    assert.deepEqual(await resolveHandymanTaxRule(f.maker,{...selector(ppn),taxCode:'PPH_WITHHOLDING'}),{status:'MISSING'});
    assert.deepEqual(await resolveHandymanTaxRule(f.maker,{...selector(ppn),transactionContext:'BM_COMMISSION'}),{status:'MISSING'});
    assert.deepEqual(await resolveHandymanTaxRule(f.maker,{...selector(ppn),taxpayerClassification:caseCode()}),{status:'MISSING'});
    assert.deepEqual(await resolveHandymanTaxRule(f.maker,{...selector(ppn),knownAt:first.submission.occurredAt}),{status:'NOT_APPROVED'});
    const resolution = await resolveHandymanTaxRule(f.maker,selector(withholding));
    if (resolution.status !== 'APPROVED') assert.fail(`Expected approved withholding, got ${resolution.status}`);
    assert.equal(resolution.approval.decision.id,second.decision.id); assert.equal(resolution.rule.snapshot.ratePercent,'0');
    assert.equal((await q('SELECT count(*)::int AS n FROM handyman_tax_identity_approval_events')).rows[0].n,0);
  });

  it('records one immutable rejection and never treats rejection as approval', async () => {
    const f = await fixture(), input = ruleInput(f.clientId), r = await createHandymanTaxRule(f.maker,input), pin = review(r);
    const sub = await submitHandymanTaxRule(f.maker,pin), rejected = await decideHandymanTaxRule(f.checker,decide(pin,sub,'REJECT'));
    assert.equal(rejected.eventType,'REJECT'); assert.equal(rejected.sourceValidation,null);
    assert.deepEqual(await resolveHandymanTaxRule(f.maker,selector(input)),{status:'NOT_APPROVED'});
    await assert.rejects(submitHandymanTaxRule(f.maker,pin),code('HANDYMAN_TAX_RULE_CONFLICT'));
    await assert.rejects(decideHandymanTaxRule(f.checker,decide(pin,sub,'APPROVE')),code('HANDYMAN_TAX_RULE_CONFLICT'));
    await assert.rejects(q('UPDATE handyman_tax_rules SET rate_percent=9 WHERE id=$1',[r.snapshot.id]),/immutable history/);
    await assert.rejects(q('DELETE FROM handyman_tax_rule_approval_events WHERE id=$1',[sub.id]),/immutable history/);
    await assert.rejects(q('UPDATE handyman_tax_rule_approval_events SET evidence_reference=$2 WHERE id=$1',[rejected.id,'rewrite']),/immutable history/);
    assert.deepEqual((await listHandymanTaxRuleApprovalHistory(f.maker,f.clientId,r.snapshot.id)).map(e => e.eventType),['SUBMIT','REJECT']);
  });

  it('enforces non-overlap per exact scope and preserves adjacent, separate cases', async () => {
    const f = await fixture(), base = ruleInput(f.clientId,{ effectiveFrom:day(-2),effectiveTo:day(4) });
    const first = await createHandymanTaxRule(f.maker,base);
    await assert.rejects(createHandymanTaxRule(f.maker,{...base,effectiveFrom:day(3),effectiveTo:day(8),expectedVersion:1}),code('HANDYMAN_TAX_RULE_CONFLICT'));
    await assert.rejects(rawRule(pool,{...base,effectiveFrom:day(3),effectiveTo:day(8)},f.maker,2),/exclusion constraint/);
    const next = await createHandymanTaxRule(f.maker,{...base,effectiveFrom:day(4),effectiveTo:day(8),expectedVersion:1});
    assert.equal(next.snapshot.version,2); assert.equal(first.snapshot.version,1);
    assert.equal((await createHandymanTaxRule(f.maker,{...base,transactionContext:'BM_COMMISSION'})).snapshot.version,1);
    assert.equal((await createHandymanTaxRule(f.maker,{...base,taxCode:'PPH_WITHHOLDING'})).snapshot.version,1);
    assert.equal((await createHandymanTaxRule(f.maker,{...base,taxpayerClassification:caseCode()})).snapshot.version,1);
    await assert.rejects(createHandymanTaxRule(f.maker,{...base,effectiveFrom:day(8),effectiveTo:day(9),expectedVersion:1}),code('HANDYMAN_TAX_RULE_CONFLICT'));
  });

  it('supersedes prospectively with separate immutable approval and retains historical rule data', async () => {
    const f = await fixture(), base = ruleInput(f.clientId,{ effectiveTo:null }), first = await approved(f,base);
    const priorRule = (await q('SELECT * FROM handyman_tax_rules WHERE id=$1',[first.rule.snapshot.id])).rows[0];
    const priorEvents = (await q('SELECT * FROM handyman_tax_rule_approval_events WHERE rule_id=$1 ORDER BY occurred_at',[first.rule.snapshot.id])).rows;
    await assert.rejects(closeHandymanTaxRule(f.maker,{ clientId:f.clientId,ruleId:first.rule.snapshot.id,effectiveTo:day(0),reason:'Backdate' }),code('HANDYMAN_TAX_RULE_CONFLICT'));
    const end = day(8), closed = await closeHandymanTaxRule(f.maker,{ clientId:f.clientId,ruleId:first.rule.snapshot.id,effectiveTo:end,reason:'Prospective replacement' });
    assert.equal(closed.digest,first.rule.digest); assert.equal(closed.effectiveWindow.to,end);
    const secondInput = {...base,effectiveFrom:end,effectiveTo:null,ratePercent:'6.875',expectedVersion:1};
    const second = await createHandymanTaxRule(f.maker,secondInput);
    assert.equal((await resolveHandymanTaxRule(f.maker,selector(base,day(7)))).status,'APPROVED');
    assert.deepEqual(await resolveHandymanTaxRule(f.maker,selector(base,end)),{status:'NOT_APPROVED'});
    const pin = review(second), sub = await submitHandymanTaxRule(f.maker,pin);
    await decideHandymanTaxRule(f.checker,decide(pin,sub,'APPROVE')); await pause();
    const current = await resolveHandymanTaxRule(f.maker,selector(base,end));
    if (current.status !== 'APPROVED') assert.fail(`Expected second approved rule, got ${current.status}`);
    assert.equal(current.rule.digest,second.digest);
    assert.deepEqual((await q('SELECT * FROM handyman_tax_rules WHERE id=$1',[first.rule.snapshot.id])).rows[0],priorRule);
    assert.deepEqual((await q('SELECT * FROM handyman_tax_rule_approval_events WHERE rule_id=$1 ORDER BY occurred_at',[first.rule.snapshot.id])).rows,priorEvents);
    await assert.rejects(q('DELETE FROM handyman_tax_rule_closures WHERE rule_id=$1',[first.rule.snapshot.id]),/immutable history/);
  });

  it('rejects a changed review window and safely cancels a future version', async () => {
    const f = await fixture(), input = ruleInput(f.clientId,{ effectiveFrom:day(20),effectiveTo:null });
    const r = await createHandymanTaxRule(f.maker,input), pin = review(r), sub = await submitHandymanTaxRule(f.maker,pin);
    await closeHandymanTaxRule(f.maker,{clientId:f.clientId,ruleId:r.snapshot.id,effectiveTo:input.effectiveFrom,reason:'Cancel future plan'});
    await assert.rejects(decideHandymanTaxRule(f.checker,decide(pin,sub,'APPROVE')),code('HANDYMAN_TAX_RULE_CONFLICT'));
    assert.equal((await decideHandymanTaxRule(f.checker,decide(pin,sub,'REJECT'))).eventType,'REJECT');
    assert.deepEqual(await resolveHandymanTaxRule(f.maker,selector(input,input.effectiveFrom)),{status:'MISSING'});
    const replacement = await createHandymanTaxRule(f.maker,{...input,expectedVersion:1});
    assert.equal(replacement.snapshot.version,2);
    assert.deepEqual(await resolveHandymanTaxRule(f.maker,selector(input,input.effectiveFrom)),{status:'NOT_APPROVED'});
  });

  it('fails closed on digest, approval and window tampering, and reports ambiguity rather than picking a rule', async () => {
    const f = await fixture(), input = ruleInput(f.clientId,{effectiveFrom:day(-2),effectiveTo:day(5)}), first = await approved(f,input);
    await q('ALTER TABLE handyman_tax_rules DISABLE TRIGGER hm_tax_rule_no_mutation');
    try {
      await q('UPDATE handyman_tax_rules SET rate_percent=42 WHERE id=$1',[first.rule.snapshot.id]);
      assert.deepEqual(await resolveHandymanTaxRule(f.maker,selector(input)),{status:'INTEGRITY_ERROR'});
      await q('UPDATE handyman_tax_rules SET rate_percent=$2 WHERE id=$1',[first.rule.snapshot.id,input.ratePercent]);
    } finally { await q('ALTER TABLE handyman_tax_rules ENABLE TRIGGER hm_tax_rule_no_mutation'); }
    await q('ALTER TABLE handyman_tax_rule_approval_events DISABLE TRIGGER hm_tax_rule_event_no_mutation');
    try {
      await q('UPDATE handyman_tax_rule_approval_events SET rule_digest=$2 WHERE id=$1',[first.decision.id,'0'.repeat(64)]);
      assert.deepEqual(await resolveHandymanTaxRule(f.maker,selector(input)),{status:'INTEGRITY_ERROR'});
      await q('UPDATE handyman_tax_rule_approval_events SET rule_digest=$2 WHERE id=$1',[first.decision.id,first.rule.digest]);
      await q("UPDATE handyman_tax_rule_approval_events SET occurred_at=clock_timestamp()+interval '2 days' WHERE id=$1",[first.decision.id]);
      assert.deepEqual(await resolveHandymanTaxRule(f.maker,{ ...selector(input), knownAt:new Date(Date.now()+3*86_400_000).toISOString() }),
        {status:'NOT_APPROVED'});
      await q('UPDATE handyman_tax_rule_approval_events SET occurred_at=$2 WHERE id=$1',[first.decision.id,first.decision.occurredAt]);
    } finally { await q('ALTER TABLE handyman_tax_rule_approval_events ENABLE TRIGGER hm_tax_rule_event_no_mutation'); }
    await q('ALTER TABLE handyman_tax_rule_windows DISABLE TRIGGER hm_tax_rule_window_guard');
    try {
      await q('UPDATE handyman_tax_rule_windows SET effective_to=$2 WHERE rule_id=$1',[first.rule.snapshot.id,day(6)]);
      assert.deepEqual(await resolveHandymanTaxRule(f.maker,selector(input)),{status:'INTEGRITY_ERROR'});
      await assert.rejects(rawEvent(pool,first.pin,f.maker,'SUBMIT'),/window projection does not match its immutable closure/);
      await q('UPDATE handyman_tax_rule_windows SET effective_to=$2 WHERE rule_id=$1',[first.rule.snapshot.id,input.effectiveTo]);
    } finally { await q('ALTER TABLE handyman_tax_rule_windows ENABLE TRIGGER hm_tax_rule_window_guard'); }
    const second = await createHandymanTaxRule(f.maker,{...input,effectiveFrom:day(5),effectiveTo:day(10),expectedVersion:1});
    // Test-only corruption bypasses both protection layers; restore both afterwards.
    await q('ALTER TABLE handyman_tax_rule_windows DROP CONSTRAINT hm_tax_rule_window_no_overlap');
    await q('ALTER TABLE handyman_tax_rule_windows DISABLE TRIGGER hm_tax_rule_window_guard');
    try {
      await q('UPDATE handyman_tax_rule_windows SET effective_from=$2 WHERE rule_id=$1',[second.snapshot.id,day(-1)]);
      assert.deepEqual(await resolveHandymanTaxRule(f.maker,selector(input)),{status:'AMBIGUOUS'});
      await q('UPDATE handyman_tax_rule_windows SET effective_from=$2 WHERE rule_id=$1',[second.snapshot.id,day(5)]);
    } finally {
      await q('ALTER TABLE handyman_tax_rule_windows ENABLE TRIGGER hm_tax_rule_window_guard');
      await q(`ALTER TABLE handyman_tax_rule_windows ADD CONSTRAINT hm_tax_rule_window_no_overlap EXCLUDE USING gist
        (client_id WITH =,transaction_context WITH =,tax_code WITH =,taxpayer_classification WITH =,daterange(effective_from,effective_to,'[)') WITH &&)`);
    }
    assert.equal((await resolveHandymanTaxRule(f.maker,selector(input))).status,'APPROVED');
  });

  it('serializes competing submissions, decisions and overlapping version creation', async () => {
    const f = await fixture(), input = ruleInput(f.clientId);
    const creations = await Promise.allSettled([createHandymanTaxRule(f.maker,input),createHandymanTaxRule(f.maker,input)]);
    assert.equal(creations.filter(x => x.status === 'fulfilled').length,1);
    assert.equal((creations.find(x => x.status === 'rejected') as PromiseRejectedResult).reason.code,'HANDYMAN_TAX_RULE_CONFLICT');
    const r = (creations.find(x => x.status === 'fulfilled') as PromiseFulfilledResult<HandymanTaxRuleView>).value, pin = review(r);
    const submissions = await Promise.allSettled([submitHandymanTaxRule(f.maker,pin),submitHandymanTaxRule(f.maker,pin)]);
    assert.equal(submissions.filter(x => x.status === 'fulfilled').length,1);
    const sub = (submissions.find(x => x.status === 'fulfilled') as PromiseFulfilledResult<TaxRuleApprovalEvent>).value;
    const another = await scopedUser(f.buildingId,['handyman.finance.read','handyman.tax_rule.approve']);
    const outcomes = await Promise.allSettled([decideHandymanTaxRule(f.checker,decide(pin,sub,'APPROVE')),
      decideHandymanTaxRule(another,decide(pin,sub,'REJECT'))]);
    assert.equal(outcomes.filter(x => x.status === 'fulfilled').length,1);
    assert.equal((outcomes.find(x => x.status === 'rejected') as PromiseRejectedResult).reason.code,'HANDYMAN_TAX_RULE_CONFLICT');
    assert.equal((await q('SELECT count(*)::int AS n FROM handyman_tax_rule_approval_events WHERE submission_id=$1',[sub.id])).rows[0].n,1);
  });

  it('prevents overlapping SQL versions despite a stale REPEATABLE READ snapshot', async () => {
    const f = await fixture(), input = ruleInput(f.clientId,{ effectiveTo:day(4) });
    await createHandymanTaxRule(f.maker,input);
    const next = {...input,effectiveFrom:day(4),effectiveTo:day(12),expectedVersion:1};
    const winner = await pool.connect(), loser = await pool.connect();
    try {
      await loser.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await loser.query('SELECT * FROM handyman_tax_rules WHERE client_id=$1',[f.clientId]);
      await winner.query('BEGIN');
      const wp = (await winner.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const lp = (await loser.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await rawRule(winner,next,f.maker,2);
      const pending = rawRule(loser,{...next,effectiveFrom:day(5)},f.maker,2).then(() => null,err => err);
      await waitForBlock(lp,wp); await winner.query('COMMIT');
      const err = await pending; assert.ok(err); assert.ok(['23505','23P01','40001'].includes(err.code),`${err.code}: ${err.message}`);
      await loser.query('ROLLBACK');
      assert.equal((await q('SELECT count(*)::int AS n FROM handyman_tax_rules WHERE client_id=$1 AND taxpayer_classification=$2',
        [f.clientId,input.taxpayerClassification])).rows[0].n,2);
    } finally { await winner.query('ROLLBACK').catch(()=>undefined); await loser.query('ROLLBACK').catch(()=>undefined); winner.release(); loser.release(); }
  });

  it('blocks duplicate decisions under REPEATABLE READ even when its snapshot misses the winner', async () => {
    const f = await fixture(), input = ruleInput(f.clientId), r = await createHandymanTaxRule(f.maker,input), pin = review(r);
    const sub = await submitHandymanTaxRule(f.maker,pin);
    const other = await scopedUser(f.buildingId,['handyman.finance.read','handyman.tax_rule.approve']);
    const winner = await pool.connect(), loser = await pool.connect();
    try {
      await loser.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await loser.query('SELECT count(*) FROM handyman_tax_rule_approval_events');
      await winner.query('BEGIN');
      const wp = (await winner.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const lp = (await loser.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const decision = await rawEvent(winner,pin,f.checker,'APPROVE',sub.id);
      const pending = rawEvent(loser,pin,other,'REJECT',sub.id).then(() => null,err => err);
      await waitForBlock(lp,wp); await winner.query('COMMIT');
      const err = await pending; assert.ok(err); assert.ok(['23505','40001'].includes(err.code),`${err.code}: ${err.message}`);
      await loser.query('ROLLBACK');
      assert.equal((await q('SELECT count(*)::int AS n FROM handyman_tax_rule_approval_events WHERE submission_id=$1',[sub.id])).rows[0].n,1);
      assert.ok(decision.occurred_at.getTime() > Date.now()-10_000);
    } finally { await winner.query('ROLLBACK').catch(()=>undefined); await loser.query('ROLLBACK').catch(()=>undefined); winner.release(); loser.release(); }
  });

  it('blocks approval racing a prospective closure under REPEATABLE READ', async () => {
    const f = await fixture(), input = ruleInput(f.clientId,{effectiveTo:null}), r = await createHandymanTaxRule(f.maker,input), pin = review(r);
    const sub = await submitHandymanTaxRule(f.maker,pin), closer = await pool.connect(), checker = await pool.connect();
    try {
      await checker.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await checker.query('SELECT * FROM handyman_tax_rule_windows WHERE rule_id=$1',[r.snapshot.id]);
      await closer.query('BEGIN');
      const cp = (await closer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const kp = (await checker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await closer.query(`INSERT INTO handyman_tax_rule_closures(id,rule_id,effective_to,reason,created_by_user_id)
        VALUES($1,$2,$3,'Prospective test closure',$4)`,[id(),r.snapshot.id,day(7),f.maker]);
      const pending = rawEvent(checker,pin,f.checker,'APPROVE',sub.id).then(() => null,err => err);
      await waitForBlock(kp,cp); await closer.query('COMMIT');
      const err = await pending; assert.ok(err); assert.ok(['40001','23514'].includes(err.code),`${err.code}: ${err.message}`);
      await checker.query('ROLLBACK');
      assert.deepEqual(await resolveHandymanTaxRule(f.maker,selector(input)),{status:'NOT_APPROVED'});
      await assert.rejects(decideHandymanTaxRule(f.checker,decide(pin,sub,'APPROVE')),code('HANDYMAN_TAX_RULE_CONFLICT'));
      assert.equal((await decideHandymanTaxRule(f.checker,decide(pin,sub,'REJECT'))).eventType,'REJECT');
    } finally { await closer.query('ROLLBACK').catch(()=>undefined); await checker.query('ROLLBACK').catch(()=>undefined); closer.release(); checker.release(); }
  });

  it('refuses destructive rollback of populated rule or approval history', async () => {
    assert.equal(await migrateDown(pool), '0500_handyman_bm_commission_tax_cases');
    assert.equal(await migrateDown(pool),'0499_handyman_customer_tax_classifications');
    assert.equal(await migrateDown(pool),'0498_handyman_request_buyer_bindings');
    await assert.rejects(migrateDown(pool),/Refusing to remove populated tax rule history/);
    assert.equal((await q("SELECT count(*)::int AS n FROM schema_migrations WHERE id='0497_handyman_tax_rule_governance'")).rows[0].n,1);
  });
});
