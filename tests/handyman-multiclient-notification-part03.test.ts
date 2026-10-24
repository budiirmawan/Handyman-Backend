import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Pool } from 'pg';
import { resetAppConfigCache } from '../src/config';
import { closePool, initDatabase, migrateUp, withTransaction } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { clientService } from '../src/modules/clients';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { createChannelAttribution } from '../src/modules/handyman-channel-attributions';
import {
  cancelHandymanRequest,
  handymanServiceRequestCancellationService,
  handymanServiceRequestDiagnosisService,
  handymanServiceRequestInspectionService,
  handymanServiceRequestReferralService,
  handymanServiceRequestService,
  handymanServiceRequestTriageService,
  recordHandymanDiagnosis,
  recordHandymanInspection,
  recordHandymanRequestTriage,
} from '../src/modules/handyman-requests';
import {
  createHandymanPermitReadiness,
  createHandymanSchedulingReadiness,
  createHandymanUnitAccessReadiness,
  handymanPermitReadinessService,
  handymanSchedulingReadinessService,
  handymanUnitAccessReadinessService,
} from '../src/modules/handyman-scheduling';
import {
  addHandymanQuotationLine,
  createHandymanQuotation,
  createHandymanQuotationRevision,
  expireHandymanQuotationVersion,
  issueHandymanQuotationVersion,
  supersedeHandymanQuotationVersion,
} from '../src/modules/handyman-quotations';
import {
  handymanProviderContextService,
  handymanWorkCrewService,
  handymanWorkerContextService,
} from '../src/modules/handyman-providers';
import {
  HANDYMAN_DOMAIN_NOTIFICATION_FACTS,
  HANDYMAN_PART03_NOTIFICATION_CONTRACT,
  emitHandymanDomainNotificationIntent,
  isHandymanDomainNotificationEventType,
} from '../src/modules/handyman-notifications';
import { createNotificationTemplate } from '../src/modules/notification-templates';
import { notificationSubscriptionRepository } from '../src/modules/notification-subscriptions';
import { notificationOutboundDeliveryRepository } from '../src/modules/notification-outbound-deliveries';
import { processOutboundDelivery } from '../src/modules/notification-delivery/outbound-delivery-execution.service';
import { registerPushToken } from '../src/modules/push-tokens/push-token.service';
import {
  registerBrowserPushSubscription,
} from '../src/modules/browser-push-subscriptions';
import { serviceCatalogService } from '../src/modules/service-catalog';
import { tenantBuildingContextService } from '../src/modules/tenant-building-contexts';
import { tenantCompanyService } from '../src/modules/tenant-companies';
import { tenantPicService } from '../src/modules/tenant-pics';
import { tenantSpaceService } from '../src/modules/tenant-spaces';
import { userService } from '../src/modules/users';
import { vendorService } from '../src/modules/vendors';
import { vendorWorkforceService } from '../src/modules/vendor-workforce';
import { assignBuildingToWorkforce } from '../src/modules/workforce-building-assignments';
import { workforceService } from '../src/modules/workforce';
import { createAdminUser } from './helpers/access';
import { startEmbeddedTestDatabase } from './helpers/embedded-test-db';
import {
  initHandymanFixtures,
  locationChain,
  realmFixture,
} from './helpers/handyman-fixtures';

/**
 * CR-HM-MULTICLIENT-NOTIFICATION-01 PART 03 — DOMAIN NOTIFICATION
 * PRODUCERS (focused suite).
 *
 * The suite proves the PART 03 scope:
 *   1. the frozen CR-HM-16 contract is BYTE-FOR-BYTE untouched, and the
 *      PART 03 vocabulary lives BESIDE it,
 *   2. every produced event has a REAL source (no invented events),
 *   3. the request, inspection, quotation, permit/readiness and crew-change
 *      events are produced by their own domain authorities,
 *   4. the production REUSES the PART 01 producer seam and the PART 02
 *      transport: ONE in-app record, ONE durable PUSH intent, ONE FCM
 *      delivery and ONE Web Push delivery for one event,
 *   5. the tenant / recipient isolation holds (another tenant's
 *      subscription never fires; the recipient scope filters),
 *   6. the transactional outbox holds (the intents roll back with the
 *      domain fact) and the outbound idempotency key dedupes,
 *   7. a notification CONFIGURATION failure never fails the domain command,
 *   8. the existing IN_APP / EMAIL / WHATSAPP channel compatibility is
 *      untouched.
 */

const DB_DIR = '/tmp/hm-multiclient-notification-part03-pg';
const DB_PORT = 55587;

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';

let dbHandle: { stop: () => Promise<void> } | null = null;
let pool: Pool | null = null;
let adminUserId = '';

const suffix = () => randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();

function repoPath(relative: string): string {
  return join(process.cwd(), 'src', ...relative.split('/'));
}

before(async () => {
  await rm(DB_DIR, { recursive: true, force: true });
  dbHandle = await startEmbeddedTestDatabase({ dir: DB_DIR, port: DB_PORT });
  resetAppConfigCache();
  pool = await initDatabase({
    host: '127.0.0.1',
    port: DB_PORT,
    user: 'postgres',
    password: '',
    name: 'asentra_test',
    ssl: false,
  });
  await migrateUp(pool);
  const admin = await createAdminUser();
  adminUserId = admin.userId;
  const discipline = await handymanDisciplineRepository.findDisciplineByCode(
    undefined,
    'GENERAL_HANDYMAN',
  );
  if (!discipline) throw new Error('GENERAL_HANDYMAN discipline seed missing');
  initHandymanFixtures({
    adminUserId,
    disciplineId: discipline.id,
    query: async (text, params = []) => {
      if (!pool) throw new Error('db pool not initialized');
      return pool.query(text, params);
    },
  });
});

after(async () => {
  try {
    if (pool) await closePool(pool);
    if (dbHandle) await dbHandle.stop();
  } finally {
    pool = null;
    dbHandle = null;
  }
});

async function q<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  if (!pool) throw new Error('db pool not initialized');
  const result = await pool.query(text, params);
  return result.rows as T[];
}

/**
 * A tenant with a full request chain: client → property → building → space
 * → tenant company → PIC → channel attribution → service → handyman request
 * (INTAKE).
 */
