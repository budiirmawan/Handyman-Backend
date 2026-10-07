import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp, withTransaction } from '../src/database';
import { applyToNewSubject } from '../src/modules/applied-slas/applied-sla.service';
import { evaluateBreachForSubject } from '../src/modules/applied-slas/sla-clock-lifecycle.service';
import type { SlaSubjectRef } from '../src/modules/applied-slas/applied-sla.types';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import {
  HANDYMAN_PERFORMANCE_INPUT_LAW,
  HANDYMAN_PERFORMANCE_SEPARATION_LAW,
  deriveHandymanProviderPerformance,
  type HandymanProviderPerformanceSnapshot,
} from '../src/modules/handyman-provider-performance';
import { propertyService } from '../src/modules/properties';
import { slaDefinitionRepository } from '../src/modules/sla-definitions/sla-definition.repository';
import { userService } from '../src/modules/users';
import { ensureTestDatabase } from './helpers/postgres';

const PORT = 55524, DIR = '/tmp/asentra-hm16-p4';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = 'asentra_test';
process.env.DB_HOST = '127.0.0.1';
process.env.DB_PORT = String(PORT);
process.env.DB_USER = 'postgres';
process.env.DB_PASSWORD = 'postgres';
process.env.DB_SSL = 'false';

let pg: EmbeddedPostgres | null = null, pool: Pool | null = null, db: DatabaseConfig | null = null;
let clientA = '', buildingA1 = '', buildingA2 = '', clientB = '';

const id = () => randomUUID();
const q = async (text: string, params: unknown[] = []) => pool!.query(text, params);
const FROM = new Date('2026-09-01T00:00:00Z');
const TO = new Date('2026-10-01T00:00:00Z');

function ready(t: TestContext): boolean {
  if (!db || !pool) { t.skip('database unavailable'); return false; }
  return true;
}

async function insertRow(table: string, values: Record<string, unknown>, rowId = id()): Promise<string> {
  const columns = Object.keys(values);
  await q(
    `INSERT INTO ${table} (id, ${columns.join(', ')}) VALUES ($1, ${columns.map((_, i) => `$${i + 2}`).join(', ')})`,
    [rowId, ...Object.values(values)],
  );
  return rowId;
}

async function insertEvent(clientId: string, eventType: string, entityType: string, occurredAt: string, buildingId: string | null = null): Promise<string> {
  return insertRow('operational_events', {
    client_id: clientId,
    event_type: eventType,
    entity_type: entityType,
    entity_id: id(),
    building_id: buildingId,
    summary: `${eventType} fixture.`,
    metadata: {},
    occurred_at: occurredAt,
  });
}

/** Applies the Handyman SLA definition to one subject and returns its ref. */
async function subjectAt(subjectId: string, buildingId: string, createdAt: string): Promise<SlaSubjectRef> {
  const ref: SlaSubjectRef = {
    subjectType: 'HANDYMAN_SERVICE_REQUEST',
    subjectId,
    clientId: clientA,
    buildingId,
    workType: null,
    priority: null,
  };
  const applied = await withTransaction((tx) => applyToNewSubject({ ...ref, createdAt: new Date(createdAt) }, tx));
  assert.ok(applied);
  return ref;
}

