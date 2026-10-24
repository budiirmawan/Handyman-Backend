import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import type { Pool } from 'pg';
import { resetAppConfigCache } from '../src/config';
import {
  closePool,
  initDatabase,
  migrateUp,
  withTransaction,
} from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { departmentService } from '../src/modules/departments';
import {
  HANDYMAN_ASSIGNMENT_NOTIFICATION_CONTRACT,
  handymanAssignmentNotificationContractFor,
  isHandymanAssignmentNotificationEventType,
} from '../src/modules/handyman-notifications/handyman-assignment-notification.contract';
import { emitHandymanAssignmentNotificationIntent } from '../src/modules/handyman-notifications/handyman-assignment-notification-producer.service';
import { emitHandymanNotificationIntent } from '../src/modules/handyman-notifications/handyman-notification-intent.service';
import { createNotificationTemplate } from '../src/modules/notification-templates';
import { notificationSubscriptionRepository } from '../src/modules/notification-subscriptions';
import { organizationService } from '../src/modules/organizations';
import { positionService } from '../src/modules/positions';
import { propertyService } from '../src/modules/properties';
import { workOrderService } from '../src/modules/work-orders';
import { workforceService } from '../src/modules/workforce';
import { workforceBuildingAssignmentService } from '../src/modules/workforce-building-assignments';
import { createAdminUser } from './helpers/access';
import { startEmbeddedTestDatabase } from './helpers/embedded-test-db';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-HM-MULTICLIENT-NOTIFICATION-01 PART 01 — the Handyman notification
 * PRODUCER (disposable PostgreSQL integration test suite).
 *
 * The suite proves the PART 01 acceptance criteria:
 *   1. assignment creation emits ONE durable intent,
 *   2. a retry / repeated command does NOT duplicate the intent,
 *   3. the tenant + recipient + assignment scope is enforced,
 *   4. an invalid recipient is rejected,
 *   5. the existing IN_APP delivery flow still works,
 *   6. the existing channels (EMAIL / WHATSAPP) do not regress,
 *   7. notification creation is transactional.
 */

const V1 = '/api/v1';
const DB_DIR = '/tmp/hm-multiclient-notify-part01-pg';
const DB_PORT = 55583;

let dbHandle: { stop: () => Promise<void> } | null = null;
let pool: Pool | null = null;

function suffix(): string {
  return randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
}