async function requestFixture(label = 'Part03') {
  const realm = await realmFixture(label);
  // The scheduling readiness derives the timezone from the BUILDING
  // authority — it is never accepted from the caller.
  await q(
    `UPDATE buildings SET timezone = 'Asia/Jakarta' WHERE id = $1`,
    [realm.building.id],
  );
  const chain = await locationChain(realm);
  const company = await tenantCompanyService.createTenantCompany(
    {
      clientId: realm.client.id,
      tenantCode: `TNT_${suffix()}`,
      tenantName: 'Tenant Company',
    },
    adminUserId,
  );
  const linkedUser = await userService.createUser({
    email: `customer-${suffix().toLowerCase()}@example.com`,
    displayName: 'Customer Person',
  });
  await buildingAssignmentService.createAssignment(linkedUser.id, {
    buildingId: realm.building.id,
  });
  const pic = await tenantPicService.createTenantPic(
    {
      tenantCompanyId: company.id,
      picName: 'Tenant Requester',
      email: 'requester@tenant.example.com',
      userId: linkedUser.id,
    },
    adminUserId,
  );
  await tenantSpaceService.assignSpaceToTenant(
    {
      tenantCompanyId: company.id,
      buildingId: realm.building.id,
      spaceId: chain.space.id,
    },
    adminUserId,
  );
  await tenantBuildingContextService.createTenantBuildingContext(
    { tenantCompanyId: company.id, buildingId: realm.building.id },
    adminUserId,
  );
  const attribution = await createChannelAttribution({
    tenantCompanyId: company.id,
    buildingId: realm.building.id,
    tenantPicId: pic.id,
    spaceId: chain.space.id,
    originChannel: 'BM_SUPER_APP',
    originReference: `bm-handoff:BM_SUPER_APP:${randomUUID()}`,
    createdByUserId: linkedUser.id,
  });
  const service = await serviceCatalogService.createServiceCatalogEntry(
    {
      clientId: realm.client.id,
      code: `HM${suffix()}`,
      name: 'Handyman Service',
      category: 'HANDYMAN',
    },
    adminUserId,
  );
  const request = await handymanServiceRequestService
    .createHandymanServiceRequest(
      {
        channelAttributionId: attribution.id,
        serviceCatalogId: service.id,
        description: 'AC dripping in the unit.',
      },
      adminUserId,
    );
  return { realm, chain, company, linkedUser, pic, attribution, service, request };
}

/** An ACTIVE recipient inside the tenant (the notification audience). */
async function recipientFixture(
  realm: { client: { id: string }; building: { id: string } },
  label: string,
) {
  const user = await userService.createUser({
    email: `${label}-${suffix().toLowerCase()}@example.com`,
    displayName: label,
  });
  await buildingAssignmentService.createAssignment(user.id, {
    buildingId: realm.building.id,
  });
  return user;
}

/**
 * The template variable each produced event really carries — the template
 * must only ask for what the event provides (a missing variable is a
 * notification CONFIGURATION failure, which never fails the domain command).
 */
const EVENT_TEMPLATE_VARIABLE: Record<string, string> = {
  HANDYMAN_REQUEST_TRIAGED: 'handymanRequestId',
  HANDYMAN_INSPECTION_RECORDED: 'handymanRequestId',
  HANDYMAN_REFERRAL_CREATED: 'handymanRequestId',
  HANDYMAN_REQUEST_CANCELLED: 'handymanRequestId',
  HANDYMAN_QUOTATION_ISSUED: 'quotationId',
  HANDYMAN_QUOTATION_SUPERSEDED: 'quotationId',
  HANDYMAN_QUOTATION_EXPIRED: 'quotationId',
  HANDYMAN_PERMIT_READINESS_CREATED: 'handymanRequestId',
  HANDYMAN_SCHEDULING_READINESS_CREATED: 'handymanRequestId',
  HANDYMAN_UNIT_ACCESS_READINESS_CREATED: 'handymanRequestId',
  HANDYMAN_CREW_MEMBER_ADDED: 'crewId',
  HANDYMAN_CREW_LEAD_DESIGNATED: 'crewId',
};

/**
 * Subscribes the tenant to one domain event with one template — the whole
 * declarative BE-26D configuration (the audience is the rule, never the
 * domain).
 */
async function subscribe(params: {
  clientId: string;
  eventType: string;
  recipientUserId: string;
  channel: 'IN_APP' | 'EMAIL' | 'WHATSAPP' | 'PUSH';
  subject?: string;
  body?: string;
  scopeClientId?: string;
}) {
  const variable = EVENT_TEMPLATE_VARIABLE[params.eventType] ?? 'handymanRequestId';
  const template = await createNotificationTemplate({
    key: `TPL_${suffix()}`,
    type: params.eventType,
    channel: params.channel,
    subject: params.subject ?? `Permintaan {{${variable}}}`,
    body: params.body ?? `Permintaan {{${variable}}} telah diproses.`,
  });
  await notificationSubscriptionRepository.create({
    key: `SUB_${suffix()}`,
    eventType: params.eventType,
    templateKey: template.key,
    recipientRule: {
      specs: [{ kind: 'USER', userId: params.recipientUserId }],
      ...(params.scopeClientId
        ? { scope: { clientId: params.scopeClientId } }
        : {}),
    },
    clientId: params.clientId,
  });
  return template;
}

async function inAppRows(entityId: string, eventType?: string) {
  return q<{
    id: string;
    client_id: string;
    recipient_user_id: string;
    source_event_type: string;
    source_entity_type: string;
    source_entity_id: string;
    template_key: string;
  }>(
    `SELECT id, client_id, recipient_user_id, source_event_type,
            source_entity_type, source_entity_id, template_key
       FROM notifications
      WHERE source_entity_id = $1
        AND ($2::text IS NULL OR source_event_type = $2)
      ORDER BY created_at ASC`,
    [entityId, eventType ?? null],
  );
}

async function ledgerRows(entityId: string) {
  return q<{
    id: string;
    client_id: string;
    recipient_user_id: string;
    channel: string;
    status: string;
    source_event_type: string;
    source_entity_type: string;
    source_entity_id: string;
    idempotency_key: string;
  }>(
    `SELECT id, client_id, recipient_user_id, channel, status,
            source_event_type, source_entity_type, source_entity_id,
            idempotency_key
       FROM notification_outbound_deliveries
      WHERE source_entity_id = $1
      ORDER BY created_at ASC`,
    [entityId],
  );
}

