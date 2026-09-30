import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp, withTransaction } from '../src/database';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import {
  HANDYMAN_SLA_SUBJECT_MILESTONES,
  HANDYMAN_SLA_SUBJECT_TYPES,
  isHandymanSlaSubjectType,
} from '../src/modules/sla-definitions/handyman-sla-subjects';
import { parseCreateBody } from '../src/modules/sla-definitions/sla-definition.validation';
import { slaDefinitionRepository } from '../src/modules/sla-definitions/sla-definition.repository';
import {
  applyToNewSubject,
  processDueSlaClocks,
} from '../src/modules/applied-slas/applied-sla.service';
import {
  evaluateBreachForSubject,
  pauseResolutionClockForSubject,
  resumeResolutionClockForSubject,
  satisfyClockForSubject,
  terminateClocksForSubject,
} from '../src/modules/applied-slas/sla-clock-lifecycle.service';
import { appliedSlaRepository } from '../src/modules/applied-slas/applied-sla.repository';
import type { SlaSubjectRef } from '../src/modules/applied-slas/applied-sla.types';
import { createAdminUser } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

const PORT = 55521, DIR = '/tmp/asentra-hm16-p1';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = 'asentra_test';
process.env.DB_HOST = '127.0.0.1';
process.env.DB_PORT = String(PORT);
process.env.DB_USER = 'postgres';
process.env.DB_PASSWORD = 'postgres';
process.env.DB_SSL = 'false';

let pg: EmbeddedPostgres | null = null, pool: Pool | null = null, db: DatabaseConfig | null = null;
let client = '', building = '', actor = '';
const s = () => randomUUID().slice(0, 8).toUpperCase();

function ready(t: TestContext): boolean {
  if (!db || !pool) { t.skip('database unavailable'); return false; }
  return true;
}

function subjectRef(subjectType: (typeof HANDYMAN_SLA_SUBJECT_TYPES)[number], subjectId: string, workType: string | null = null): SlaSubjectRef {
  return { subjectType, subjectId, clientId: client, buildingId: building, workType, priority: null };
}

async function eventsFor(entityId: string) {
  return (await pool!.query<{ event_type: string; entity_type: string; entity_id: string }>(
    `SELECT event_type, entity_type, entity_id FROM operational_events WHERE entity_id=$1 ORDER BY created_at, event_type`, [entityId])).rows;
}

function validationField(field: string) {
  return (e: unknown) => Array.isArray((e as { details?: unknown[] }).details)
    && (e as { details: Array<{ field?: string }> }).details.some((d) => d.field === field);
}

async function escalationRows() {
  return (await pool!.query<{ n: number }>(`SELECT count(*)::int n FROM sla_escalation_actions`)).rows[0].n;
}

before(async () => {
  await rm(DIR, { recursive: true, force: true });
  await mkdir(DIR, { recursive: true });
  pg = new EmbeddedPostgres({ databaseDir: DIR, port: PORT, user: 'postgres', password: '', persistent: true, authMethod: 'trust' });
  await pg.initialise();
  await pg.start();
  const a = pg.getPgClient('postgres', '127.0.0.1');
  await a.connect();
  await a.query('CREATE DATABASE asentra_test');
  await a.end();
  db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  const admin = await createAdminUser();
  actor = admin.userId;
  const c = await clientService.createClient({ code: `C_${s()}`, name: 'HM16 Client' });
  const p = await propertyService.createProperty({ clientId: c.id, code: `P_${s()}`, name: 'P' });
  const b = await buildingService.createBuilding({ propertyId: p.id, code: `B_${s()}`, name: 'B' });
  client = c.id;
  building = b.id;
});

after(async () => {
  if (pool) await closePool(pool);
  if (pg) await pg.stop();
  await rm(DIR, { recursive: true, force: true });
});