function auth(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

type Fixture = Awaited<ReturnType<typeof setupFixture>>;

async function setupFixture() {
  const ops = await createAdminUser();
  const worker = await createAdminUser();

  const client = await clientService.createClient({
    code: `CLI_${suffix()}`,
    name: 'Part01 Notification Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${suffix()}`,
    name: 'Part01 Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix()}`,
    name: 'Part01 Building',
  });
  // Both actors hold an ACTIVE Building context under the fixture's tenant.
  for (const actor of [ops, worker]) {
    await buildingAssignmentService.createAssignment(actor.userId, {
      buildingId: building.id,
    });
  }

  const organization = await organizationService.createOrganization({
    clientId: client.id,
    code: `ORG_${suffix()}`,
    name: 'Part01 Org',
  });
  const department = await departmentService.createDepartment({
    organizationId: organization.id,
    code: `DEP_${suffix()}`,
    name: 'Part01 Dept',
  });
  const position = await positionService.createPosition({
    organizationId: organization.id,
    departmentId: department.id,
    code: `POS_${suffix()}`,
    name: 'Part01 Position',
  });
  const profile = await workforceService.createWorkforceProfile({
    organizationId: organization.id,
    departmentId: department.id,
    positionId: position.id,
    userId: worker.userId,
    employeeCode: `WF_${suffix()}`,
    fullName: 'Notification Worker',
  });
  await workforceBuildingAssignmentService.assignBuildingToWorkforce({
    workforceProfileId: profile.id,
    buildingId: building.id,
  });

  const workOrder = await workOrderService.createWorkOrder({
    clientId: client.id,
    buildingId: building.id,
    workOrderNumber: `WO_${suffix()}`,
    title: 'Perbaikan Pemipa Air',
    workType: 'REPAIR',
    createdByUserId: ops.userId,
  });

  return { ops, worker, client, property, building, profile, workOrder };
}

/** Configures the client-side policy: WHICH channel and WHICH template. */
async function configureOutboundPolicy(
  f: Fixture,
  options: { whatsapp?: boolean } = {},
): Promise<void> {
  const emailTemplate = await createNotificationTemplate({
    key: `TPL_EMAIL_${suffix()}`,
    type: 'WORK_ORDER_ASSIGNMENT',
    channel: 'EMAIL',
    subject: 'Penugasan {{workOrderNumber}}',
    body: 'Anda menerima penugasan {{workOrderNumber}}.',
  });
  await notificationSubscriptionRepository.create({
    key: `SUB_${suffix()}`,
    eventType: 'WORK_ORDER_ASSIGNMENT_PENDING',
    templateKey: emailTemplate.key,
    // The rule names the OPERATIONS actor on purpose: for an assignment event
    // the AUDIENCE is the assignment fact, not the subscription rule. The
    // subscription contributes the channel and the template only.
    recipientRule: { specs: [{ kind: 'USER', userId: f.ops.userId }] },
    clientId: f.client.id,
  });

  if (options.whatsapp) {
    const whatsappTemplate = await createNotificationTemplate({
      key: `TPL_WA_${suffix()}`,
      type: 'WORK_ORDER_ASSIGNMENT',
      channel: 'WHATSAPP',
      subject: 'Penugasan {{workOrderNumber}}',
      body: 'Anda menerima penugasan {{workOrderNumber}}.',
    });
    await notificationSubscriptionRepository.create({
      key: `SUB_${suffix()}`,
      eventType: 'WORK_ORDER_ASSIGNMENT_PENDING',
      templateKey: whatsappTemplate.key,
      recipientRule: { specs: [{ kind: 'USER', userId: f.ops.userId }] },
      clientId: f.client.id,
    });
  }
}

async function countNotifications(filter: {
  recipientUserId?: string;
  sourceEntityId?: string;
  sourceEventType?: string;
}): Promise<number> {
  const clauses = ['1 = 1'];
  const params: unknown[] = [];
  if (filter.recipientUserId) {
    params.push(filter.recipientUserId);
    clauses.push(`recipient_user_id = $${params.length}::uuid`);
  }
  if (filter.sourceEntityId) {
    params.push(filter.sourceEntityId);
    clauses.push(`source_entity_id = $${params.length}::uuid`);
  }
  if (filter.sourceEventType) {
    params.push(filter.sourceEventType);
    clauses.push(`source_event_type = $${params.length}`);
  }
  const result = await pool!.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM notifications WHERE ${clauses.join(' AND ')}`,
    params,
  );
  return result.rows[0].n;
}

async function countOutboundIntents(filter: {
  recipientUserId?: string;
  sourceEntityId?: string;
  sourceEventType?: string;
}): Promise<number> {
  const clauses = ['1 = 1'];
  const params: unknown[] = [];
  if (filter.recipientUserId) {
    params.push(filter.recipientUserId);
    clauses.push(`recipient_user_id = $${params.length}::uuid`);
  }
  if (filter.sourceEntityId) {
    params.push(filter.sourceEntityId);
    clauses.push(`source_entity_id = $${params.length}::uuid`);
  }
  if (filter.sourceEventType) {
    params.push(filter.sourceEventType);
    clauses.push(`source_event_type = $${params.length}`);
  }
  const result = await pool!.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM notification_outbound_deliveries WHERE ${clauses.join(' AND ')}`,
    params,
  );
  return result.rows[0].n;
}