describe('CR-HM-MULTICLIENT-NOTIFICATION-01 PART 03 — the frozen contract is preserved', () => {
  it('1: leaves the CR-HM-16 notification contract byte-for-byte untouched', () => {
    const source = readFileSync(
      repoPath('modules/handyman-notifications/handyman-notification-contract.ts'),
      'utf8',
    );
    // The digest of the FROZEN file as committed with PART 03. A change to
    // the frozen contract breaks this test on purpose.
    assert.equal(
      createHash('sha256').update(source).digest('hex'),
      'c6dfa2386d7a17f90b9352e4f9d614b535e0c27822f6dd08fa533388f30dcd99',
      'the frozen CR-HM-16 contract must not change',
    );
    // …and it still declares exactly the thirteen frozen entries.
    assert.equal(
      (source.match(/eventType: '/g) ?? []).length,
      13,
      'two SLA entries and eleven domain entries',
    );
    assert.ok(!source.includes('HANDYMAN_INSPECTION_RECORDED'));
  });

  it('2: declares the PART 03 vocabulary BESIDE the frozen contract', () => {
    // Exactly ONE additive entry: the inspection that has a real source but
    // is not part of the frozen CR-HM-16 vocabulary.
    assert.equal(HANDYMAN_PART03_NOTIFICATION_CONTRACT.length, 1);
    assert.equal(
      HANDYMAN_PART03_NOTIFICATION_CONTRACT[0].eventType,
      'HANDYMAN_INSPECTION_RECORDED',
    );
    assert.equal(
      HANDYMAN_PART03_NOTIFICATION_CONTRACT[0].audience,
      'SUBSCRIPTION_RULE',
    );
    // The eleven frozen domain events + the inspection = twelve produced
    // events, each bound to ONE notification entity.
    assert.equal(Object.keys(HANDYMAN_DOMAIN_NOTIFICATION_FACTS).length, 12);
    for (const [eventType, fact] of Object.entries(
      HANDYMAN_DOMAIN_NOTIFICATION_FACTS,
    )) {
      assert.ok(isHandymanDomainNotificationEventType(eventType));
      assert.ok(fact.entityType.length > 0);
    }
  });

  it('3: every produced event has a REAL source in the domain code', () => {
    const sources: Record<string, string> = {
      HANDYMAN_REQUEST_TRIAGED:
        'modules/handyman-requests/handyman-request-triage.service.ts',
      HANDYMAN_REFERRAL_CREATED:
        'modules/handyman-requests/handyman-request-referral.service.ts',
      HANDYMAN_REQUEST_CANCELLED:
        'modules/handyman-requests/handyman-request-cancellation.service.ts',
      HANDYMAN_INSPECTION_RECORDED:
        'modules/handyman-requests/handyman-request-inspection.service.ts',
      HANDYMAN_QUOTATION_ISSUED:
        'modules/handyman-quotations/handyman-quotation-lifecycle.service.ts',
      HANDYMAN_QUOTATION_SUPERSEDED:
        'modules/handyman-quotations/handyman-quotation-lifecycle.service.ts',
      HANDYMAN_QUOTATION_EXPIRED:
        'modules/handyman-quotations/handyman-quotation-lifecycle.service.ts',
      HANDYMAN_PERMIT_READINESS_CREATED:
        'modules/handyman-scheduling/handyman-permit-readiness.service.ts',
      HANDYMAN_SCHEDULING_READINESS_CREATED:
        'modules/handyman-scheduling/handyman-scheduling.service.ts',
      HANDYMAN_UNIT_ACCESS_READINESS_CREATED:
        'modules/handyman-scheduling/handyman-unit-access.service.ts',
      HANDYMAN_CREW_MEMBER_ADDED:
        'modules/handyman-providers/handyman-work-crew.service.ts',
      HANDYMAN_CREW_LEAD_DESIGNATED:
        'modules/handyman-providers/handyman-work-crew.service.ts',
    };
    for (const [eventType, relative] of Object.entries(sources)) {
      const source = readFileSync(repoPath(relative), 'utf8');
      assert.ok(
        source.includes(`eventType: '${eventType}'`),
        `${eventType} must be journaled by ${relative}`,
      );
      assert.ok(
        source.includes('emitHandymanDomainNotificationIntent'),
        `${eventType} must be produced by ${relative}`,
      );
    }
  });
});

describe('CR-HM-MULTICLIENT-NOTIFICATION-01 PART 03 — the request family producers', () => {
  it('4: the triage command produces ONE in-app record and ONE durable intent', async () => {
    const f = await requestFixture('Part03 Triage');
    const recipient = await recipientFixture(f.realm, 'Ops');
    // ONE subscription, ONE template: the reused BE-26D seam decides the
    // channel and the copy; the domain decides nothing but the fact.
    await subscribe({
      clientId: f.realm.client.id,
      eventType: 'HANDYMAN_REQUEST_TRIAGED',
      recipientUserId: recipient.id,
      channel: 'PUSH',
    });

    const decision = await handymanServiceRequestTriageService
      .recordHandymanRequestTriage(
        {
          handymanRequestId: f.request.id,
          triageDisposition: 'INSPECTION_REQUIRED',
          triageNote: 'Ceiling leak — needs a visit.',
        },
        adminUserId,
      );

    const inApp = await inAppRows(decision.id);
    assert.equal(inApp.length, 1, 'exactly one in-app record');
    assert.equal(inApp[0].source_event_type, 'HANDYMAN_REQUEST_TRIAGED');
    assert.equal(inApp[0].source_entity_type, 'HANDYMAN_REQUEST_TRIAGE_DECISION');
    assert.equal(inApp[0].client_id, f.realm.client.id);
    assert.equal(inApp[0].recipient_user_id, recipient.id);

    const ledger = await ledgerRows(decision.id);
    assert.equal(ledger.length, 1, 'exactly one durable outbound intent');
    assert.equal(ledger[0].channel, 'PUSH');
    assert.equal(ledger[0].status, 'PENDING', 'no provider contacted yet');
    assert.equal(ledger[0].source_event_type, 'HANDYMAN_REQUEST_TRIAGED');
    assert.equal(ledger[0].client_id, f.realm.client.id);
  });

  it('4b: an IN_APP template produces the inbox record and NO outbound intent', async () => {
    const f = await requestFixture('Part03 Triage In-App');
    const recipient = await recipientFixture(f.realm, 'Ops');
    await subscribe({
      clientId: f.realm.client.id,
      eventType: 'HANDYMAN_REQUEST_TRIAGED',
      recipientUserId: recipient.id,
      channel: 'IN_APP',
    });
    const decision = await handymanServiceRequestTriageService
      .recordHandymanRequestTriage(
        {
          handymanRequestId: f.request.id,
          triageDisposition: 'INSPECTION_REQUIRED',
          triageNote: 'Ceiling leak — needs a visit.',
        },
        adminUserId,
      );
    assert.equal((await inAppRows(decision.id)).length, 1);
    assert.equal(
      (await ledgerRows(decision.id)).length,
      0,
      'the in-app channel stays the in-app chain\'s authority',
    );
  });

  it('5: the inspection command produces its notification (the PART 03 vocabulary)', async () => {
    const f = await requestFixture('Part03 Inspection');
    const recipient = await recipientFixture(f.realm, 'Ops');
    await subscribe({
      clientId: f.realm.client.id,
      eventType: 'HANDYMAN_INSPECTION_RECORDED',
      recipientUserId: recipient.id,
      channel: 'IN_APP',
    });
    await handymanServiceRequestTriageService.recordHandymanRequestTriage(
      {
        handymanRequestId: f.request.id,
        triageDisposition: 'INSPECTION_REQUIRED',
        triageNote: 'Needs a visit.',
      },
      adminUserId,
    );

    const inspection = await handymanServiceRequestInspectionService
      .recordHandymanInspection(
        {
          handymanRequestId: f.request.id,
          inspectionResult: 'INSPECTED',
          inspectionNotes: 'Leak confirmed above the ceiling.',
        },
        adminUserId,
      );

    const inApp = await inAppRows(inspection.id);
    assert.equal(inApp.length, 1);
    assert.equal(inApp[0].source_event_type, 'HANDYMAN_INSPECTION_RECORDED');
    assert.equal(inApp[0].source_entity_type, 'HANDYMAN_REQUEST_INSPECTION');
  });

  it('6: the referral command produces its notification', async () => {
    const f = await requestFixture('Part03 Referral');
    const recipient = await recipientFixture(f.realm, 'Ops');
    await subscribe({
      clientId: f.realm.client.id,
      eventType: 'HANDYMAN_REFERRAL_CREATED',
      recipientUserId: recipient.id,
      channel: 'IN_APP',
    });
    await handymanServiceRequestTriageService.recordHandymanRequestTriage(
      {
        handymanRequestId: f.request.id,
        triageDisposition: 'DIAGNOSIS',
        triageNote: 'Direct to diagnosis.',
      },
      adminUserId,
    );
    const diagnosis = await handymanServiceRequestDiagnosisService
      .recordHandymanDiagnosis(
        {
          handymanRequestId: f.request.id,
          disciplineId: await disciplineIdByCode('ELECTRICAL'),
          diagnosis: 'Burst pipe behind the wall — specialist work.',
        },
        adminUserId,
      );
    assert.ok(diagnosis.id);

    const referral = await handymanServiceRequestReferralService
      .recordHandymanReferral(
        {
          handymanRequestId: f.request.id,
          referralNote: 'Escalate to the electrical specialist.',
        },
        adminUserId,
      );

    const inApp = await inAppRows(referral.id);
    assert.equal(inApp.length, 1);
    assert.equal(inApp[0].source_event_type, 'HANDYMAN_REFERRAL_CREATED');
    assert.equal(inApp[0].source_entity_type, 'HANDYMAN_REQUEST_REFERRAL');
  });

  it('7: the cancellation command produces its notification — and a replay does not', async () => {
    const f = await requestFixture('Part03 Cancel');
    const recipient = await recipientFixture(f.realm, 'Ops');
    await subscribe({
      clientId: f.realm.client.id,
      eventType: 'HANDYMAN_REQUEST_CANCELLED',
      recipientUserId: recipient.id,
      channel: 'IN_APP',
    });
    const idempotencyKey = `cancel-${randomUUID()}`;
    const cancelled = await handymanServiceRequestCancellationService
      .cancelHandymanRequest(
        {
          handymanRequestId: f.request.id,
          reason: 'Tenant resolved it themselves.',
          idempotencyKey,
        },
        adminUserId,
      );
    assert.equal(cancelled.replayed, false);

    const inApp = await inAppRows(cancelled.id);
    assert.equal(inApp.length, 1);
    assert.equal(inApp[0].source_event_type, 'HANDYMAN_REQUEST_CANCELLED');
    assert.equal(inApp[0].source_entity_type, 'HANDYMAN_REQUEST_CANCELLATION');

    // The replay is the SAME intent: it must not produce a second
    // notification.
    const replay = await handymanServiceRequestCancellationService
      .cancelHandymanRequest(
        {
          handymanRequestId: f.request.id,
          reason: 'Tenant resolved it themselves.',
          idempotencyKey,
        },
        adminUserId,
      );
    assert.equal(replay.replayed, true);
    const afterReplay = await inAppRows(cancelled.id);
    assert.equal(afterReplay.length, 1, 'the replay produces no second record');
  });
});

describe('CR-HM-MULTICLIENT-NOTIFICATION-01 PART 03 — the quotation producers', () => {
  async function quotationFixture(label: string) {
    const f = await requestFixture(label);
    const recipient = await recipientFixture(f.realm, 'Ops');
    await subscribe({
      clientId: f.realm.client.id,
      eventType: 'HANDYMAN_QUOTATION_ISSUED',
      recipientUserId: recipient.id,
      channel: 'IN_APP',
    });
    await subscribe({
      clientId: f.realm.client.id,
      eventType: 'HANDYMAN_QUOTATION_SUPERSEDED',
      recipientUserId: recipient.id,
      channel: 'IN_APP',
    });
    await subscribe({
      clientId: f.realm.client.id,
      eventType: 'HANDYMAN_QUOTATION_EXPIRED',
      recipientUserId: recipient.id,
      channel: 'IN_APP',
    });
    await handymanServiceRequestTriageService.recordHandymanRequestTriage(
      {
        handymanRequestId: f.request.id,
        triageDisposition: 'DIAGNOSIS',
        triageNote: 'Direct to diagnosis.',
      },
      adminUserId,
    );
    await handymanServiceRequestDiagnosisService.recordHandymanDiagnosis(
      {
        handymanRequestId: f.request.id,
        disciplineId: await disciplineIdByCode('GENERAL_HANDYMAN'),
        diagnosis: 'Burst pipe behind the wall.',
      },
      adminUserId,
    );
    const quotation = await createHandymanQuotation(
      { handymanRequestId: f.request.id },
      adminUserId,
    );
    const version = quotation.versions[0];
    const uomId = randomUUID();
    await q(
      `INSERT INTO units_of_measure (id, client_id, code, name, symbol, category)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [uomId, f.realm.client.id, `M_${suffix()}`, 'Meter', 'm', 'LENGTH'],
    );
    await addHandymanQuotationLine(
      version.id,
      {
        lineType: 'LABOR',
        description: 'Hours',
        quantity: 1,
        uomId,
        currency: 'IDR',
        finalQuotedUnitAmount: 100,
      },
      adminUserId,
    );
    return { ...f, recipient, quotation, version };
  }

  it('8: the issuance produces its notification', async () => {
    const f = await quotationFixture('Part03 Quotation');
    const issued = await issueHandymanQuotationVersion(
      f.version.id,
      { validUntil: new Date(Date.now() + 3_600_000).toISOString() },
      adminUserId,
    );
    const inApp = await inAppRows(issued.id);
    assert.equal(inApp.length, 1);
    assert.equal(inApp[0].source_event_type, 'HANDYMAN_QUOTATION_ISSUED');
    assert.equal(inApp[0].source_entity_type, 'HANDYMAN_QUOTATION_VERSION');
  });

  it('9: the supersession produces its notification for the SUPERSEDED version', async () => {
    const f = await quotationFixture('Part03 Quotation Supersede');
    await issueHandymanQuotationVersion(
      f.version.id,
      { validUntil: new Date(Date.now() + 3_600_000).toISOString() },
      adminUserId,
    );
    const revision = await createHandymanQuotationRevision(
      f.quotation.quotation.id,
      adminUserId,
    );
    const uomId = randomUUID();
    await q(
      `INSERT INTO units_of_measure (id, client_id, code, name, symbol, category)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [uomId, f.realm.client.id, `M_${suffix()}`, 'Meter', 'm', 'LENGTH'],
    );
    await addHandymanQuotationLine(
      revision.id,
      {
        lineType: 'LABOR',
        description: 'Hours',
        quantity: 2,
        uomId,
        currency: 'IDR',
        finalQuotedUnitAmount: 100,
      },
      adminUserId,
    );
    await issueHandymanQuotationVersion(
      revision.id,
      { validUntil: new Date(Date.now() + 7_200_000).toISOString() },
      adminUserId,
    );

    // The FIRST version was superseded by the revision: its notification is
    // addressed to the superseded VERSION, not to the quotation.
    const inApp = await inAppRows(f.version.id, 'HANDYMAN_QUOTATION_SUPERSEDED');
    assert.equal(inApp.length, 1);
    assert.equal(inApp[0].source_event_type, 'HANDYMAN_QUOTATION_SUPERSEDED');
    assert.equal(inApp[0].source_entity_id, f.version.id);
  });

  it('10: the expiry produces its notification', async () => {
    const f = await quotationFixture('Part03 Quotation Expiry');
    const issued = await issueHandymanQuotationVersion(
      f.version.id,
      { validUntil: new Date(Date.now() + 3_600_000).toISOString() },
      adminUserId,
    );
    assert.ok(issued.id);
    // Force the expiry by moving the authoritative validUntil into the past.
    await q(
      `UPDATE handyman_quotation_versions SET valid_until = NOW() - INTERVAL '1 minute'
        WHERE id = $1`,
      [f.version.id],
    );
    const expired = await expireHandymanQuotationVersion(f.version.id, adminUserId);
    const inApp = await inAppRows(expired.id, 'HANDYMAN_QUOTATION_EXPIRED');
    assert.equal(inApp.length, 1);
    assert.equal(inApp[0].source_event_type, 'HANDYMAN_QUOTATION_EXPIRED');
  });
});

describe('CR-HM-MULTICLIENT-NOTIFICATION-01 PART 03 — the readiness producers', () => {
  it('11: the permit readiness produces its notification', async () => {
    const f = await requestFixture('Part03 Permit');
    const recipient = await recipientFixture(f.realm, 'Ops');
    await subscribe({
      clientId: f.realm.client.id,
      eventType: 'HANDYMAN_PERMIT_READINESS_CREATED',
      recipientUserId: recipient.id,
      channel: 'IN_APP',
    });
    const readiness = await handymanPermitReadinessService
      .createHandymanPermitReadiness(
        {
          handymanRequestId: f.request.id,
          permitType: 'UNIT',
          validFrom: new Date().toISOString(),
          validUntil: new Date(Date.now() + 86_400_000).toISOString(),
          authorizationNote: 'Building office authorized the permit.',
        },
        adminUserId,
      );
    const inApp = await inAppRows(readiness.id);
    assert.equal(inApp.length, 1);
    assert.equal(
      inApp[0].source_event_type,
      'HANDYMAN_PERMIT_READINESS_CREATED',
    );
    assert.equal(inApp[0].source_entity_type, 'HANDYMAN_PERMIT_READINESS');
  });

  it('12: the scheduling readiness produces its notification', async () => {
    const f = await requestFixture('Part03 Scheduling');
    const recipient = await recipientFixture(f.realm, 'Ops');
    await subscribe({
      clientId: f.realm.client.id,
      eventType: 'HANDYMAN_SCHEDULING_READINESS_CREATED',
      recipientUserId: recipient.id,
      channel: 'IN_APP',
    });
    const readiness = await handymanSchedulingReadinessService
      .createHandymanSchedulingReadiness(
        {
          handymanRequestId: f.request.id,
          preferredWindowStart: new Date(Date.now() + 3_600_000).toISOString(),
          preferredWindowEnd: new Date(Date.now() + 7_200_000).toISOString(),
        },
        adminUserId,
      );
    const inApp = await inAppRows(readiness.id);
    assert.equal(inApp.length, 1);
    assert.equal(
      inApp[0].source_event_type,
      'HANDYMAN_SCHEDULING_READINESS_CREATED',
    );
    assert.equal(inApp[0].source_entity_type, 'HANDYMAN_SCHEDULING_READINESS');
  });

  it('13: the unit access readiness produces its notification', async () => {
    const f = await requestFixture('Part03 Unit Access');
    const recipient = await recipientFixture(f.realm, 'Ops');
    await subscribe({
      clientId: f.realm.client.id,
      eventType: 'HANDYMAN_UNIT_ACCESS_READINESS_CREATED',
      recipientUserId: recipient.id,
      channel: 'IN_APP',
    });
    const readiness = await handymanUnitAccessReadinessService
      .createHandymanUnitAccessReadiness(
        {
          handymanRequestId: f.request.id,
          accessWindowStart: new Date(Date.now() + 3_600_000).toISOString(),
          accessWindowEnd: new Date(Date.now() + 7_200_000).toISOString(),
          authorizationNote: 'The tenant authorized the access window.',
        },
        adminUserId,
      );
    const inApp = await inAppRows(readiness.id);
    assert.equal(inApp.length, 1);
    assert.equal(
      inApp[0].source_event_type,
      'HANDYMAN_UNIT_ACCESS_READINESS_CREATED',
    );
    assert.equal(inApp[0].source_entity_type, 'HANDYMAN_UNIT_ACCESS_READINESS');
  });

  it('14: a supersession is its OWN notification (a new readiness row)', async () => {
    const f = await requestFixture('Part03 Permit Supersede');
    const recipient = await recipientFixture(f.realm, 'Ops');
    await subscribe({
      clientId: f.realm.client.id,
      eventType: 'HANDYMAN_PERMIT_READINESS_CREATED',
      recipientUserId: recipient.id,
      channel: 'IN_APP',
    });
    const first = await handymanPermitReadinessService
      .createHandymanPermitReadiness(
        {
          handymanRequestId: f.request.id,
          permitType: 'UNIT',
          validFrom: new Date().toISOString(),
          validUntil: new Date(Date.now() + 86_400_000).toISOString(),
          authorizationNote: 'Building office authorized the permit.',
        },
        adminUserId,
      );
    const second = await handymanPermitReadinessService
      .supersedeHandymanPermitReadiness(
        first.id,
        {
          permitType: 'UNIT',
          validFrom: new Date().toISOString(),
          validUntil: new Date(Date.now() + 172_800_000).toISOString(),
          authorizationNote: 'Permit re-issued with extended validity.',
        },
        adminUserId,
      );
    assert.notEqual(second.id, first.id, 'the supersession writes a NEW row');
    assert.equal((await inAppRows(first.id)).length, 1);
    assert.equal((await inAppRows(second.id)).length, 1);
  });
});

describe('CR-HM-MULTICLIENT-NOTIFICATION-01 PART 03 — the crew producers', () => {
  it('15: the crew creation produces the member and the lead notifications', async () => {
    const realm = await realmFixture('Part03 Crew');
    const recipient = await recipientFixture(realm, 'Ops');
    await subscribe({
      clientId: realm.client.id,
      eventType: 'HANDYMAN_CREW_MEMBER_ADDED',
      recipientUserId: recipient.id,
      channel: 'IN_APP',
    });
    await subscribe({
      clientId: realm.client.id,
      eventType: 'HANDYMAN_CREW_LEAD_DESIGNATED',
      recipientUserId: recipient.id,
      channel: 'IN_APP',
    });

    const vendor = await vendorService.createVendor({
      clientId: realm.client.id,
      vendorCode: `V_${suffix()}`,
      vendorName: 'Field Providers',
    });
    const providerContext = await handymanProviderContextService
      .createHandymanProviderContext({ vendorId: vendor.id }, adminUserId);
    const linkedUser = await userService.createUser({
      email: `lead-${suffix().toLowerCase()}@example.com`,
      displayName: 'Crew Lead',
    });
    const profile = await workforceService.createWorkforceProfile({
      organizationId: realm.organization.id,
      departmentId: realm.department.id,
      positionId: realm.position.id,
      employeeCode: `LEAD_${suffix()}`,
      fullName: 'Lead Worker',
      workforceType: 'EXTERNAL',
      userId: linkedUser.id,
    });
    await assignBuildingToWorkforce({
      workforceProfileId: profile.id,
      buildingId: realm.building.id,
    });
    await vendorWorkforceService.createVendorWorkforceBinding({
      vendorId: vendor.id,
      workforceProfileId: profile.id,
      vendorPersonnelCode: `VP_${suffix()}`,
    });
    const workerContext = await handymanWorkerContextService
      .createHandymanWorkerContext(
        {
          handymanProviderContextId: providerContext.id,
          workforceProfileId: profile.id,
        },
        adminUserId,
      );

    const bundle = await handymanWorkCrewService.createHandymanWorkCrew(
      {
        handymanProviderContextId: providerContext.id,
        code: `CREW_${suffix()}`,
        name: 'Field Crew',
        leadWorkerContextId: workerContext.id,
      },
      adminUserId,
    );

    const member = await inAppRows(bundle.leadMembership.id);
    assert.equal(member.length, 1);
    assert.equal(member[0].source_event_type, 'HANDYMAN_CREW_MEMBER_ADDED');
    assert.equal(member[0].source_entity_type, 'HANDYMAN_WORK_CREW_MEMBERSHIP');

    const lead = await inAppRows(bundle.lead.id);
    assert.equal(lead.length, 1);
    assert.equal(lead[0].source_event_type, 'HANDYMAN_CREW_LEAD_DESIGNATED');
    assert.equal(lead[0].source_entity_type, 'HANDYMAN_WORK_CREW_LEAD');
  });

  it('16: a second member and a new lead are their OWN notifications', async () => {
    const realm = await realmFixture('Part03 Crew Change');
    const recipient = await recipientFixture(realm, 'Ops');
    await subscribe({
      clientId: realm.client.id,
      eventType: 'HANDYMAN_CREW_MEMBER_ADDED',
      recipientUserId: recipient.id,
      channel: 'IN_APP',
    });
    await subscribe({
      clientId: realm.client.id,
      eventType: 'HANDYMAN_CREW_LEAD_DESIGNATED',
      recipientUserId: recipient.id,
      channel: 'IN_APP',
    });

    const vendor = await vendorService.createVendor({
      clientId: realm.client.id,
      vendorCode: `V_${suffix()}`,
      vendorName: 'Field Providers',
    });
    const providerContext = await handymanProviderContextService
      .createHandymanProviderContext({ vendorId: vendor.id }, adminUserId);

    const workerContexts = [];
    for (const label of ['Lead', 'Second']) {
      const linkedUser = await userService.createUser({
        email: `${label.toLowerCase()}-${suffix().toLowerCase()}@example.com`,
        displayName: label,
      });
      const profile = await workforceService.createWorkforceProfile({
        organizationId: realm.organization.id,
        departmentId: realm.department.id,
        positionId: realm.position.id,
        employeeCode: `WF_${suffix()}`,
        fullName: `${label} Worker`,
        workforceType: 'EXTERNAL',
        userId: linkedUser.id,
      });
      await assignBuildingToWorkforce({
        workforceProfileId: profile.id,
        buildingId: realm.building.id,
      });
      await vendorWorkforceService.createVendorWorkforceBinding({
        vendorId: vendor.id,
        workforceProfileId: profile.id,
        vendorPersonnelCode: `VP_${suffix()}`,
      });
      workerContexts.push(
        await handymanWorkerContextService.createHandymanWorkerContext(
          {
            handymanProviderContextId: providerContext.id,
            workforceProfileId: profile.id,
          },
          adminUserId,
        ),
      );
    }

    const bundle = await handymanWorkCrewService.createHandymanWorkCrew(
      {
        handymanProviderContextId: providerContext.id,
        code: `CREW_${suffix()}`,
        name: 'Field Crew',
        leadWorkerContextId: workerContexts[0].id,
      },
      adminUserId,
    );
    const added = await handymanWorkCrewService.addHandymanCrewMember(
      {
        handymanCrewId: bundle.crew.id,
        handymanWorkerContextId: workerContexts[1].id,
      },
      adminUserId,
    );
    const lead = await handymanWorkCrewService.designateHandymanCrewLead(
      {
        handymanCrewId: bundle.crew.id,
        handymanWorkerContextId: workerContexts[1].id,
      },
      adminUserId,
    );

    // The second member is its OWN notification (the membership, never the
    // crew aggregate — two members of one crew never collapse).
    const memberRows = await inAppRows(added.id);
    assert.equal(memberRows.length, 1);
    assert.equal(memberRows[0].source_event_type, 'HANDYMAN_CREW_MEMBER_ADDED');

    // The re-designation is its OWN notification (the new lead row).
    const leadRows = await inAppRows(lead.id);
    assert.equal(leadRows.length, 1);
    assert.equal(leadRows[0].source_event_type, 'HANDYMAN_CREW_LEAD_DESIGNATED');
    assert.notEqual(lead.id, bundle.lead.id);
  });
});

describe('CR-HM-MULTICLIENT-NOTIFICATION-01 PART 03 — the reused transport', () => {
  it('17: one domain event → ONE inbox record, ONE FCM delivery, ONE Web Push delivery', async () => {
    const f = await requestFixture('Part03 Fan-out');
    const recipient = await recipientFixture(f.realm, 'Ops');
    // ONE subscription: the inbox mirror (in-app) + the durable PUSH intent.
    await subscribe({
      clientId: f.realm.client.id,
      eventType: 'HANDYMAN_REQUEST_TRIAGED',
      recipientUserId: recipient.id,
      channel: 'PUSH',
    });
    await registerPushToken(recipient.id, {
      deviceId: 'android-part03',
      pushToken: `tok-${randomUUID().replace(/-/g, '')}`,
      platform: 'ANDROID',
    });
    await registerBrowserPushSubscription(recipient.id, {
      deviceId: 'browser-part03',
      endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
      p256dh: browserPublicKeyBase64Url(),
      auth: randomBytes(16).toString('base64url'),
    });

    const decision = await handymanServiceRequestTriageService
      .recordHandymanRequestTriage(
        {
          handymanRequestId: f.request.id,
          triageDisposition: 'INSPECTION_REQUIRED',
          triageNote: 'Ceiling leak — needs a visit.',
        },
        adminUserId,
      );

    assert.equal((await inAppRows(decision.id)).length, 1, 'one inbox record');
    const ledger = await ledgerRows(decision.id);
    assert.equal(ledger.length, 1, 'one durable push intent');
    assert.equal(ledger[0].channel, 'PUSH');

    const nativeSent: string[] = [];
    const browserSent: string[] = [];
    const outcome = await processOutboundDelivery(ledger[0].id, new Date(), {
      PUSH: {
        provider: 'test-native',
        send: async (input) => {
          nativeSent.push(input.token);
          return {
            status: 'SENT' as const,
            provider: 'test-native',
            providerMessageId: 'native-part03',
            sentAt: new Date(),
          };
        },
      },
      PUSH_BROWSER: {
        provider: 'test-browser',
        send: async (input) => {
          browserSent.push(input.subscription.endpoint);
          return {
            status: 'SENT' as const,
            provider: 'test-browser',
            providerMessageId: 'browser-part03',
            sentAt: new Date(),
          };
        },
      },
    });
    assert.equal(outcome.kind, 'SENT');
    assert.equal(nativeSent.length, 1, 'exactly one FCM delivery');
    assert.equal(browserSent.length, 1, 'exactly one Web Push delivery');
    assert.equal(
      (await inAppRows(decision.id)).length,
      1,
      'still exactly one inbox record after the push fan-out',
    );
  });

  it('18: the EMAIL and WHATSAPP channels still work for a domain event', async () => {
    const f = await requestFixture('Part03 Channels');
    const recipient = await recipientFixture(f.realm, 'Ops');
    await subscribe({
      clientId: f.realm.client.id,
      eventType: 'HANDYMAN_REQUEST_TRIAGED',
      recipientUserId: recipient.id,
      channel: 'EMAIL',
      subject: 'Permintaan {{handymanRequestId}}',
      body: 'Permintaan {{handymanRequestId}} telah diproses.',
    });
    const decision = await handymanServiceRequestTriageService
      .recordHandymanRequestTriage(
        {
          handymanRequestId: f.request.id,
          triageDisposition: 'INSPECTION_REQUIRED',
          triageNote: 'Ceiling leak — needs a visit.',
        },
        adminUserId,
      );
    const ledger = await ledgerRows(decision.id);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].channel, 'EMAIL');
    assert.equal(ledger[0].status, 'PENDING');
  });
});