describe('CR-HM-16 PART 01 — Handyman milestone vocabulary (frozen)', () => {
  it('exposes exactly the closed Handyman subject-type vocabulary', () => {
    assert.deepEqual([...HANDYMAN_SLA_SUBJECT_TYPES], [
      'HANDYMAN_SERVICE_REQUEST',
      'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT',
      'HANDYMAN_EXECUTION_SCOPE',
      'HANDYMAN_DEFECT_RECORD',
      'HANDYMAN_SERVICE_WARRANTY_CLAIM',
    ]);
    for (const t of HANDYMAN_SLA_SUBJECT_TYPES) assert.ok(isHandymanSlaSubjectType(t));
    assert.ok(!isHandymanSlaSubjectType('WORK_ORDER'), 'Work Order is not a Handyman subject type');
    assert.ok(!isHandymanSlaSubjectType('INCIDENT'));
  });

  it('binds all nine capability-map milestones to engine clock metrics', () => {
    assert.deepEqual(
      [...HANDYMAN_SLA_SUBJECT_MILESTONES].map((m) => m.milestone).sort(),
      ['ARRIVAL', 'DEFECT_CLOSURE', 'PROVIDER_ACCEPT_DECLINE', 'QUOTATION_TURNAROUND',
        'REQUEST_ACKNOWLEDGEMENT', 'WARRANTY_RESPONSE', 'WARRANTY_REWORK',
        'WORK_COMPLETION', 'WORKER_ASSIGNMENT'].sort(),
    );
    const coords = new Set<string>();
    for (const m of HANDYMAN_SLA_SUBJECT_MILESTONES) {
      assert.ok(isHandymanSlaSubjectType(m.subjectType), `${m.milestone} binds a Handyman subject type`);
      assert.ok(m.clockType === 'RESPONSE' || m.clockType === 'RESOLUTION', `${m.milestone} reuses engine clock metrics only`);
      const key = `${m.subjectType}:${m.clockType}`;
      assert.ok(!coords.has(key), `coordinate ${key} claimed once`);
      coords.add(key);
    }
  });
});

describe('CR-HM-16 PART 01 — definition subject-type extension', () => {
  it('accepts Handyman subject types and rejects unknown operational types', () => {
    const ok = parseCreateBody({
      code: `D.${s()}`, name: 'Ack SLA', operationalType: 'HANDYMAN_SERVICE_REQUEST',
      responseTargetMinutes: 30, effectiveFrom: '2026-01-01T00:00:00Z',
    });
    assert.equal(ok.operationalType, 'HANDYMAN_SERVICE_REQUEST');
    for (const bad of ['INCIDENT', 'HANDYMAN_UNKNOWN', 'HANDYMAN_QUOTATION', '']) {
      assert.throws(() => parseCreateBody({
        code: `D.${s()}`, name: 'X', operationalType: bad,
        responseTargetMinutes: 5, effectiveFrom: '2026-01-01T00:00:00Z',
      }), validationField('operationalType'), `rejects ${bad || 'empty'}`);
    }
  });

  it('persists Handyman definitions in the shared engine', async (t) => {
    if (!ready(t)) return;
    const d = await slaDefinitionRepository.create({
      clientId: client, code: `D.${s()}`, name: 'Handyman ack', operationalType: 'HANDYMAN_SERVICE_REQUEST',
      responseTargetMinutes: 30, effectiveFrom: '2026-01-01T00:00:00Z',
    });
    assert.equal(d.operationalType, 'HANDYMAN_SERVICE_REQUEST');
  });
});