before(async () => {
  await rm(DB_DIR, { recursive: true, force: true });
  dbHandle = await startEmbeddedTestDatabase({ dir: DB_DIR, port: DB_PORT });
  resetAppConfigCache();
  const config = await ensureTestDatabase();
  if (!config) {
    throw new Error('Embedded PostgreSQL test database failed to initialize');
  }
  pool = await initDatabase(config);
  await migrateUp(pool);
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (dbHandle) await dbHandle.stop();
  } finally {
    await rm(DB_DIR, { recursive: true, force: true });
    resetAppConfigCache();
  }
});

describe('CR-HM-MULTICLIENT-NOTIFICATION-01 PART 01 — the assignment notification contract', () => {
  it('names only the real assignment events and stays provider- and channel-free', () => {
    assert.equal(HANDYMAN_ASSIGNMENT_NOTIFICATION_CONTRACT.length, 12);
    const seen = new Set<string>();
    for (const entry of HANDYMAN_ASSIGNMENT_NOTIFICATION_CONTRACT) {
      assert.ok(!seen.has(entry.eventType), `${entry.eventType} admitted once`);
      seen.add(entry.eventType);
      assert.ok(entry.meaning.length > 10, `${entry.eventType} has a real meaning`);
      assert.ok(entry.templateKey.startsWith('HANDYMAN_'));
      assert.ok(
        entry.audience === 'ASSIGNEE' || entry.audience === 'OPERATIONS',
        `${entry.eventType} has a fact-derived audience`,
      );
      assert.ok(
        entry.assignmentTargetType === 'WORK_ORDER_ASSIGNMENT' ||
          entry.assignmentTargetType === 'EXECUTION_SCOPE_ASSIGNMENT' ||
          entry.assignmentTargetType === 'INSPECTOR_VISIT_ASSIGNMENT',
      );
    }

    // The four lifecycle moments of every assignment authority.
    for (const target of [
      'WORK_ORDER_ASSIGNMENT',
      'EXECUTION_SCOPE_ASSIGNMENT',
      'INSPECTOR_VISIT_ASSIGNMENT',
    ] as const) {
      const events = HANDYMAN_ASSIGNMENT_NOTIFICATION_CONTRACT.filter(
        (entry) => entry.assignmentTargetType === target,
      ).map((entry) => entry.eventType);
      assert.equal(events.length, 4, `${target} has four assignment events`);
    }

    // The vocabulary is provider-neutral and channel-free by construction.
    const flat = JSON.stringify(HANDYMAN_ASSIGNMENT_NOTIFICATION_CONTRACT).toLowerCase();
    for (const forbidden of [
      'whatsapp',
      'email',
      'push',
      'sms',
      'provider',
      'channel',
      'smtp',
      'http',
      'vapid',
    ]) {
      assert.ok(!flat.includes(forbidden), `contract must not name ${forbidden}`);
    }
  });

  it('admits an assignment event at the notification seam and rejects an unadmitted one', async () => {
    const admitted = await emitHandymanNotificationIntent({
      eventType: 'WORK_ORDER_ASSIGNMENT_PENDING',
      clientId: randomUUID(),
      entityType: 'WORK_ORDER_ASSIGNMENT',
      entityId: randomUUID(),
      recipients: [],
    });
    assert.equal(admitted.contract.audience, 'ASSIGNEE');
    assert.equal(
      admitted.contract.templateKey,
      'HANDYMAN_WORK_ORDER_ASSIGNMENT_PENDING',
    );

    await assert.rejects(
      emitHandymanNotificationIntent({
        eventType: 'WORK_ORDER_ASSIGNED',
        clientId: randomUUID(),
        entityType: 'WORK_ORDER_ASSIGNMENT',
        entityId: randomUUID(),
      }),
      (error: unknown) =>
        Array.isArray((error as { details?: unknown[] }).details) &&
        (error as { details: Array<{ field?: string }> }).details.some(
          (detail) => detail.field === 'eventType',
        ),
    );
  });
});

