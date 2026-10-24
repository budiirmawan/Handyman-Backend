import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';

/**
 * CR-HM-MULTICLIENT-NOTIFICATION-01 PART 04 — FINAL CERTIFICATION GUARDS.
 *
 * A STATIC contract suite (no database, no network): it pins the certified
 * invariants of PART 01, PART 02 and PART 03 so that a later change cannot
 * silently break the certification. It asserts the CONTRACT, never a
 * behaviour that a functional suite already covers.
 *
 * The certified dimensions:
 *   1. the frozen CR-HM-16 contract is byte-for-byte unchanged,
 *   2. the producers (assignment + domain) are wired and additive,
 *   3. the transports (IN_APP / Web Push / FCM Android) share ONE engine,
 *   4. the transactional outbox, the dedupe key and the retry law,
 *   5. the tenant and recipient isolation,
 *   6. the migration chain 0472 → 0475,
 *   7. the browser and APK contracts, and the absence of a push-send route,
 *   8. the channel compatibility (IN_APP / EMAIL / WHATSAPP / PUSH),
 *   9. the production configuration is read at the adapter boundary only.
 */

const REPO = process.cwd();

function read(relative: string): string {
  return readFileSync(join(REPO, relative), 'utf8');
}

function readRepo(relative: string): string {
  return read(join('src', ...relative.split('/')));
}

const FROZEN_CONTRACT =
  'src/modules/handyman-notifications/handyman-notification-contract.ts';
const FROZEN_CONTRACT_SHA256 =
  'c6dfa2386d7a17f90b9352e4f9d614b535e0c27822f6dd08fa533388f30dcd99';

const PART03_CONTRACT =
  'src/modules/handyman-notifications/handyman-domain-notification.contract.ts';
const PART03_PRODUCER =
  'src/modules/handyman-notifications/handyman-domain-notification.producer.ts';
const SEAM =
  'src/modules/handyman-notifications/handyman-notification-intent.service.ts';
const PART01_PRODUCER =
  'src/modules/handyman-notifications/handyman-assignment-notification-producer.service.ts';
const PART01_CONTRACT =
  'src/modules/handyman-notifications/handyman-assignment-notification.contract.ts';

/** The domain services that own the produced Handyman lifecycle facts. */
const DOMAIN_SERVICES = [
  'src/modules/handyman-requests/handyman-request-triage.service.ts',
  'src/modules/handyman-requests/handyman-request-referral.service.ts',
  'src/modules/handyman-requests/handyman-request-cancellation.service.ts',
  'src/modules/handyman-requests/handyman-request-inspection.service.ts',
  'src/modules/handyman-quotations/handyman-quotation-lifecycle.service.ts',
  'src/modules/handyman-scheduling/handyman-permit-readiness.service.ts',
  'src/modules/handyman-scheduling/handyman-scheduling.service.ts',
  'src/modules/handyman-scheduling/handyman-unit-access.service.ts',
  'src/modules/handyman-providers/handyman-work-crew.service.ts',
];