describe('CR-HM-16 PART 01 — Handyman subject binding over the shared engine', () => {
  it('binds a subject with immutable snapshot, milestone clocks and engine events', async (t) => {
    if (!ready(t)) return;
    await slaDefinitionRepository.create({
      clientId: client, code: `D.${s()}`, name: 'Bind', operationalType: 'HANDYMAN_EXECUTION_SCOPE',
      workType: 'ELECTRICAL', responseTargetMinutes: 30, resolutionTargetMinutes: 120,
      effectiveFrom: '2026-01-01T00:00:00Z',
    });
    const subjectId = randomUUID();
    const createdAt = new Date('2026-09-30T01:00:00Z');
    const applied = await withTransaction((tx) => applyToNewSubject(
      { subjectType: 'HANDYMAN_EXECUTION_SCOPE', subjectId, clientId: client, buildingId: building, workType: 'ELECTRICAL', createdAt }, tx));
    assert.ok(applied);
    assert.equal(applied!.subjectId, subjectId);
    assert.equal(applied!.workOrderId, null);
    assert.equal(applied!.operationalType, 'HANDYMAN_EXECUTION_SCOPE');
    assert.equal(applied!.subjectWorkType, 'ELECTRICAL');
    assert.equal(applied!.workOrderWorkType, null);
    assert.equal(applied!.responseTargetMinutes, 30);
    assert.equal(applied!.resolutionTargetMinutes, 120);
    const clocks = await appliedSlaRepository.listClocks(applied!.id);
    assert.deepEqual(clocks.map((c) => c.clockType).sort(), ['RESOLUTION', 'RESPONSE']);
    assert.ok(clocks.every((c) => c.startedAt.toISOString() === createdAt.toISOString()), 'clocks start at the subject creation instant');
    const events = await eventsFor(subjectId);
    assert.deepEqual(events.map((e) => `${e.event_type}/${e.entity_type}`), [
      'SLA_APPLIED/HANDYMAN_EXECUTION_SCOPE',
      'SLA_CLOCK_CREATED/HANDYMAN_EXECUTION_SCOPE',
      'SLA_CLOCK_CREATED/HANDYMAN_EXECUTION_SCOPE',
    ]);
  });

  it('enforces one applied SLA per subject and rejects non-Handyman bindings', async (t) => {
    if (!ready(t)) return;
    await slaDefinitionRepository.create({
      clientId: client, code: `D.${s()}`, name: 'Generic scope', operationalType: 'HANDYMAN_EXECUTION_SCOPE',
      resolutionTargetMinutes: 600, effectiveFrom: '2026-01-01T00:00:00Z',
    });
    const subjectId = randomUUID();
    const bind = () => withTransaction((tx) => applyToNewSubject(
      { subjectType: 'HANDYMAN_EXECUTION_SCOPE', subjectId, clientId: client, buildingId: building, createdAt: new Date() }, tx));
    await bind();
    await assert.rejects(bind, /duplicate key|23505/i);
    await assert.rejects(
      withTransaction((tx) => applyToNewSubject(
        { subjectType: 'WORK_ORDER', subjectId: randomUUID(), clientId: client, buildingId: building, createdAt: new Date() } as never, tx)),
      validationField('subjectType'),
    );
  });

  it('reuses the frozen definition-selection law for subjects', async (t) => {
    if (!ready(t)) return;
    const wide = `SEL.${s()}`, narrow = `SEL.${s()}`;
    await slaDefinitionRepository.create({
      clientId: client, code: wide, name: 'Wide', operationalType: 'HANDYMAN_SERVICE_REQUEST',
      resolutionTargetMinutes: 600, effectiveFrom: '2026-01-01T00:00:00Z',
    });
    await slaDefinitionRepository.create({
      clientId: client, buildingId: building, code: narrow, name: 'Narrow', operationalType: 'HANDYMAN_SERVICE_REQUEST',
      resolutionTargetMinutes: 601, effectiveFrom: '2026-01-01T00:00:00Z',
    });
    const subjectId = randomUUID();
    const applied = await withTransaction((tx) => applyToNewSubject(
      { subjectType: 'HANDYMAN_SERVICE_REQUEST', subjectId, clientId: client, buildingId: building, createdAt: new Date() }, tx));
    assert.equal(applied?.definitionCode, narrow, 'Building scope wins (specificity 4)');
    const mismatch = await withTransaction((tx) => applyToNewSubject(
      { subjectType: 'HANDYMAN_DEFECT_RECORD', subjectId: randomUUID(), clientId: client, buildingId: building, workType: 'NOT_CONFIGURED', createdAt: new Date() }, tx));
    assert.equal(mismatch, null, 'a workType-narrowed definition never binds an unmatched subject');
    await slaDefinitionRepository.create({
      clientId: client, code: `SEL.${s()}`, name: 'A', operationalType: 'HANDYMAN_DEFECT_RECORD',
      workType: 'AMBIG', resolutionTargetMinutes: 1, effectiveFrom: '2026-01-01T00:00:00Z',
    });
    await slaDefinitionRepository.create({
      clientId: client, code: `SEL.${s()}`, name: 'B', operationalType: 'HANDYMAN_DEFECT_RECORD',
      workType: 'AMBIG', resolutionTargetMinutes: 2, effectiveFrom: '2026-01-01T00:00:00Z',
    });
    await assert.rejects(
      withTransaction((tx) => applyToNewSubject(
        { subjectType: 'HANDYMAN_DEFECT_RECORD', subjectId: randomUUID(), clientId: client, buildingId: building, workType: 'AMBIG', createdAt: new Date() }, tx)),
      /ambiguous/,
      'equal specificity fails closed',
    );
  });
});

