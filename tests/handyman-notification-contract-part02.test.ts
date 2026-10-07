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
  HANDYMAN_NOTIFICATION_CONTRACT,
  handymanNotificationContractFor,
  isHandymanNotificationEventType,
} from '../src/modules/handyman-notifications/handyman-notification-contract';
import { emitHandymanNotificationIntent } from '../src/modules/handyman-notifications/handyman-notification-intent.service';
import { applyToNewSubject } from '../src/modules/applied-slas/applied-sla.service';
import { evaluateBreachForSubject } from '../src/modules/applied-slas/sla-clock-lifecycle.service';
import type { SlaSubjectRef } from '../src/modules/applied-slas/applied-sla.types';
import { slaDefinitionRepository } from '../src/modules/sla-definitions/sla-definition.repository';
import {
  processDueSlaEscalations,
  slaEscalationActionRepository,
} from '../src/modules/sla-escalation-actions';
import { slaEscalationPolicyRepository } from '../src/modules/sla-escalation-policies';
import { createNotificationTemplate } from '../src/modules/notification-templates';
import { notificationSubscriptionRepository } from '../src/modules/notification-subscriptions';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { createAdminUser } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

const PORT = 55522, DIR = '/tmp/asentra-hm16-p2';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = 'asentra_test';
process.env.DB_HOST = '127.0.0.1';
process.env.DB_PORT = String(PORT);
process.env.DB_USER = 'postgres';
process.env.DB_PASSWORD = 'postgres';
process.env.DB_SSL = 'false';

let pg: EmbeddedPostgres | null = null, pool: Pool | null = null, db: DatabaseConfig | null = null;
let admin = '', client = '', building = '';
const s = () => randomUUID().slice(0, 8).toUpperCase();

function ready(t: TestContext): boolean {
  if (!db || !pool) { t.skip('database unavailable'); return false; }
  return true;
}

function validationField(field: string) {
  return (e: unknown) => Array.isArray((e as { details?: unknown[] }).details)
    && (e as { details: Array<{ field?: string }> }).details.some((d) => d.field === field);
}

async function notificationsFor(entityId: string) {
  return (await pool!.query<{
    template_key: string; source_entity_type: string; source_event_type: string;
    navigation_target_type: string | null;
  }>(
    `SELECT template_key, source_entity_type, source_event_type, navigation_target_type
       FROM notifications WHERE source_entity_id=$1 ORDER BY created_at`, [entityId])).rows;
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
  admin = (await createAdminUser()).userId;
  const c = await clientService.createClient({ code: `C_${s()}`, name: 'HM16 Notify Client' });
  const p = await propertyService.createProperty({ clientId: c.id, code: `P_${s()}`, name: 'P' });
  const b = await buildingService.createBuilding({ propertyId: p.id, code: `B_${s()}`, name: 'B' });
  client = c.id;
  building = b.id;
  // Escalation audiences are Building-scoped (governance §5.5): the recipient
  // must hold access to the breach's Building to be resolved.
  await buildingAssignmentService.createAssignment(admin, { buildingId: b.id });
});

after(async () => {
  if (pool) await closePool(pool);
  if (pg) await pg.stop();
  await rm(DIR, { recursive: true, force: true });
});

describe('CR-HM-16 PART 02 — Handyman notification event contract (frozen)', () => {
  it('admits the SLA chain and the certified domain vocabulary with meaning/audience/template', () => {
    assert.equal(HANDYMAN_NOTIFICATION_CONTRACT.length, 12);
    const seen = new Set<string>();
    for (const entry of HANDYMAN_NOTIFICATION_CONTRACT) {
      assert.ok(!seen.has(entry.eventType), `${entry.eventType} admitted once`);
      seen.add(entry.eventType);
      assert.ok(entry.meaning.length > 10, `${entry.eventType} has a real meaning`);
      assert.ok(entry.templateKey.length > 0);
      assert.ok(entry.audience === 'SUBSCRIPTION_RULE' || entry.audience === 'SLA_ESCALATION_POLICY');
    }
    for (const sla of ['SLA_CLOCK_BREACHED', 'SLA_ESCALATION_TRIGGERED'] as const) {
      assert.equal(handymanNotificationContractFor(sla)?.audience, 'SLA_ESCALATION_POLICY');
    }
    assert.ok(isHandymanNotificationEventType('HANDYMAN_QUOTATION_ISSUED'));
    assert.ok(!isHandymanNotificationEventType('WORK_ORDER_ASSIGNED'));
    assert.ok(!isHandymanNotificationEventType('HANDYMAN_QUOTATION_APPROVED'));
    assert.equal(handymanNotificationContractFor('NOPE'), undefined);
  });

  it('is provider-neutral and channel-free by construction', () => {
    const flat = JSON.stringify(HANDYMAN_NOTIFICATION_CONTRACT).toLowerCase();
    for (const forbidden of ['whatsapp', 'email', 'push', 'sms', 'provider', 'channel', 'smtp', 'http']) {
      assert.ok(!flat.includes(forbidden), `contract must not name ${forbidden}`);
    }
  });
});