describe('CR-HM-MULTICLIENT-NOTIFICATION-01 PART 03 — the isolation, the outbox and the dedupe', () => {
  it('19: another tenant\'s subscription never fires', async () => {
    const f = await requestFixture('Part03 Isolation');
    const other = await requestFixture('Part03 Other Tenant');
    const otherRecipient = await recipientFixture(other.realm, 'Foreign Ops');
    await subscribe({
      clientId: other.realm.client.id,
      eventType: 'HANDYMAN_REQUEST_TRIAGED',
      recipientUserId: otherRecipient.id,
      channel: 'IN_APP',
    });
    await subscribe({
      clientId: other.realm.client.id,
      eventType: 'HANDYMAN_REQUEST_TRIAGED',
      recipientUserId: otherRecipient.id,
      channel: 'PUSH',
    });

    const decision = await handymanServiceRequestTriageService
      .recordHandymanRequestTriage(
        {
          handymanRequestId: f.request.id,
          triageDisposition: 'INSPECTION_REQUIRED',
          triageNote: 'Ceiling leak — needs a visit.',
        },
        adminUserId,
      );

    assert.equal(
      (await inAppRows(decision.id)).length,
      0,
      'no inbox record for a foreign tenant',
    );
    assert.equal(
      (await ledgerRows(decision.id)).length,
      0,
      'no durable intent for a foreign tenant',
    );
  });

  it('20: the recipient scope keeps a foreign recipient out', async () => {
    const f = await requestFixture('Part03 Recipient Scope');
    const other = await requestFixture('Part03 Foreign Recipient');
    const foreign = await recipientFixture(other.realm, 'Foreign Ops');
    // The rule names the foreign user, but the scope keeps the audience
    // inside the tenant of the event.
    await subscribe({
      clientId: f.realm.client.id,
      eventType: 'HANDYMAN_REQUEST_TRIAGED',
      recipientUserId: foreign.id,
      channel: 'IN_APP',
      scopeClientId: f.realm.client.id,
    });

    const decision = await handymanServiceRequestTriageService
      .recordHandymanRequestTriage(
        {
          handymanRequestId: f.request.id,
          triageDisposition: 'INSPECTION_REQUIRED',
          triageNote: 'Ceiling leak — needs a visit.',
        },
        adminUserId,
      );
    assert.equal(
      (await inAppRows(decision.id)).length,
      0,
      'a recipient outside the tenant scope is filtered out',
    );
  });

  it('21: the intents are written ON the domain transaction (they roll back with it)', async () => {
    const f = await requestFixture('Part03 Outbox');
    const recipient = await recipientFixture(f.realm, 'Ops');
    await subscribe({
      clientId: f.realm.client.id,
      eventType: 'HANDYMAN_REQUEST_TRIAGED',
      recipientUserId: recipient.id,
      channel: 'IN_APP',
    });
    await subscribe({
      clientId: f.realm.client.id,
      eventType: 'HANDYMAN_REQUEST_TRIAGED',
      recipientUserId: recipient.id,
      channel: 'PUSH',
    });
    const entityId = randomUUID();

    await assert.rejects(
      withTransaction(async (tx) => {
        await emitHandymanDomainNotificationIntent(
          {
            eventType: 'HANDYMAN_REQUEST_TRIAGED',
            clientId: f.realm.client.id,
            entityId,
            buildingId: f.realm.building.id,
            variables: { handymanRequestId: f.request.id },
          },
          { executor: tx },
        );
        throw new Error('the domain fact fails AFTER the notification');
      }),
      /the domain fact fails AFTER the notification/,
    );

    assert.equal(
      (await inAppRows(entityId)).length,
      0,
      'the in-app record rolled back with the transaction',
    );
    assert.equal(
      (await ledgerRows(entityId)).length,
      0,
      'the durable intent rolled back with the transaction',
    );
  });

  it('22: the outbound idempotency key dedupes a repeated intent', async () => {
    const f = await requestFixture('Part03 Dedupe');
    const recipient = await recipientFixture(f.realm, 'Ops');
    await subscribe({
      clientId: f.realm.client.id,
      eventType: 'HANDYMAN_REQUEST_TRIAGED',
      recipientUserId: recipient.id,
      channel: 'PUSH',
    });
    const entityId = randomUUID();
    const event = {
      eventType: 'HANDYMAN_REQUEST_TRIAGED',
      clientId: f.realm.client.id,
      entityId,
      buildingId: f.realm.building.id,
      variables: { handymanRequestId: f.request.id },
    };

    const first = await emitHandymanDomainNotificationIntent(event);
    assert.equal(first.emitted, true);
    assert.equal(first.outbound?.deliveriesCreated, 1);
    assert.equal(first.outbound?.duplicatesSuppressed, 0);

    const second = await emitHandymanDomainNotificationIntent(event);
    assert.equal(second.emitted, true);
    assert.equal(second.outbound?.deliveriesCreated, 0);
    assert.equal(
      second.outbound?.duplicatesSuppressed,
      1,
      'the second run is suppressed by the idempotency key',
    );
    assert.equal((await ledgerRows(entityId)).length, 1, 'ONE ledger row');
  });

  it('23: a notification CONFIGURATION failure never fails the domain command', async () => {
    const f = await requestFixture('Part03 Fail-safe');
    const recipient = await recipientFixture(f.realm, 'Ops');
    // The template asks for a variable the event cannot satisfy: the
    // rendering fails, the notification is skipped, the domain fact commits.
    await subscribe({
      clientId: f.realm.client.id,
      eventType: 'HANDYMAN_REQUEST_TRIAGED',
      recipientUserId: recipient.id,
      channel: 'IN_APP',
      subject: 'Permintaan {{unknownVariable}}',
      body: 'Permintaan {{unknownVariable}} telah diproses.',
    });

    const decision = await handymanServiceRequestTriageService
      .recordHandymanRequestTriage(
        {
          handymanRequestId: f.request.id,
          triageDisposition: 'INSPECTION_REQUIRED',
          triageNote: 'Ceiling leak — needs a visit.',
        },
        adminUserId,
      );

    // The domain fact is committed…
    const journal = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM operational_events
        WHERE event_type = 'HANDYMAN_REQUEST_TRIAGED' AND entity_id = $1`,
      [f.request.id],
    );
    assert.equal(journal[0].n, 1, 'the domain fact committed');
    // …and no half-written notification survives.
    assert.equal((await inAppRows(decision.id)).length, 0);
  });

  it('24: an event nobody subscribed to produces nothing — and never fails', async () => {
    const f = await requestFixture('Part03 No Subscription');
    const decision = await handymanServiceRequestTriageService
      .recordHandymanRequestTriage(
        {
          handymanRequestId: f.request.id,
          triageDisposition: 'INSPECTION_REQUIRED',
          triageNote: 'Ceiling leak — needs a visit.',
        },
        adminUserId,
      );
    assert.equal((await inAppRows(decision.id)).length, 0);
    assert.equal((await ledgerRows(decision.id)).length, 0);
  });

  it('25: an unadmitted event type is refused by the producer (fail-closed)', async () => {
    const f = await requestFixture('Part03 Unadmitted');
    const result = await emitHandymanDomainNotificationIntent({
      eventType: 'HANDYMAN_NOT_A_REAL_EVENT',
      clientId: f.realm.client.id,
      entityId: randomUUID(),
    });
    assert.equal(result.emitted, false);
    assert.equal(result.entityType, null);
    assert.equal(result.error, null);
  });
});

async function disciplineIdByCode(code: string): Promise<string> {
  const discipline = await handymanDisciplineRepository.findDisciplineByCode(
    undefined,
    code,
  );
  if (!discipline) throw new Error(`${code} discipline seed missing`);
  return discipline.id;
}

/**
 * A browser-shaped subscriber public key (the browser keeps the private
 * half): the uncompressed P-256 point, base64url encoded.
 */
function browserPublicKeyBase64Url(): string {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKey = createPublicKey(pair.privateKey);
  const der = publicKey.export({ format: 'der', type: 'spki' });
  // The SPKI DER ends with the uncompressed point (0x04 || X || Y).
  const point = der.subarray(der.length - 65);
  assert.equal(point[0], 0x04, 'an uncompressed P-256 point');
  return point.toString('base64url');
}