describe('CR-HM-MULTICLIENT-NOTIFICATION-01 PART 01 — assignment creation emits one durable intent', () => {
  it('1. assigning a Work Order emits exactly one in-app record and one durable outbound intent', async () => {
    const f = await setupFixture();
    await configureOutboundPolicy(f);

    const assigned = await api()
      .post(`${V1}/work-orders/${f.workOrder.id}/assignments`)
      .set(auth(f.ops.token))
      .send({
        assigneeType: 'WORKFORCE',
        workforceProfileId: f.profile.id,
      });
    assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
    const assignmentId = assigned.body.data.id as string;

    // The existing IN_APP delivery flow still works.
    const inbox = await api()
      .get(`${V1}/notifications`)
      .set(auth(f.worker.token));
    assert.equal(inbox.status, 200);
    const pending = (inbox.body.data as any[]).filter(
      (n) =>
        n.sourceEntityType === 'WORK_ORDER_ASSIGNMENT' &&
        n.sourceEntityId === assignmentId &&
        n.sourceEventType === 'WORK_ORDER_ASSIGNMENT_PENDING',
    );
    assert.equal(pending.length, 1, 'exactly one in-app record for the assignee');
    assert.equal(pending[0].channel, 'IN_APP');
    assert.equal(pending[0].status, 'UNREAD');
    assert.deepEqual(pending[0].navigationTarget, {
      type: 'WORK_ORDER_FIELD_WORK',
      id: f.workOrder.id,
    });

    // The client-neutral semantics: event identity, recipient, work order,
    // assignment reference and navigation target.
    assert.equal(pending[0].metadata.workOrderId, f.workOrder.id);
    assert.equal(pending[0].metadata.assignmentId, assignmentId);
    assert.equal(pending[0].metadata.buildingId, f.building.id);
    assert.equal(pending[0].metadata.responseStatus, 'PENDING');

    // The durable outbound intent on the existing delivery ledger.
    const intents = await pool!.query<{
      n: number;
      channel: string;
      status: string;
      source_event_type: string;
      source_entity_id: string;
      recipient_user_id: string;
      template_key: string;
      message: string;
      subject: string;
    }>(
      `SELECT count(*)::int AS n,
              min(channel) AS channel,
              min(status) AS status,
              min(source_event_type) AS source_event_type,
              min(source_entity_id::text) AS source_entity_id,
              min(recipient_user_id::text) AS recipient_user_id,
              min(template_key) AS template_key,
              min(message) AS message,
              min(subject) AS subject
         FROM notification_outbound_deliveries
        WHERE source_entity_id = $1::uuid`,
      [assignmentId],
    );
    assert.equal(intents.rows[0].n, 1, 'exactly one durable outbound intent');
    assert.equal(intents.rows[0].channel, 'EMAIL');
    assert.equal(intents.rows[0].status, 'PENDING', 'intent only; no provider contacted');
    assert.equal(intents.rows[0].source_event_type, 'WORK_ORDER_ASSIGNMENT_PENDING');
    assert.equal(intents.rows[0].source_entity_id, assignmentId);
    assert.equal(
      intents.rows[0].recipient_user_id,
      f.worker.userId,
      'the AUDIENCE is the assignment fact, not the subscription rule',
    );
    assert.ok(
      intents.rows[0].message.includes(f.workOrder.workOrderNumber),
      'the template rendered the client-neutral variables',
    );
  });

  it('2. a repeated command does not duplicate the intent', async () => {
    const f = await setupFixture();
    await configureOutboundPolicy(f);

    const first = await api()
      .post(`${V1}/work-orders/${f.workOrder.id}/assignments`)
      .set(auth(f.ops.token))
      .send({ assigneeType: 'WORKFORCE', workforceProfileId: f.profile.id });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const assignmentId = first.body.data.id as string;

    // The repeated command is refused by the assignment authority itself.
    const retry = await api()
      .post(`${V1}/work-orders/${f.workOrder.id}/assignments`)
      .set(auth(f.ops.token))
      .send({ assigneeType: 'WORKFORCE', workforceProfileId: f.profile.id });
    assert.equal(retry.status, 409);

    // And a producer replay of the SAME event is suppressed by the durable
    // guards (in-app dedup index + delivery idempotency key).
    const replay = await emitHandymanAssignmentNotificationIntent({
      eventType: 'WORK_ORDER_ASSIGNMENT_PENDING',
      clientId: f.client.id,
      buildingId: f.building.id,
      assignmentTargetType: 'WORK_ORDER_ASSIGNMENT',
      assignmentId,
      workOrderId: f.workOrder.id,
      recipientUserIds: [f.worker.userId],
      content: {
        type: 'WORK_ORDER_ASSIGNMENT_PENDING',
        title: 'Penugasan Work Order',
        body: 'Anda menerima penugasan baru.',
        navigationTarget: { type: 'WORK_ORDER_FIELD_WORK', id: f.workOrder.id },
        metadata: {
          workOrderId: f.workOrder.id,
          workOrderNumber: f.workOrder.workOrderNumber,
          assignmentId,
        },
      },
    });
    assert.equal(replay.inAppCreated, 0);
    assert.equal(replay.inAppSuppressed, 1, 'the in-app record is deduplicated');
    assert.equal(replay.outbound.deliveriesCreated, 0);
    assert.equal(replay.outbound.duplicatesSuppressed, 1, 'the intent is deduplicated');

    assert.equal(
      await countNotifications({ sourceEntityId: assignmentId }),
      1,
      'still exactly one in-app record',
    );
    assert.equal(
      await countOutboundIntents({ sourceEntityId: assignmentId }),
      1,
      'still exactly one durable intent',
    );
  });
});