describe('CR-HM-16 PART 02 — notification intent seam over BE-26', () => {
  it('fails closed on unadmitted event types and creates zero intent', async (t) => {
    if (!ready(t)) return;
    const before = (await pool!.query<{ n: number }>(`SELECT count(*)::int n FROM notifications`)).rows[0].n;
    await assert.rejects(
      emitHandymanNotificationIntent({
        eventType: 'WORK_ORDER_ASSIGNED', clientId: client,
        entityType: 'HANDYMAN_QUOTATION', entityId: randomUUID(),
      }),
      validationField('eventType'),
    );
    assert.equal((await pool!.query<{ n: number }>(`SELECT count(*)::int n FROM notifications`)).rows[0].n, before);
  });

  it('reacts to an admitted domain event with in-app + outbound intent only', async (t) => {
    if (!ready(t)) return;
    const inAppTemplate = await createNotificationTemplate({
      key: `HM_QUOT_ISSUED_${s()}`, type: 'HANDYMAN_QUOTATION', channel: 'IN_APP',
      subject: 'Quotation {{subjectId}} issued', body: 'Awaiting decision.',
    });
    const emailTemplate = await createNotificationTemplate({
      key: `HM_QUOT_EXPIRED_${s()}`, type: 'HANDYMAN_QUOTATION', channel: 'EMAIL',
      subject: 'Quotation expired', body: 'Awaiting decision.',
    });
    await notificationSubscriptionRepository.create({
      key: `SUB_${s()}`, eventType: 'HANDYMAN_QUOTATION_ISSUED', templateKey: inAppTemplate.key,
      recipientRule: { specs: [{ kind: 'USER', userId: admin }] }, clientId: client,
    });
    await notificationSubscriptionRepository.create({
      key: `SUB_${s()}`, eventType: 'HANDYMAN_QUOTATION_EXPIRED', templateKey: emailTemplate.key,
      recipientRule: { specs: [{ kind: 'USER', userId: admin }] }, clientId: client,
    });
    // The subjects have NO backing domain rows: notifications react to event
    // identity and must never read nor write Handyman lifecycle state.
    const issuedSubjectId = randomUUID();
    const issued = await emitHandymanNotificationIntent({
      eventType: 'HANDYMAN_QUOTATION_ISSUED', clientId: client,
      entityType: 'HANDYMAN_QUOTATION', entityId: issuedSubjectId, buildingId: building,
      variables: { subjectId: issuedSubjectId },
    });
    assert.equal(issued.contract.audience, 'SUBSCRIPTION_RULE');
    assert.equal(issued.inApp.notificationsCreated, 1);
    assert.equal(issued.outbound.deliveriesCreated, 0, 'IN_APP templates are the in-app chain authority');
    const rows = await notificationsFor(issuedSubjectId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source_entity_type, 'HANDYMAN_QUOTATION');
    assert.equal(rows[0].source_event_type, 'HANDYMAN_QUOTATION_ISSUED');
    assert.equal(rows[0].navigation_target_type, null, 'no navigation target is declared');

    const expiredSubjectId = randomUUID();
    const expired = await emitHandymanNotificationIntent({
      eventType: 'HANDYMAN_QUOTATION_EXPIRED', clientId: client,
      entityType: 'HANDYMAN_QUOTATION', entityId: expiredSubjectId, buildingId: building,
    });
    assert.equal(expired.outbound.deliveriesCreated, 1);
    const outbound = (await pool!.query<{ n: number; status: string; channel: string }>(
      `SELECT count(*)::int n, min(status) status, min(channel) channel FROM notification_outbound_deliveries WHERE source_entity_id=$1`,
      [expiredSubjectId])).rows[0];
    assert.equal(outbound.n, 1, 'intent ledger row only; no provider is contacted');
    assert.equal(outbound.status, 'PENDING');
    assert.equal(outbound.channel, 'EMAIL');
  });
});