describe('CR-HM-16 PART 01 — clock/pause/breach authority reuse', () => {
  it('pauses with SUBJECT_ON_HOLD and reuses first-write-idempotent breach + escalation boundary', async (t) => {
    if (!ready(t)) return;
    await slaDefinitionRepository.create({
      clientId: client, code: `L.${s()}`, name: 'Life', operationalType: 'HANDYMAN_SERVICE_WARRANTY_CLAIM',
      responseTargetMinutes: 1, resolutionTargetMinutes: 1, effectiveFrom: '2026-01-01T00:00:00Z',
    });
    const subjectId = randomUUID();
    const createdAt = new Date('2026-09-30T02:00:00Z');
    const ref = subjectRef('HANDYMAN_SERVICE_WARRANTY_CLAIM', subjectId);
    const applied = await withTransaction((tx) => applyToNewSubject({ ...ref, createdAt }, tx));
    assert.ok(applied);
    const at = (min: number) => new Date(createdAt.getTime() + min * 60000);
    await withTransaction((tx) => pauseResolutionClockForSubject(ref, at(1), actor, tx));
    const paused = (await pool!.query<{ pause_source: string }>(
      `SELECT p.pause_source FROM sla_clock_pause_intervals p JOIN sla_clocks c ON c.id=p.sla_clock_id WHERE c.applied_sla_id=$1`, [applied!.id])).rows;
    assert.equal(paused.length, 1);
    assert.equal(paused[0].pause_source, 'SUBJECT_ON_HOLD');
    await withTransaction((tx) => resumeResolutionClockForSubject(ref, at(2), actor, tx));
    const first = await withTransaction((tx) => evaluateBreachForSubject(ref, 'RESPONSE', at(2), tx));
    assert.ok(first && first.breachedAt, 'breach fact persists through the shared first-write writer');
    await withTransaction((tx) => evaluateBreachForSubject(ref, 'RESPONSE', at(3), tx));
    assert.equal((await eventsFor(subjectId)).filter((e) => e.event_type === 'SLA_CLOCK_BREACHED').length, 1,
      'SLA_CLOCK_BREACHED is emitted once (first-write idempotent)');
    assert.equal(await escalationRows(), 0,
      'PART 01 boundary: Handyman breaches do not materialize Work Order-scoped escalation actions');
    await withTransaction((tx) => satisfyClockForSubject(ref, 'RESPONSE', at(3), tx));
    const clocks = await appliedSlaRepository.listClocks(applied!.id);
    const response = clocks.find((c) => c.clockType === 'RESPONSE')!;
    assert.equal(response.status, 'SATISFIED');
    assert.ok(response.satisfiedAt);
  });

  it('terminates both milestone clocks through the shared state machine', async (t) => {
    if (!ready(t)) return;
    await slaDefinitionRepository.create({
      clientId: client, code: `T.${s()}`, name: 'Term', operationalType: 'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT',
      responseTargetMinutes: 1, resolutionTargetMinutes: 1, effectiveFrom: '2026-01-01T00:00:00Z',
    });
    const subjectId = randomUUID();
    const createdAt = new Date('2026-09-30T03:00:00Z');
    const ref = subjectRef('HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT', subjectId);
    const applied = await withTransaction((tx) => applyToNewSubject({ ...ref, createdAt }, tx));
    assert.ok(applied);
    await withTransaction((tx) => terminateClocksForSubject(ref, new Date(createdAt.getTime() + 60000), tx));
    const clocks = await appliedSlaRepository.listClocks(applied!.id);
    assert.ok(clocks.length > 0);
    assert.ok(clocks.every((c) => c.status === 'TERMINATED' && c.terminatedAt));
  });
});

describe('CR-HM-16 PART 01 — due breach path handles Handyman subjects', () => {
  it('persists Handyman breach facts via the single due dispatcher path', async (t) => {
    if (!ready(t)) return;
    await slaDefinitionRepository.create({
      clientId: client, code: `DUE.${s()}`, name: 'Due', operationalType: 'HANDYMAN_DEFECT_RECORD',
      responseTargetMinutes: 1, effectiveFrom: '2026-01-01T00:00:00Z',
    });
    const subjectId = randomUUID();
    const createdAt = new Date(Date.now() - 5 * 60000);
    const ref = subjectRef('HANDYMAN_DEFECT_RECORD', subjectId);
    const applied = await withTransaction((tx) => applyToNewSubject({ ...ref, createdAt }, tx));
    assert.ok(applied);
    const before = await escalationRows();
    const count = await processDueSlaClocks(new Date());
    assert.ok(count >= 1, 'the due path breached the Handyman clock');
    const clocks = await appliedSlaRepository.listClocks(applied!.id);
    const response = clocks.find((c) => c.clockType === 'RESPONSE')!;
    assert.ok(response.breachedAt, 'breach persisted by the shared writer');
    const events = await eventsFor(subjectId);
    assert.equal(events.filter((e) => e.event_type === 'SLA_CLOCK_BREACHED').length, 1);
    assert.ok(events.every((e) => e.entity_type === 'HANDYMAN_DEFECT_RECORD'));
    assert.equal(await escalationRows(), before, 'no escalation materialization for Handyman subjects in PART 01');
  });
});