async function appliedSlaIdOf(subjectId: string): Promise<string> {
  return (await q(`SELECT id FROM applied_slas WHERE subject_id=$1`, [subjectId])).rows[0].id as string;
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

  const cA = await clientService.createClient({ code: `PA_${s()}`, name: 'Perf Client A' });
  const pA = await propertyService.createProperty({ clientId: cA.id, code: `PP_${s()}`, name: 'PP' });
  const b1 = await buildingService.createBuilding({ propertyId: pA.id, code: `B1_${s()}`, name: 'B1' });
  const b2 = await buildingService.createBuilding({ propertyId: pA.id, code: `B2_${s()}`, name: 'B2' });
  const cB = await clientService.createClient({ code: `PB_${s()}`, name: 'Perf Client B' });
  const pB = await propertyService.createProperty({ clientId: cB.id, code: `PQ_${s()}`, name: 'PQ' });
  const bB = await buildingService.createBuilding({ propertyId: pB.id, code: `BB_${s()}`, name: 'BB' });
  clientA = cA.id;
  buildingA1 = b1.id;
  buildingA2 = b2.id;
  clientB = cB.id;

  await slaDefinitionRepository.create({
    clientId: clientA, code: `PERF.${s()}`, name: 'Perf SR',
    operationalType: 'HANDYMAN_SERVICE_REQUEST',
    responseTargetMinutes: 1, resolutionTargetMinutes: 1,
    effectiveFrom: '2026-01-01T00:00:00Z',
  });

  // subj-1: RESPONSE met (satisfied, never breached); RESOLUTION missed (first-write breach).
  const subj1 = id();
  const ref1 = await subjectAt(subj1, buildingA1, '2026-09-05T00:00:00Z');
  await q(
    `UPDATE sla_clocks SET status='SATISFIED', satisfied_at='2026-09-05T00:00:30Z'
      WHERE applied_sla_id=$1 AND clock_type='RESPONSE'`,
    [await appliedSlaIdOf(subj1)],
  );
  await withTransaction((tx) => evaluateBreachForSubject(ref1, 'RESOLUTION', new Date('2026-09-05T00:02:00Z'), tx));
  // subj-2: RESPONSE missed (breached, still running); RESOLUTION still running clean.
  const subj2 = id();
  const ref2 = await subjectAt(subj2, buildingA1, '2026-09-06T00:00:00Z');
  await withTransaction((tx) => evaluateBreachForSubject(ref2, 'RESPONSE', new Date('2026-09-06T00:02:00Z'), tx));
  // subj-3 (building A2): both clocks running clean — building-scope fixture.
  await subjectAt(id(), buildingA2, '2026-09-07T00:00:00Z');

  // FM firewall fixture: a satisfied Work Order RESPONSE clock that must never
  // enter Handyman performance.
  const user = await userService.createUser({ email: `perf-${s().toLowerCase()}@example.com`, displayName: 'Perf Fixture' });
  const woId = await insertRow('work_orders', {
    client_id: clientA, building_id: buildingA1,
    work_order_number: `WO-${s()}`, title: 'FM WO', work_type: 'CORRECTIVE',
    status: 'OPEN', created_by_user_id: user.id,
  });
  const woDef = await slaDefinitionRepository.create({
    clientId: clientA, code: `FMP.${s()}`, name: 'FM WO SLA',
    operationalType: 'WORK_ORDER', responseTargetMinutes: 5,
    effectiveFrom: '2026-01-01T00:00:00Z',
  });
  const woApplied = await insertRow('applied_slas', {
    sla_definition_id: woDef.id, work_order_id: woId,
    client_id: clientA, building_id: buildingA1,
    definition_code: woDef.code, operational_type: 'WORK_ORDER',
    work_order_work_type: 'CORRECTIVE', work_order_priority: 'MEDIUM',
    response_target_minutes: 5,
    definition_effective_from: '2026-01-01T00:00:00Z',
    applied_at: '2026-09-06T00:00:00Z',
  });
  await insertRow('sla_clocks', {
    applied_sla_id: woApplied, clock_type: 'RESPONSE', target_minutes: 5,
    started_at: '2026-09-06T00:00:00Z', status: 'SATISFIED',
    satisfied_at: '2026-09-06T00:01:00Z',
  });

  // Certified domain events (governed input) + decoys that must never count.
  await insertEvent(clientA, 'HANDYMAN_QUOTATION_ISSUED', 'HANDYMAN_QUOTATION', '2026-09-10T10:00:00Z', buildingA1);
  await insertEvent(clientA, 'HANDYMAN_QUOTATION_ISSUED', 'HANDYMAN_QUOTATION', '2026-09-12T10:00:00Z', buildingA1);
  await insertEvent(clientA, 'HANDYMAN_QUOTATION_EXPIRED', 'HANDYMAN_QUOTATION', '2026-09-15T10:00:00Z', buildingA1);
  await insertEvent(clientA, 'HANDYMAN_QUOTATION_ISSUED', 'HANDYMAN_QUOTATION', '2026-08-01T10:00:00Z', buildingA1); // out of window
  await insertEvent(clientA, 'HANDYMAN_QUOTATION_ISSUED', 'WORK_ORDER', '2026-09-11T10:00:00Z', buildingA1); // FM entity
  await insertEvent(clientB, 'HANDYMAN_QUOTATION_ISSUED', 'HANDYMAN_QUOTATION', '2026-09-11T10:00:00Z'); // other client
});

function s(): string {
  return randomUUID().slice(0, 8).toUpperCase();
}

after(async () => {
  if (pool) await closePool(pool);
  if (pg) await pg.stop();
  await rm(DIR, { recursive: true, force: true });
});

function counts(snapshot: HandymanProviderPerformanceSnapshot, milestone: string) {
  return snapshot.milestoneAdherence.find((m) => m.milestone === milestone)!;
}