describe('CR-HM-MULTICLIENT-NOTIFICATION-01 PART 01 — scope, rejection and atomicity', () => {
  it('3. rejects a recipient that is scoped to another tenant and refuses a building outside the tenant', async () => {
    const f = await setupFixture();
    await configureOutboundPolicy(f);

    // An actor whose ONLY tenant context is a DIFFERENT client.
    const outsider = await createAdminUser();
    const otherClient = await clientService.createClient({
      code: `CLI_${suffix()}`,
      name: 'Part01 Other Client',
    });
    const otherProperty = await propertyService.createProperty({
      clientId: otherClient.id,
      code: `PROP_${suffix()}`,
      name: 'Other Property',
    });
    const otherBuilding = await buildingService.createBuilding({
      propertyId: otherProperty.id,
      code: `BLDG_${suffix()}`,
      name: 'Other Building',
    });
    await buildingAssignmentService.createAssignment(outsider.userId, {
      buildingId: otherBuilding.id,
    });

    const assignmentId = randomUUID();
    const result = await emitHandymanAssignmentNotificationIntent({
      eventType: 'WORK_ORDER_ASSIGNMENT_PENDING',
      clientId: f.client.id,
      buildingId: f.building.id,
      assignmentTargetType: 'WORK_ORDER_ASSIGNMENT',
      assignmentId,
      workOrderId: f.workOrder.id,
      recipientUserIds: [outsider.userId, f.worker.userId],
      content: {
        type: 'WORK_ORDER_ASSIGNMENT_PENDING',
        title: 'Penugasan Work Order',
        body: 'Anda menerima penugasan baru.',
        navigationTarget: { type: 'WORK_ORDER_FIELD_WORK', id: f.workOrder.id },
        metadata: {
          workOrderId: f.workOrder.id,
          workOrderNumber: f.workOrder.workOrderNumber,
          assignmentId,
        },
      },
    });
    assert.equal(result.recipientsRejected, 1, 'the cross-tenant recipient is rejected');
    assert.equal(result.recipientsResolved, 1);
    assert.equal(result.inAppCreated, 1);
    assert.equal(
      await countNotifications({ recipientUserId: outsider.userId }),
      0,
      'the cross-tenant recipient is never notified',
    );
    assert.equal(
      await countOutboundIntents({ recipientUserId: outsider.userId }),
      0,
      'the cross-tenant recipient never receives an intent',
    );
    assert.equal(
      await countNotifications({ recipientUserId: f.worker.userId }),
      1,
      'the in-tenant recipient is notified',
    );

    // A building outside the tenant is refused outright (fail closed).
    await assert.rejects(
      emitHandymanAssignmentNotificationIntent({
        eventType: 'WORK_ORDER_ASSIGNMENT_PENDING',
        clientId: f.client.id,
        buildingId: otherBuilding.id,
        assignmentTargetType: 'WORK_ORDER_ASSIGNMENT',
        assignmentId,
        recipientUserIds: [f.worker.userId],
        content: {
          type: 'WORK_ORDER_ASSIGNMENT_PENDING',
          title: 'Penugasan Work Order',
          body: 'Anda menerima penugasan baru.',
          metadata: { assignmentId },
        },
      }),
      (error: unknown) =>
        Array.isArray((error as { details?: unknown[] }).details) &&
        (error as { details: Array<{ field?: string }> }).details.some(
          (detail) => detail.field === 'buildingId',
        ),
    );
  });

  it('4. rejects an invalid recipient and writes nothing', async () => {
    const f = await setupFixture();
    const assignmentId = randomUUID();

    // A malformed recipient is a validation failure — nothing is written.
    await assert.rejects(
      emitHandymanAssignmentNotificationIntent({
        eventType: 'WORK_ORDER_ASSIGNMENT_PENDING',
        clientId: f.client.id,
        buildingId: f.building.id,
        assignmentTargetType: 'WORK_ORDER_ASSIGNMENT',
        assignmentId,
        recipientUserIds: ['not-a-uuid'],
        content: {
          type: 'WORK_ORDER_ASSIGNMENT_PENDING',
          title: 'Penugasan Work Order',
          body: 'Anda menerima penugasan baru.',
          metadata: { assignmentId },
        },
      }),
      (error: unknown) =>
        Array.isArray((error as { details?: unknown[] }).details) &&
        (error as { details: Array<{ field?: string }> }).details.some(
          (detail) => detail.field === 'recipientUserIds',
        ),
    );
    assert.equal(await countNotifications({ sourceEntityId: assignmentId }), 0);
    assert.equal(await countOutboundIntents({ sourceEntityId: assignmentId }), 0);

    // A deactivated recipient is rejected too: it is never notified.
    const deactivated = await createAdminUser();
    await pool!.query(`UPDATE users SET status = 'INACTIVE' WHERE id = $1`, [
      deactivated.userId,
    ]);
    const result = await emitHandymanAssignmentNotificationIntent({
      eventType: 'WORK_ORDER_ASSIGNMENT_PENDING',
      clientId: f.client.id,
      buildingId: f.building.id,
      assignmentTargetType: 'WORK_ORDER_ASSIGNMENT',
      assignmentId,
      recipientUserIds: [deactivated.userId],
      content: {
        type: 'WORK_ORDER_ASSIGNMENT_PENDING',
        title: 'Penugasan Work Order',
        body: 'Anda menerima penugasan baru.',
        metadata: { assignmentId },
      },
    });
    assert.equal(result.recipientsRejected, 1);
    assert.equal(result.recipientsResolved, 0);
    assert.equal(result.inAppCreated, 0);
    assert.equal(await countNotifications({ sourceEntityId: assignmentId }), 0);
  });

  it('5. notification creation is transactional: a rollback leaves no record and no intent', async () => {
    const f = await setupFixture();
    await configureOutboundPolicy(f);
    const assignmentId = randomUUID();

    await assert.rejects(
      withTransaction(async (tx) => {
        await emitHandymanAssignmentNotificationIntent(
          {
            eventType: 'WORK_ORDER_ASSIGNMENT_PENDING',
            clientId: f.client.id,
            buildingId: f.building.id,
            assignmentTargetType: 'WORK_ORDER_ASSIGNMENT',
            assignmentId,
            workOrderId: f.workOrder.id,
            recipientUserIds: [f.worker.userId],
            content: {
              type: 'WORK_ORDER_ASSIGNMENT_PENDING',
              title: 'Penugasan Work Order',
              body: 'Anda menerima penugasan baru.',
              navigationTarget: {
                type: 'WORK_ORDER_FIELD_WORK',
                id: f.workOrder.id,
              },
              metadata: {
          workOrderId: f.workOrder.id,
          workOrderNumber: f.workOrder.workOrderNumber,
          assignmentId,
        },
            },
            executor: tx,
          },
        );
        throw new Error('SIMULATED_NOTIFICATION_TX_FAILURE');
      }),
      /SIMULATED_NOTIFICATION_TX_FAILURE/,
    );

    assert.equal(
      await countNotifications({ sourceEntityId: assignmentId }),
      0,
      'no phantom in-app record survives the rollback',
    );
    assert.equal(
      await countOutboundIntents({ sourceEntityId: assignmentId }),
      0,
      'no phantom durable intent survives the rollback',
    );
  });

  it('6. no regression to the existing channels: the WhatsApp consent guard still skips the intent', async () => {
    const f = await setupFixture();
    await configureOutboundPolicy(f, { whatsapp: true });

    const assigned = await api()
      .post(`${V1}/work-orders/${f.workOrder.id}/assignments`)
      .set(auth(f.ops.token))
      .send({ assigneeType: 'WORKFORCE', workforceProfileId: f.profile.id });
    assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
    const assignmentId = assigned.body.data.id as string;

    const rows = await pool!.query<{ channel: string; n: number }>(
      `SELECT channel, count(*)::int AS n
         FROM notification_outbound_deliveries
        WHERE source_entity_id = $1::uuid
        GROUP BY channel`,
      [assignmentId],
    );
    const byChannel = new Map(rows.rows.map((row) => [row.channel, row.n]));
    assert.equal(byChannel.get('EMAIL'), 1, 'the EMAIL intent is created');
    assert.equal(
      byChannel.get('WHATSAPP') ?? 0,
      0,
      'no WHATSAPP intent without an active consent + phone',
    );
    assert.equal(
      await countNotifications({ sourceEntityId: assignmentId }),
      1,
      'the in-app record is still exactly one',
    );
  });

  it('7. a broken notification template never breaks the assignment command', async () => {
    const f = await setupFixture();

    // A template that declares a variable the assignment event cannot
    // satisfy: the render fails, the domain command must not.
    const brokenTemplate = await createNotificationTemplate({
      key: `TPL_BROKEN_${suffix()}`,
      type: 'WORK_ORDER_ASSIGNMENT',
      channel: 'EMAIL',
      subject: 'Penugasan {{unknownVariable}}',
      body: 'Anda menerima penugasan {{unknownVariable}}.',
    });
    await notificationSubscriptionRepository.create({
      key: `SUB_${suffix()}`,
      eventType: 'WORK_ORDER_ASSIGNMENT_PENDING',
      templateKey: brokenTemplate.key,
      recipientRule: { specs: [{ kind: 'USER', userId: f.ops.userId }] },
      clientId: f.client.id,
    });

    const assigned = await api()
      .post(`${V1}/work-orders/${f.workOrder.id}/assignments`)
      .set(auth(f.ops.token))
      .send({ assigneeType: 'WORKFORCE', workforceProfileId: f.profile.id });
    assert.equal(
      assigned.status,
      201,
      'a notification configuration failure never fails the assignment',
    );
    const assignmentId = assigned.body.data.id as string;

    assert.equal(
      await countNotifications({ sourceEntityId: assignmentId }),
      1,
      'the in-app record — the assignment guarantee — is still written',
    );
    assert.equal(
      await countOutboundIntents({ sourceEntityId: assignmentId }),
      0,
      'no outbound intent is produced from an unusable template',
    );
  });
});