describe('CR-HM-MULTICLIENT-NOTIFICATION-01 PART 04 — the frozen CR-HM-16 contract', () => {
  it('1: is byte-for-byte unchanged and still declares its thirteen entries', () => {
    const source = read(FROZEN_CONTRACT);
    assert.equal(
      createHash('sha256').update(source).digest('hex'),
      FROZEN_CONTRACT_SHA256,
      'the frozen CR-HM-16 contract must not change',
    );
    assert.equal((source.match(/eventType: '/g) ?? []).length, 13);
    // Two SLA entries + eleven domain entries, and NO PART 03 entry leaked
    // into the frozen file.
    const events = [...source.matchAll(/eventType: '([A-Z_]+)'/g)].map(
      (m) => m[1],
    );
    assert.equal(events.filter((e) => e.startsWith('HANDYMAN_')).length, 11);
    assert.ok(!events.includes('HANDYMAN_INSPECTION_RECORDED'));
    // The audience law: every domain event is declarative.
    const audiences = [...source.matchAll(/audience: '([A-Z_]+)'/g)].map(
      (m) => m[1],
    );
    assert.equal(
      audiences.filter((a) => a === 'SUBSCRIPTION_RULE').length,
      11,
      'the eleven domain events keep the declarative audience',
    );
  });

  it('2: is read by the seam only — never mutated, never shadowed', () => {
    // The seam reads the frozen contract (the admission + the meaning).
    assert.ok(read(SEAM).includes("from './handyman-notification-contract'"));
    // The PART 03 producer reads the ADDITIVE contract beside it.
    assert.ok(
      read(PART03_PRODUCER).includes(
        "from './handyman-domain-notification.contract'",
      ),
    );
    // Nothing writes to the frozen contract's exported table.
    for (const file of [PART03_PRODUCER, PART01_PRODUCER, SEAM]) {
      assert.ok(
        !/HANDYMAN_NOTIFICATION_CONTRACT\s*(=|\.push|\.splice)/.test(
          read(file),
        ),
        `${file} never mutates the frozen vocabulary`,
      );
    }
  });
});

describe('CR-HM-MULTICLIENT-NOTIFICATION-01 PART 04 — the producers', () => {
  it('3: admits exactly three vocabularies, all additive beside the frozen one', () => {
    const seam = read(SEAM);
    assert.ok(seam.includes('isHandymanNotificationEventType'));
    assert.ok(seam.includes('isHandymanAssignmentNotificationEventType'));
    assert.ok(seam.includes('isHandymanPart03NotificationEventType'));
    // The PART 03 vocabulary is a SEPARATE file — the frozen one is untouched.
    assert.ok(read(PART03_CONTRACT).includes('HANDYMAN_PART03_NOTIFICATION_CONTRACT'));
    assert.ok(read(PART01_CONTRACT).includes('HANDYMAN_ASSIGNMENT_NOTIFICATION_CONTRACT'));
    // …and the PART 03 vocabulary adds exactly ONE event (the inspection).
    const additive = read(PART03_CONTRACT);
    const additiveEntries = [
      ...additive.matchAll(/^\s{4}eventType: '([A-Z_]+)',/gm),
    ].map((m) => m[1]);
    assert.deepEqual(additiveEntries, ['HANDYMAN_INSPECTION_RECORDED']);
  });

  it('4: wires the eighteen authoritative event call sites', () => {
    const part03 = read(PART03_CONTRACT);
    const vocabulary = [
      ...part03.matchAll(/^  (HANDYMAN_[A-Z_]+): \{/gm),
    ].map((m) => m[1]);
    assert.equal(vocabulary.length, 12, 'twelve produced domain events');

    const bodies = DOMAIN_SERVICES.map((f) => read(f));
    let sites = 0;
    for (const eventType of vocabulary) {
      const owned = bodies.filter((b) => b.includes(`eventType: '${eventType}'`));
      assert.equal(
        owned.length,
        1,
        `${eventType} is produced by exactly one domain authority`,
      );
      // Count the call sites OF THIS EVENT (a service may own several).
      const eventSites = [
        ...owned[0].matchAll(
          /emitHandymanDomainNotificationIntent\([\s\S]*?eventType: '([A-Z_]+)'/g,
        ),
      ].filter((m) => m[1] === eventType);
      assert.ok(eventSites.length >= 1, `${eventType} has a call site`);
      sites += eventSites.length;
    }
    assert.equal(sites, 18, 'eighteen authoritative call sites');
    // Every call site runs on the domain transaction.
    for (const body of bodies) {
      const segments = body.split('emitHandymanDomainNotificationIntent(');
      assert.ok(
        segments.length > 1,
        'each domain service writes its intents on its own transaction',
      );
      for (const segment of segments.slice(1)) {
        const executor = segment.match(/executor:[^\n]*/);
        assert.ok(executor, 'the call site names its executor');
        assert.equal(
          executor[0].replace(/\s+/g, ' ').trim().replace(/[,;]+$/, ''),
          'executor: tx }',
          'the intent is written on the domain transaction',
        );
      }
    }
  });

  it('5: never lets a call site choose the notification entity', () => {
    // The entity type is AUTHORITY data in the contract; a call site that
    // passed one could mislabel the subject of a notification.
    for (const file of DOMAIN_SERVICES) {
      const body = read(file);
      const calls = [
        ...body.matchAll(
          /emitHandymanDomainNotificationIntent\(\s*\{[\s\S]*?\}\s*,/g,
        ),
      ];
      for (const call of calls) {
        assert.ok(
          !/entityType:/.test(call[0]),
          `${file} must not pass an entityType`,
        );
        assert.ok(/eventType:/.test(call[0]));
        assert.ok(/clientId:/.test(call[0]));
        assert.ok(/entityId:/.test(call[0]));
      }
    }
  });

  it('6: writes no lifecycle state — the producer only reacts', () => {
    for (const file of [PART03_PRODUCER, PART01_PRODUCER]) {
      const source = read(file);
      assert.ok(
        !/INSERT INTO handyman_|UPDATE handyman_|DELETE FROM handyman_/i.test(
          source,
        ),
        `${file} must never write a Handyman lifecycle table`,
      );
    }
  });

  it('7: reuses the ONE seam — no second producer path', () => {
    const producer = read(PART03_PRODUCER);
    assert.ok(producer.includes('emitHandymanNotificationIntent'));
    // The producer does not build its own subscription/template/recipient
    // resolution — those stay the reused capability's.
    for (const forbidden of [
      'findMatchingSubscriptions',
      'resolveRecipients',
      'getActiveTemplateByKey',
      'renderTemplate',
      'recordNotification',
      'createOnConflictReturn',
    ]) {
      assert.ok(
        !producer.includes(forbidden),
        `${forbidden} must stay in the reused capability`,
      );
    }
  });
});

describe('CR-HM-MULTICLIENT-NOTIFICATION-01 PART 04 — the transports', () => {
  it('8: shares ONE engine across IN_APP, Web Push and FCM Android', () => {
    const outbound = read(
      'src/modules/notification-delivery/outbound-delivery-intent.service.ts',
    );
    // One outbound chain, one ledger; PUSH travels the generic path.
    assert.ok(outbound.includes("'PUSH'"));
    assert.ok(outbound.includes('computeOutboundDeliveryIdempotencyKey'));
    const fanout = read(
      'src/modules/notification-delivery/outbound-push-fanout.service.ts',
    );
    assert.ok(fanout.includes('browser'), 'the browser targets join the fan-out');
    assert.ok(fanout.includes('mobile'), 'the native targets stay in the fan-out');
    // The native adapter is FCM; the browser adapter is Web Push — both in
    // the ONE governed provider module.
    assert.ok(read('src/modules/push-delivery/fcm-push-adapter.ts').includes('fcm'));
    assert.ok(
      read('src/modules/push-delivery/browser-push-adapter.ts').includes(
        'webpush',
      ),
    );
  });

  it('9: keeps the dedupe law and the retry law', () => {
    const idempotency = read(
      'src/modules/notification-outbound-deliveries/outbound-delivery.idempotency.ts',
    );
    for (const part of [
      'sourceEventType',
      'sourceEntityId',
      'channel',
      'recipientUserId',
      'templateKey',
    ]) {
      assert.ok(idempotency.includes(part), `the idempotency key uses ${part}`);
    }
    const execution = read(
      'src/modules/notification-delivery/outbound-delivery-execution.service.ts',
    );
    // Claim-before-send + a bounded retry, inherited — never a new scheduler.
    assert.ok(execution.includes('claim'));
    assert.ok(/retry|attempt/i.test(execution));
  });

  it('10: keeps the tenant and the recipient isolation', () => {
    // The event carries the tenant; the subscription match filters on it.
    const match = read(
      'src/modules/notification-subscriptions/notification-subscription.repository.ts',
    );
    assert.ok(match.includes('client_id IS NULL OR client_id ='));
    assert.ok(match.includes('building_id IS NULL OR building_id ='));
    // The recipient scope is the BE-02F/BE-02G data-scope guard.
    const recipients = read('src/modules/recipient-resolution/recipient-resolution.types.ts');
    assert.ok(recipients.includes('clientId?: string'));
    assert.ok(recipients.includes('buildingIds?: string[]'));
    // The delivery records carry the tenant.
    assert.ok(
      read('src/modules/notifications/notification.repository.ts').includes(
        'client_id',
      ),
    );
    assert.ok(
      read(
        'src/modules/notification-outbound-deliveries/outbound-delivery.repository.ts',
      ).includes('client_id'),
    );
  });
});

describe('CR-HM-MULTICLIENT-NOTIFICATION-01 PART 04 — the migration chain 0472 → 0475', () => {
  it('11: keeps the registry ordered and ends at 0475', () => {
    const registry = read('src/database/migrations/index.ts');
    const ordered = [
      ...registry.matchAll(/^\s{2}migration04(7[0-5])[A-Za-z]+,$/gm),
    ].map((m) => `04${m[1]}`);
    assert.deepEqual(ordered, ['0470', '0471', '0472', '0473', '0474', '0475']);
    // The upgrade path is contiguous: 0472 (the assignment authority) →
    // 0475 (the browser attempt evidence).
    for (const id of [
      '0472_handyman_assignment_responses',
      '0473_create_browser_push_subscriptions',
      '0474_widen_notification_template_channels_for_push',
      '0475_create_notification_browser_push_deliveries',
    ]) {
      assert.ok(registry.includes(id), `${id} is registered`);
    }
    assert.ok(
      read('src/database/migrations/0472_handyman_assignment_responses.ts').includes(
        "id: '0472_handyman_assignment_responses'",
      ),
    );
    assert.ok(
      read(
        'src/database/migrations/0475_create_notification_browser_push_deliveries.ts',
      ).includes("id: '0475_create_notification_browser_push_deliveries'"),
    );
  });

  it('12: adds no second delivery ledger — only the browser tables and the channel widening', () => {
    const browser = read(
      'src/database/migrations/0473_create_browser_push_subscriptions.ts',
    );
    assert.ok(browser.includes('CREATE TABLE browser_push_subscriptions'));
    const evidence = read(
      'src/database/migrations/0475_create_notification_browser_push_deliveries.ts',
    );
    assert.ok(
      evidence.includes('CREATE TABLE notification_browser_push_deliveries'),
    );
    // The single shared outbound ledger is NOT re-created.
    assert.ok(!evidence.includes('CREATE TABLE notification_outbound_deliveries'));
    // The widening touches exactly one constraint.
    const widening = read(
      'src/database/migrations/0474_widen_notification_template_channels_for_push.ts',
    );
    assert.ok(widening.includes('notification_templates_channel_check'));
    assert.ok(widening.includes("'IN_APP', 'EMAIL', 'WHATSAPP', 'PUSH'"));
  });

  it('13: keeps the inbox channel IN_APP-only and the history channels push-free', () => {
    const inbox = read('src/database/migrations/0237_create_notifications.ts');
    assert.ok(inbox.includes("CHECK (channel IN ('IN_APP'))"));
    const history = read(
      'src/modules/notification-history/notification-history.types.ts',
    );
    assert.ok(history.includes("'IN_APP'"));
    assert.ok(history.includes("'EMAIL'"));
    assert.ok(history.includes("'WHATSAPP'"));
    assert.ok(!history.includes("'PUSH'"), 'PUSH is never a history channel');
  });
});

describe('CR-HM-MULTICLIENT-NOTIFICATION-01 PART 04 — the published contracts', () => {
  const openapi = parse(read('docs/api/openapi.yaml')) as {
    paths: Record<string, Record<string, { operationId?: string }>>;
    components: { schemas: Record<string, unknown> };
  };

  it('14: publishes the browser contract beside the Android contract', () => {
    const browser = Object.values(openapi.paths['/mobile/push-subscriptions'] ?? {});
    const browserItem = Object.values(
      openapi.paths['/mobile/push-subscriptions/{subscriptionId}'] ?? {},
    );
    const operations = [...browser, ...browserItem]
      .map((op) => op.operationId)
      .filter((id): id is string => typeof id === 'string')
      .sort();
    assert.deepEqual(operations, [
      'listBrowserPushSubscriptions',
      'registerBrowserPushSubscription',
      'revokeAllBrowserPushSubscriptions',
      'revokeBrowserPushSubscription',
    ]);

    const apk = Object.values(openapi.paths['/mobile/push-tokens'] ?? {});
    const apkItem = Object.values(
      openapi.paths['/mobile/push-tokens/{tokenId}'] ?? {},
    );
    const apkOperations = [...apk, ...apkItem]
      .map((op) => op.operationId)
      .filter((id): id is string => typeof id === 'string')
      .sort();
    assert.deepEqual(apkOperations, [
      'deactivatePushToken',
      'listPushTokens',
      'registerPushToken',
    ]);
    assert.ok(
      openapi.components.schemas.BrowserPushSubscriptionRegistration,
      'the browser registration schema is published',
    );
    assert.ok(
      openapi.components.schemas.BrowserPushSubscriptionRevocationResult,
      'the browser revocation schema is published',
    );
  });

  it('15: publishes NO push-send route', () => {
    for (const [path, methods] of Object.entries(openapi.paths)) {
      if (!/push/i.test(path)) continue;
      for (const [method, op] of Object.entries(methods)) {
        assert.ok(
          !['post', 'put', 'patch'].includes(method) ||
            !/send|dispatch|deliver/i.test(String(op.operationId ?? '')),
          `${method.toUpperCase()} ${path} must not be a send route`,
        );
      }
    }
  });
});

describe('CR-HM-MULTICLIENT-NOTIFICATION-01 PART 04 — the production configuration', () => {
  it('16: reads the transport configuration at the adapter boundary only', () => {
    const browser = read('src/modules/push-delivery/browser-push-adapter.ts');
    for (const variable of [
      'PUSH_BROWSER_PROVIDER',
      'PUSH_BROWSER_VAPID_PRIVATE_KEY',
      'PUSH_BROWSER_VAPID_SUBJECT',
      'PUSH_BROWSER_VAPID_PUBLIC_KEY',
      'PUSH_BROWSER_TTL_SECONDS',
      'PUSH_BROWSER_ALLOWED_ENDPOINT_HOSTS',
    ]) {
      assert.ok(browser.includes(variable), `${variable} is read by the adapter`);
    }
    // The native FCM credentials stay in the native adapter.
    const native = read('src/modules/push-delivery/fcm-push-adapter.ts');
    for (const variable of [
      'PUSH_FCM_PROJECT_ID',
      'PUSH_FCM_CLIENT_EMAIL',
      'PUSH_FCM_PRIVATE_KEY',
    ]) {
      assert.ok(native.includes(variable));
    }
    // No application config reads a transport credential.
    const config = read('src/config/env.ts');
    assert.ok(!config.includes('PUSH_BROWSER_VAPID_PRIVATE_KEY'));
    assert.ok(!config.includes('PUSH_FCM_PRIVATE_KEY'));
  });

  it('17: fails closed — no silent fallback to a real transport', () => {
    const browser = read('src/modules/push-delivery/browser-push-adapter.ts');
    assert.ok(browser.includes("CREDENTIAL_LESS_BROWSER_PUSH_PROVIDERS"));
    assert.ok(browser.includes('ConfigError'));
    assert.ok(browser.includes("NODE_ENV === 'test'"));
    const native = read('src/modules/push-delivery/push-adapter.ts');
    assert.ok(native.includes('CREDENTIAL_LESS_PUSH_PROVIDERS'));
    assert.ok(native.includes('ConfigError'));
    // The credential material is never echoed.
    assert.ok(
      !/message:\s*`[^`]*\$\{(privateKey|rawKey|clientEmail|projectId)\}/.test(
        browser,
      ),
      'a configuration error never echoes a credential value',
    );
  });
});