describe('CR-HM-16 PART 02 — Handyman SLA escalation notification binding', () => {
  it('materializes Handyman escalations and emits SLA_ESCALATION_TRIGGERED intent with Handyman source identity', async (t) => {
    if (!ready(t)) return;
    await slaDefinitionRepository.create({
      clientId: client, code: `N.${s()}`, name: 'Ack', operationalType: 'HANDYMAN_SERVICE_REQUEST',
      responseTargetMinutes: 1, effectiveFrom: '2026-01-01T00:00:00Z',
    });
    // The escalation notification renders from the FROZEN action row (its
    // snapshotted template + recipient rule) through the reused BE-26A record
    // seam — no subscription fan-out and no Handyman domain read happens here.
    const templateKey = (await createNotificationTemplate({
      key: `HM_SLA_ESC_${s()}`, type: 'SLA_ESCALATION', channel: 'IN_APP',
      subject: 'SLA {{subjectType}} {{clockType}} breached at {{breachedAt}}', body: 'Level {{level}}.',
    })).key;
    const policy = await slaEscalationPolicyRepository.createPolicy({
      clientId: client, code: `ESC.${s()}`, name: 'HM esc', operationalType: 'HANDYMAN_SERVICE_REQUEST',
      clockType: 'RESPONSE', effectiveFrom: '2026-01-01T00:00:00Z',
    });
    await slaEscalationPolicyRepository.createLevel({
      policyId: policy.id, level: 1, offsetMinutes: 0, templateKey,
      recipientRule: { specs: [{ kind: 'USER', userId: admin }] },
    });
    const subjectId = randomUUID();
    const createdAt = new Date('2026-09-30T06:00:00Z');
    const ref: SlaSubjectRef = {
      subjectType: 'HANDYMAN_SERVICE_REQUEST', subjectId,
      clientId: client, buildingId: building, workType: null, priority: null,
    };
    const applied = await withTransaction((tx) => applyToNewSubject({ ...ref, createdAt }, tx));
    assert.ok(applied);
    const breachAt = new Date(createdAt.getTime() + 2 * 60000);
    await withTransaction((tx) => evaluateBreachForSubject(ref, 'RESPONSE', breachAt, tx));
    const actions = await slaEscalationActionRepository.listActionsForSubject(subjectId);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].subjectType, 'HANDYMAN_SERVICE_REQUEST');
    assert.equal(actions[0].subjectId, subjectId);
    assert.equal(actions[0].workOrderId, null);
    assert.equal(actions[0].status, 'PENDING');
    const dispatched = await processDueSlaEscalations(new Date(breachAt.getTime() + 1000));
    assert.equal(dispatched.triggered, 1);
    assert.equal(dispatched.notificationsCreated, 1);
    const [action] = await slaEscalationActionRepository.listActionsForSubject(subjectId);
    assert.equal(action.status, 'TRIGGERED');
    assert.equal(action.recipientsResolved, 1);
    const rows = await notificationsFor(subjectId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source_entity_type, 'HANDYMAN_SERVICE_REQUEST');
    assert.equal(rows[0].source_event_type, 'SLA_ESCALATION_TRIGGERED');
    assert.equal(rows[0].navigation_target_type, null, 'Handyman intents declare no Work Order navigation target');
    const events = (await pool!.query<{ event_type: string; entity_type: string }>(
      `SELECT event_type, entity_type FROM operational_events WHERE entity_id=$1 ORDER BY created_at`, [subjectId])).rows;
    assert.ok(events.some((e) => e.event_type === 'SLA_ESCALATION_TRIGGERED' && e.entity_type === 'HANDYMAN_SERVICE_REQUEST'));
    assert.ok(events.some((e) => e.event_type === 'SLA_ESCALATION_SCHEDULED'));
    assert.ok(events.some((e) => e.event_type === 'SLA_CLOCK_BREACHED'));
  });

  it('matches only same-subject-type policies (no FM/Handyman escalation crossover)', async (t) => {
    if (!ready(t)) return;
    await slaDefinitionRepository.create({
      clientId: client, code: `D.${s()}`, name: 'Defect', operationalType: 'HANDYMAN_DEFECT_RECORD',
      resolutionTargetMinutes: 1, effectiveFrom: '2026-01-01T00:00:00Z',
    });
    const subjectId = randomUUID();
    const createdAt = new Date('2026-09-30T07:00:00Z');
    const ref: SlaSubjectRef = {
      subjectType: 'HANDYMAN_DEFECT_RECORD', subjectId,
      clientId: client, buildingId: building, workType: null, priority: null,
    };
    const applied = await withTransaction((tx) => applyToNewSubject({ ...ref, createdAt }, tx));
    assert.ok(applied);
    await withTransaction((tx) => evaluateBreachForSubject(ref, 'RESOLUTION', new Date(createdAt.getTime() + 2 * 60000), tx));
    assert.equal((await slaEscalationActionRepository.listActionsForSubject(subjectId)).length, 0,
      'the HANDYMAN_SERVICE_REQUEST policy never applies to a HANDYMAN_DEFECT_RECORD breach');
  });
});