describe('CR-HM-16 PART 04 — provider performance contract (frozen laws)', () => {
  it('binds the derivation to governed facts only and states the separations', () => {
    assert.equal(HANDYMAN_PERFORMANCE_INPUT_LAW.nothingElseIsAnInput, true);
    assert.equal(HANDYMAN_PERFORMANCE_INPUT_LAW.inputs.length, 2);
    assert.ok(HANDYMAN_PERFORMANCE_INPUT_LAW.excludedInputs.includes('manual KPI values'));
    assert.ok(HANDYMAN_PERFORMANCE_INPUT_LAW.excludedInputs.includes('outbox/webhook deliveries'));
    const law = HANDYMAN_PERFORMANCE_SEPARATION_LAW;
    assert.equal(law.derivedAnalyticsOnly, true);
    for (const forbidden of ['manualKpiEntry', 'transactionalAuthority', 'lifecycleAuthority', 'entitlementSettlementPricingPaymentInput', 'inferredFromControlPlane', 'writtenByClients', 'mutatesSlaFacts', 'slaBreachImpliesPerformanceWrite', 'persistedKpiRows', 'schedulerOrEngine'] as const) {
      assert.equal(law[forbidden], false, `${forbidden} must stay false`);
    }
  });
});

describe('CR-HM-16 PART 04 — derived read model from governed facts', () => {
  it('derives milestone adherence and event truth from the governed inputs only', async (t) => {
    if (!ready(t)) return;
    const snapshot = await deriveHandymanProviderPerformance({ clientId: clientA, from: FROM, to: TO });
    assert.deepEqual(snapshot.scope, {
      clientId: clientA,
      buildingId: null,
      from: FROM.toISOString(),
      to: TO.toISOString(),
    });
    assert.deepEqual(snapshot.inputs, { slaClocks: 6, operationalEvents: 3 });

    assert.equal(snapshot.milestoneAdherence.length, 9);
    assert.deepEqual(
      snapshot.milestoneAdherence.map((m) => m.milestone),
      ['REQUEST_ACKNOWLEDGEMENT', 'QUOTATION_TURNAROUND', 'PROVIDER_ACCEPT_DECLINE', 'WORKER_ASSIGNMENT', 'ARRIVAL', 'WORK_COMPLETION', 'DEFECT_CLOSURE', 'WARRANTY_RESPONSE', 'WARRANTY_REWORK'],
    );
    assert.deepEqual(counts(snapshot, 'REQUEST_ACKNOWLEDGEMENT'), {
      milestone: 'REQUEST_ACKNOWLEDGEMENT',
      subjectType: 'HANDYMAN_SERVICE_REQUEST',
      clockType: 'RESPONSE',
      clocks: 3, satisfied: 1, satisfiedWithinTarget: 1, breached: 1,
      terminated: 0, running: 2, attainmentPercent: 50,
    });
    assert.deepEqual(counts(snapshot, 'QUOTATION_TURNAROUND'), {
      milestone: 'QUOTATION_TURNAROUND',
      subjectType: 'HANDYMAN_SERVICE_REQUEST',
      clockType: 'RESOLUTION',
      clocks: 3, satisfied: 0, satisfiedWithinTarget: 0, breached: 1,
      terminated: 0, running: 3, attainmentPercent: 0,
    });
    for (const quiet of ['PROVIDER_ACCEPT_DECLINE', 'WORKER_ASSIGNMENT', 'ARRIVAL', 'WORK_COMPLETION', 'DEFECT_CLOSURE', 'WARRANTY_RESPONSE', 'WARRANTY_REWORK']) {
      assert.deepEqual(counts(snapshot, quiet), {
        milestone: quiet,
        subjectType: counts(snapshot, quiet).subjectType,
        clockType: counts(snapshot, quiet).clockType,
        clocks: 0, satisfied: 0, satisfiedWithinTarget: 0, breached: 0,
        terminated: 0, running: 0, attainmentPercent: null,
      }, `${quiet} is zero-filled`);
    }

    assert.deepEqual(snapshot.responseResolutionAttainment.map((r) => [r.clockType, r.clocks, r.satisfiedWithinTarget, r.breached, r.attainmentPercent]), [
      ['RESPONSE', 3, 1, 1, 50],
      ['RESOLUTION', 3, 0, 1, 0],
    ]);

    assert.deepEqual(snapshot.operationalTruth, [
      {
        eventType: 'HANDYMAN_QUOTATION_EXPIRED', occurrences: 1,
        firstOccurredAt: '2026-09-15T10:00:00.000Z', lastOccurredAt: '2026-09-15T10:00:00.000Z',
      },
      {
        eventType: 'HANDYMAN_QUOTATION_ISSUED', occurrences: 2,
        firstOccurredAt: '2026-09-10T10:00:00.000Z', lastOccurredAt: '2026-09-12T10:00:00.000Z',
      },
    ]);

    // Published contract is derived-state-clean: no FM truth, no financial
    // authority, no client-writable field anywhere in the shape.
    const flat = JSON.stringify(snapshot).toLowerCase();
    for (const forbidden of ['work_order', 'work-order', 'overdue', 'entitlement', 'settlement', 'pricing', 'payment', 'kpi', 'whatsapp', 'email', 'sms', 'push', 'channel', 'smtp']) {
      assert.ok(!flat.includes(forbidden), `snapshot must not carry ${forbidden}`);
    }
  });

  it('excludes FM SLA outcomes and scopes by building and client', async (t) => {
    if (!ready(t)) return;
    const b1 = await deriveHandymanProviderPerformance({ clientId: clientA, buildingId: buildingA1, from: FROM, to: TO });
    // subj-1 + subj-2 only: the FM Work Order clock (also building A1) is excluded.
    assert.deepEqual(
      [counts(b1, 'REQUEST_ACKNOWLEDGEMENT').clocks, counts(b1, 'REQUEST_ACKNOWLEDGEMENT').satisfied, counts(b1, 'REQUEST_ACKNOWLEDGEMENT').breached],
      [2, 1, 1],
    );
    assert.deepEqual(b1.inputs, { slaClocks: 4, operationalEvents: 3 });
    const b2 = await deriveHandymanProviderPerformance({ clientId: clientA, buildingId: buildingA2, from: FROM, to: TO });
    assert.deepEqual(
      [counts(b2, 'REQUEST_ACKNOWLEDGEMENT').clocks, counts(b2, 'REQUEST_ACKNOWLEDGEMENT').attainmentPercent],
      [1, null],
    );
    assert.deepEqual(b2.inputs, { slaClocks: 2, operationalEvents: 0 });
    const other = await deriveHandymanProviderPerformance({ clientId: clientB, from: FROM, to: TO });
    assert.deepEqual(other.inputs, { slaClocks: 0, operationalEvents: 1 });
    assert.equal(other.operationalTruth[0]!.occurrences, 1);
  });

  it('is read-only, deterministic, and blind to outbox/notification/control-plane rows', async (t) => {
    if (!ready(t)) return;
    const snapshot1 = await deriveHandymanProviderPerformance({ clientId: clientA, from: FROM, to: TO });

    // Firewalls: outbox marker, notification record, and control-plane row
    // appear AFTER the inputs — none of them may move the derivation.
    const someEvent = (await q(`SELECT id FROM operational_events WHERE client_id=$1 LIMIT 1`, [clientA])).rows[0].id as string;
    await insertRow('integration_outbox_events', {
      operational_event_id: someEvent, client_id: clientA, event_type: 'HANDYMAN_QUOTATION_ISSUED',
      entity_type: 'HANDYMAN_QUOTATION', entity_id: id(), payload: '{}', occurred_at: '2026-09-10T10:00:00Z',
    });
    const user = await userService.createUser({ email: `perf-${s().toLowerCase()}@example.com`, displayName: 'Perf Noise' });
    await insertRow('notifications', {
      client_id: clientA, recipient_user_id: user.id, type: 'HANDYMAN_QUOTATION', channel: 'IN_APP',
      title: 'Noise', body: 'Noise', source_entity_type: 'HANDYMAN_QUOTATION', source_entity_id: id(),
    });
    await insertRow('saas_products', { code: `SP_${s()}`, name: 'Control Plane Noise', status: 'ACTIVE' });

    const snapshot2 = await deriveHandymanProviderPerformance({ clientId: clientA, from: FROM, to: TO });
    const stable = (snap: HandymanProviderPerformanceSnapshot) => ({
      scope: snap.scope, inputs: snap.inputs,
      responseResolutionAttainment: snap.responseResolutionAttainment,
      milestoneAdherence: snap.milestoneAdherence,
      operationalTruth: snap.operationalTruth,
    });
    assert.deepEqual(stable(snapshot2), stable(snapshot1), 'derivation is deterministic and blind to non-input rows');

    const watched = async () => (await q(
      `SELECT (SELECT count(*)::int FROM operational_events) events,
              (SELECT count(*)::int FROM sla_clocks) clocks,
              (SELECT count(*)::int FROM applied_slas) applied,
              (SELECT count(*)::int FROM notifications) notifications,
              (SELECT count(*)::int FROM integration_outbox_events) outbox,
              (SELECT count(*)::int FROM sla_escalation_actions) escalations,
              (SELECT count(*)::int FROM request_idempotency_records) idempotency,
              (SELECT coalesce(sum(extract(epoch FROM updated_at)),0) FROM sla_clocks) clockTouch`,
    )).rows[0];
    const beforeCounts = await watched();
    await deriveHandymanProviderPerformance({ clientId: clientA, from: FROM, to: TO });
    const afterCounts = await watched();
    assert.deepEqual(afterCounts, beforeCounts, 'derivation writes nothing — SLA/notification/audit/outbox state untouched');
    assert.equal(afterCounts.clockTouch, beforeCounts.clockTouch);
  });
});
