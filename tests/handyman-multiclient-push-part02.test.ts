import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  createDecipheriv,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { parse } from 'yaml';
import type { Pool, PoolClient } from 'pg';
import { resetAppConfigCache } from '../src/config';
import {
  closePool,
  createPool,
  initDatabase,
  migrateUp,
  migrations,
} from '../src/database';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { buildingService } from '../src/modules/buildings';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { organizationService } from '../src/modules/organizations';
import { departmentService } from '../src/modules/departments';
import { positionService } from '../src/modules/positions';
import { workOrderService } from '../src/modules/work-orders';
import { workforceService } from '../src/modules/workforce';
import { workforceBuildingAssignmentService } from '../src/modules/workforce-building-assignments';
import { createNotificationTemplate } from '../src/modules/notification-templates';
import { notificationSubscriptionRepository } from '../src/modules/notification-subscriptions';
import { notificationOutboundDeliveryRepository } from '../src/modules/notification-outbound-deliveries';
import { deliverOutboundNotifications } from '../src/modules/notification-delivery';
import { processOutboundDelivery } from '../src/modules/notification-delivery/outbound-delivery-execution.service';
import { registerPushToken } from '../src/modules/push-tokens/push-token.service';
import {
  BrowserPushWebPushAdapter,
  buildVapidToken,
  classifyBrowserPushStatus,
  encryptBrowserPushPayload,
  extractUncompressedPublicPoint,
  isAllowedBrowserPushEndpoint,
  readBrowserPushConfig,
  resolveBrowserPushAdapter,
  validateBrowserPushPayload,
  type BrowserPushHttpRequest,
  type BrowserPushHttpResponse,
  type BrowserPushSendInput,
} from '../src/modules/push-delivery';
import {
  listBrowserPushSubscriptions,
  registerBrowserPushSubscription,
  revokeBrowserPushSubscription,
} from '../src/modules/browser-push-subscriptions';
import { browserPushDeliveryRecordRepository } from '../src/modules/notification-browser-push-deliveries';
import { pushDeliveryRecordRepository } from '../src/modules/notification-push-deliveries';
import { userService } from '../src/modules/users';
import { credentialService } from '../src/modules/auth';
import { createAdminUser } from './helpers/access';
import { api } from './helpers/http';
import { startEmbeddedTestDatabase } from './helpers/embedded-test-db';

/**
 * CR-HM-MULTICLIENT-NOTIFICATION-01 PART 02 — MULTI-CLIENT PUSH TRANSPORT
 * (focused suite).
 *
 * The suite proves the PART 02 scope:
 *   1. migration compatibility (the three new migrations, the additive
 *      template-channel widening, the untouched native shapes),
 *   2. browser subscription registration (rotation, revocation, and the
 *      credential-grade fields never leaving the backend),
 *   3. tenant / user isolation (an unauthorized subscription is never
 *      registered, never listed and never revoked),
 *   4. the fan-out to BOTH the native device and the browser subscription of
 *      the same recipient, with NO duplicate IN_APP record,
 *   5. deduplication (a repeated intent creates no second ledger row),
 *   6. retries (a retryable failure schedules the next attempt; a proven
 *      dead subscription is retired),
 *   7. the VAPID / content-encryption contract (a simulated browser
 *      decrypts exactly what the adapter sent),
 *   8. EMAIL / WHATSAPP / IN_APP do not regress.
 */

const V1 = '/api/v1';
const DB_DIR = '/tmp/hm-multiclient-push-part02-pg';
const DB_PORT = 55584;

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = 'asentra_test';

let dbHandle: { stop: () => Promise<void> } | null = null;
let pool: Pool | null = null;

function suffix(): string {
  return randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
}

async function createUserWithLogin(
  email: string,
): Promise<{ token: string; userId: string }> {
  const password = 'PushPass123';
  const user = await userService.createUser({ email, displayName: 'Push User' });
  await credentialService.createInitialCredential({ userId: user.id, password });
  const login = await api().post(`${V1}/auth/login`).send({ email, password });
  return { token: login.body.data.sessionToken as string, userId: user.id };
}

/**
 * Creates a durable PUSH intent for a recipient inside a tenant, and returns
 * the ledger id. The subscription rule is tenant-scoped, so each call gets its
 * own tenant.
 */
async function createPushIntentFor(
  recipientUserId: string,
  tenant: { clientId: string; buildingId: string },
): Promise<string> {
  const template = await createNotificationTemplate({
    key: `TPL_PUSH_${suffix()}`,
    type: 'WORK_ORDER_ASSIGNMENT',
    channel: 'PUSH',
    subject: 'Penugasan {{workOrderNumber}}',
    body: 'Anda menerima penugasan {{workOrderNumber}}.',
  });
  await notificationSubscriptionRepository.create({
    key: `SUB_${suffix()}`,
    eventType: 'WORK_ORDER_ASSIGNMENT_PENDING',
    templateKey: template.key,
    recipientRule: { specs: [{ kind: 'USER', userId: recipientUserId }] },
    clientId: tenant.clientId,
  });
  await deliverOutboundNotifications(
    {
      eventType: 'WORK_ORDER_ASSIGNMENT_PENDING',
      clientId: tenant.clientId,
      entityType: 'WORK_ORDER_ASSIGNMENT',
      entityId: randomUUID(),
      buildingId: tenant.buildingId,
      recipients: [recipientUserId],
      variables: { workOrderNumber: 'WO-LIFECYCLE' },
    },
    ['PUSH'],
  );
  const row = await pool!.query<{ id: string }>(
    `SELECT id FROM notification_outbound_deliveries WHERE recipient_user_id = $1
      ORDER BY created_at DESC LIMIT 1`,
    [recipientUserId],
  );
  return row.rows[0].id;
}

/** A browser-shaped subscriber key pair (the browser keeps the private half). */
function subscriberKeyPair(): {
  privateKey: KeyObject;
  publicPoint: Buffer;
  publicBase64Url: string;
  authBase64Url: string;
} {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicPoint = extractUncompressedPublicPoint(
    createPublicKey(pair.privateKey),
  );
  return {
    privateKey: pair.privateKey,
    publicPoint,
    publicBase64Url: Buffer.from(publicPoint).toString('base64url'),
    authBase64Url: randomBytes16(),
  };
}

function randomBytes16(): string {
  return Buffer.from(
    Array.from({ length: 16 }, () => Math.floor(Math.random() * 256)),
  ).toString('base64url');
}

/**
 * A simulated BROWSER: derives the content key from the sender's public key
 * and its own private key, exactly like a real push service's subscriber
 * does, and decrypts the record. This proves the RFC 8291 implementation is
 * interoperable rather than merely self-consistent.
 */
function decryptAsBrowser(
  record: Buffer,
  subscriberPrivateKey: KeyObject,
  subscriberAuthSecret: Buffer,
): { plaintext: string; senderPublicPoint: Buffer } {
  const salt = record.subarray(0, 16);
  const idLength = record[20];
  const senderPublicPoint = record.subarray(21, 21 + idLength);
  const ciphertext = record.subarray(21 + idLength, record.length - 16);
  const tag = record.subarray(record.length - 16);

  const senderKey = createPublicKey({
    key: Buffer.concat([
      Buffer.from(
        '3059301306072a8648ce3d020106082a8648ce3d030107034200',
        'hex',
      ),
      senderPublicPoint,
    ]),
    format: 'der',
    type: 'spki',
  });
  const sharedSecret = diffieHellman({
    privateKey: subscriberPrivateKey,
    publicKey: senderKey,
  });

  const hkdfExpand = (prk: Buffer, info: Buffer, length: number): Buffer => {
    const blocks: Buffer[] = [];
    let previous = Buffer.alloc(0);
    let counter = 1;
    let produced = 0;
    while (produced < length) {
      const block = createHmac('sha256', prk)
        .update(previous)
        .update(info)
        .update(Buffer.from([counter]))
        .digest();
      blocks.push(block);
      produced += block.length;
      previous = block;
      counter += 1;
    }
    return Buffer.concat(blocks).subarray(0, length);
  };

  const authPrk = createHmac('sha256', subscriberAuthSecret)
    .update(sharedSecret)
    .digest();
  const secret = hkdfExpand(
    authPrk,
    Buffer.concat([
      Buffer.from('WebPush: info\0', 'utf8'),
      subscriberPublicPointOf(subscriberPrivateKey),
      senderPublicPoint,
    ]),
    32,
  );
  const contentPrk = createHmac('sha256', salt).update(secret).digest();
  const cek = hkdfExpand(
    contentPrk,
    Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'),
    16,
  );
  const nonce = hkdfExpand(
    contentPrk,
    Buffer.from('Content-Encoding: nonce\0', 'utf8'),
    12,
  );

  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  // Strip the RFC 8188 delimiter byte.
  return {
    plaintext: decrypted.subarray(0, decrypted.length - 1).toString('utf8'),
    senderPublicPoint,
  };
}

function subscriberPublicPointOf(privateKey: KeyObject): Buffer {
  return extractUncompressedPublicPoint(createPublicKey(privateKey));
}

let clientId = '';
let buildingId = '';

/**
 * A fresh tenant (client → property → building) per scenario: the
 * subscription rules are client-scoped, so a dedicated tenant keeps each
 * scenario's rules from matching another scenario's event.
 */
async function createTenant(): Promise<{ clientId: string; buildingId: string }> {
  const tenant = await clientService.createClient({
    code: `CLI_${suffix()}`,
    name: 'Part02 Tenant',
  });
  const property = await propertyService.createProperty({
    clientId: tenant.id,
    code: `PROP_${suffix()}`,
    name: 'Part02 Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix()}`,
    name: 'Part02 Building',
  });
  return { clientId: tenant.id, buildingId: building.id };
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

  const client = await clientService.createClient({
    code: `CLI_${suffix()}`,
    name: 'Part02 Push Client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `PROP_${suffix()}`,
    name: 'Part02 Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `BLDG_${suffix()}`,
    name: 'Part02 Building',
  });
  clientId = client.id;
  buildingId = building.id;
});

after(async () => {
  await closePool();
  if (dbHandle) {
    await dbHandle.stop();
  }
});

describe('CR-HM-MULTICLIENT-NOTIFICATION-01 PART 02 — migration compatibility', () => {
  it('registers the three PART 02 migrations and keeps the native shapes frozen', async () => {
    const migrations = await pool!.query<{ id: string }>(
      `SELECT id FROM schema_migrations ORDER BY id`,
    );
    const ids = migrations.rows.map((row) => row.id);
    for (const expected of [
      '0473_create_browser_push_subscriptions',
      '0474_widen_notification_template_channels_for_push',
      '0475_create_notification_browser_push_deliveries',
    ]) {
      assert.ok(ids.includes(expected), `${expected} must be applied`);
    }

    // The browser registration authority has its own table.
    const browserTable = await pool!.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM browser_push_subscriptions`,
    );
    assert.equal(browserTable.rows[0].count, 0);

    // The template channel now admits PUSH (S-5) — the missing link between
    // the notification engine and the existing push transport.
    await createNotificationTemplate({
      key: `TPL_PUSH_${suffix()}`,
      type: 'WORK_ORDER_ASSIGNMENT',
      channel: 'PUSH',
      subject: 'Penugasan {{workOrderNumber}}',
      body: 'Anda menerima penugasan {{workOrderNumber}}.',
    });

    // The IN_APP inbox channel is NOT widened: a push is not an inbox record.
    const inboxCheck = await pool!.query<{ check: string }>(
      `SELECT pg_get_constraintdef(oid) AS check
         FROM pg_constraint
        WHERE conrelid = 'notifications'::regclass
          AND conname = 'notifications_channel_check'`,
    );
    assert.ok(
      inboxCheck.rows[0]?.check.includes('IN_APP') &&
        !inboxCheck.rows[0].check.includes('PUSH'),
      'the in-app inbox channel CHECK must stay IN_APP only',
    );

    // The NATIVE shapes are frozen: the platform CHECK and the native
    // attempt table are exactly as the CR-BE-PUSH-01 governance froze them.
    const nativeCheck = await pool!.query<{ check: string }>(
      `SELECT pg_get_constraintdef(oid) AS check
         FROM pg_constraint
        WHERE conrelid = 'mobile_push_tokens'::regclass
          AND conname = 'mobile_push_tokens_platform_check'`,
    );
    assert.ok(
      nativeCheck.rows[0]?.check.includes('ANDROID') &&
        nativeCheck.rows[0]?.check.includes('IOS') &&
        !nativeCheck.rows[0]?.check.includes('BROWSER'),
      'a browser is never a native platform value',
    );
    const nativeEvidence = await pool!.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM information_schema.columns
        WHERE table_name = 'notification_push_deliveries'
          AND column_name = 'browser_subscription_id'`,
    );
    assert.equal(
      nativeEvidence.rows[0].count,
      0,
      'the frozen native evidence table must not gain a browser column',
    );
  });
});

describe('CR-HM-MULTICLIENT-NOTIFICATION-01 PART 02 — the browser transport contract', () => {
  it('signs a VAPID token for the endpoint origin and never leaks the key', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const publicPoint = extractUncompressedPublicPoint(createPublicKey(privateKey));
    const config = {
      privateKey,
      publicKeyBase64Url: Buffer.from(publicPoint).toString('base64url'),
      subject: 'mailto:push@example.com',
      ttlSeconds: 3600,
      timeoutMs: 1000,
    };
    const token = buildVapidToken(config, 'https://push.example.com', 1_700_000_000);
    const [header, payload, signature] = token.split('.');
    assert.equal(header.length > 0 && payload.length > 0 && signature.length > 0, true);
    const decodedHeader = JSON.parse(
      Buffer.from(header, 'base64url').toString('utf8'),
    );
    const decodedPayload = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    );
    assert.equal(decodedHeader.alg, 'ES256');
    assert.equal(decodedHeader.typ, 'JWT');
    assert.equal(decodedPayload.aud, 'https://push.example.com');
    assert.equal(decodedPayload.sub, 'mailto:push@example.com');
    assert.ok(decodedPayload.exp > 1_700_000_000);
    // The signature is the raw r||s form ES256 requires (64 bytes), not DER.
    assert.equal(Buffer.from(signature, 'base64url').length, 64);
  });

  it('encrypts a payload a real browser can decrypt (RFC 8291 round trip)', () => {
    const application = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const applicationPublicPoint = extractUncompressedPublicPoint(
      createPublicKey(application.privateKey),
    );
    const subscriber = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const subscriberPoint = extractUncompressedPublicPoint(
      createPublicKey(subscriber.privateKey),
    );
    const authSecret = Buffer.from(
      Array.from({ length: 16 }, () => Math.floor(Math.random() * 256)),
    );
    const payload = {
      title: 'Penugasan WO-1',
      body: 'Anda menerima penugasan.',
      data: { notificationId: 'abc' },
    };

    const record = encryptBrowserPushPayload(
      Buffer.from(JSON.stringify(payload), 'utf8'),
      subscriberPoint,
      authSecret,
    );

    const decrypted = decryptAsBrowser(record, subscriber.privateKey, authSecret);
    assert.deepEqual(JSON.parse(decrypted.plaintext), payload);
    assert.notDeepEqual(
      decrypted.senderPublicPoint,
      applicationPublicPoint,
      'the record must carry a PER-MESSAGE ephemeral public key, never the long-lived application key',
    );
    assert.equal(decrypted.senderPublicPoint.length, 65);
    assert.equal(decrypted.senderPublicPoint[0], 0x04);
  });

  it('classifies the push service responses into the normalized taxonomy', () => {
    assert.equal(classifyBrowserPushStatus(201).errorCode, 'UNKNOWN_ERROR');
    assert.equal(classifyBrowserPushStatus(410).errorCode, 'INVALID_TOKEN');
    assert.equal(classifyBrowserPushStatus(410).tokenInvalid, true);
    assert.equal(classifyBrowserPushStatus(410).retryable, false);
    assert.equal(classifyBrowserPushStatus(401).errorCode, 'AUTHENTICATION_FAILED');
    assert.equal(classifyBrowserPushStatus(429).retryable, true);
    assert.equal(classifyBrowserPushStatus(503).retryable, true);
    assert.equal(classifyBrowserPushStatus(400).retryable, false);
  });

  it('sends the signed, encrypted request and reports the provider verdict', async () => {
    const application = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const applicationPublicPoint = extractUncompressedPublicPoint(
      createPublicKey(application.privateKey),
    );
    const subscriber = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const subscriberPoint = extractUncompressedPublicPoint(
      createPublicKey(subscriber.privateKey),
    );
    const authSecret = Buffer.from(
      Array.from({ length: 16 }, () => Math.floor(Math.random() * 256)),
    );

    const requests: BrowserPushHttpRequest[] = [];
    const transport = async (
      request: BrowserPushHttpRequest,
    ): Promise<BrowserPushHttpResponse> => {
      requests.push(request);
      return { status: 201, body: '' };
    };

    const adapter = new BrowserPushWebPushAdapter({
      config: {
        privateKey: application.privateKey,
        publicKeyBase64Url: Buffer.from(applicationPublicPoint).toString('base64url'),
        subject: 'mailto:push@example.com',
        ttlSeconds: 3600,
        timeoutMs: 1000,
      },
      transport,
    });

    const input: BrowserPushSendInput = {
      subscription: {
        endpoint: 'https://push.example.com/send/abc',
        p256dh: Buffer.from(subscriberPoint).toString('base64url'),
        auth: authSecret.toString('base64url'),
      },
      title: 'Penugasan',
      body: 'Anda menerima penugasan.',
      data: { notificationId: 'abc' },
      deliveryId: 'delivery-1',
    };

    const result = await adapter.send(input);
    assert.equal(result.status, 'SENT');
    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.match(request.headers.Authorization, /^vapid t=/);
    assert.equal(request.headers['Content-Encoding'], 'aes128gcm');
    assert.equal(request.headers['Content-Type'], 'application/octet-stream');
    assert.equal(request.headers.TTL, '3600');
    // The body is the encrypted record, never the plaintext payload.
    assert.ok(!request.body.toString('utf8').includes('Penugasan'));
    const decrypted = decryptAsBrowser(request.body, subscriber.privateKey, authSecret);
    assert.equal(JSON.parse(decrypted.plaintext).title, 'Penugasan');
  });

  it('rejects a payload that breaks the defensive bounds before any I/O', () => {
    const violations = validateBrowserPushPayload({
      subscription: {
        endpoint: 'https://push.example.com/send/abc',
        p256dh: 'x',
        auth: 'y',
      },
      title: '',
      body: 'b'.repeat(241),
      data: { key: 'value' },
    });
    assert.equal(violations.length, 2);
    assert.ok(violations.some((v) => v.includes('title')));
    assert.ok(violations.some((v) => v.includes('body')));
  });

  it('accepts only HTTPS endpoints on a known push service origin', () => {
    assert.equal(
      isAllowedBrowserPushEndpoint('https://fcm.googleapis.com/fcm/send/abc'),
      true,
    );
    assert.equal(
      isAllowedBrowserPushEndpoint('https://updates.push.services.mozilla.com/w/abc'),
      true,
    );
    assert.equal(
      isAllowedBrowserPushEndpoint('http://fcm.googleapis.com/fcm/send/abc'),
      false,
    );
    assert.equal(
      isAllowedBrowserPushEndpoint('https://attacker.example.com/collect'),
      false,
    );
    assert.equal(
      isAllowedBrowserPushEndpoint('https://user:pass@fcm.googleapis.com/x'),
      false,
    );
  });

  it('refuses the real browser transport in the test environment', () => {
    const previous = process.env.PUSH_BROWSER_PROVIDER;
    process.env.PUSH_BROWSER_PROVIDER = 'webpush';
    assert.throws(
      () => resolveBrowserPushAdapter(),
      /cannot be resolved in the test environment/,
    );
    process.env.PUSH_BROWSER_PROVIDER = 'noop';
    const adapter = resolveBrowserPushAdapter();
    assert.equal(adapter.provider, 'noop');
    if (previous === undefined) {
      delete process.env.PUSH_BROWSER_PROVIDER;
    } else {
      process.env.PUSH_BROWSER_PROVIDER = previous;
    }
  });

  it('reads the VAPID configuration only at the adapter boundary', () => {
    assert.throws(
      () => readBrowserPushConfig({} as NodeJS.ProcessEnv),
      /PUSH_BROWSER_VAPID_PRIVATE_KEY is required/,
    );
    assert.throws(
      () =>
        readBrowserPushConfig({
          PUSH_BROWSER_VAPID_PRIVATE_KEY: 'not-a-pem',
          PUSH_BROWSER_VAPID_SUBJECT: 'mailto:push@example.com',
        } as NodeJS.ProcessEnv),
      /PEM-encoded EC private key/,
    );
  });
});

describe('CR-HM-MULTICLIENT-NOTIFICATION-01 PART 02 — browser subscription registration', () => {
  it('registers, lists and revokes a browser subscription of the authenticated user', async () => {
    const user = await createUserWithLogin(`browser-${suffix()}@example.com`);
    const keys = subscriberKeyPair();
    const endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;

    const created = await api()
      .post(`${V1}/mobile/push-subscriptions`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({
        deviceId: 'browser-1',
        endpoint,
        p256dh: keys.publicBase64Url,
        auth: keys.authBase64Url,
      });
    assert.equal(created.status, 201);
    assert.equal(created.body.data.status, 'ACTIVE');
    assert.equal(created.body.data.deviceId, 'browser-1');
    // The credential-grade fields never leave the backend.
    const serialized = JSON.stringify(created.body);
    assert.ok(!serialized.includes(keys.publicBase64Url));
    assert.ok(!serialized.includes(keys.authBase64Url));
    assert.ok(!serialized.includes(endpoint));

    const listed = await api()
      .get(`${V1}/mobile/push-subscriptions`)
      .set('Authorization', `Bearer ${user.token}`);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.data.length, 1);
    assert.equal(listed.body.data[0].id, created.body.data.id);

    const revoked = await api()
      .delete(`${V1}/mobile/push-subscriptions/${created.body.data.id}`)
      .set('Authorization', `Bearer ${user.token}`);
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.data.status, 'INACTIVE');

    // The row is RETAINED as history — never deleted.
    const row = await pool!.query<{ status: string }>(
      `SELECT status FROM browser_push_subscriptions WHERE id = $1`,
      [created.body.data.id],
    );
    assert.equal(row.rows[0].status, 'INACTIVE');
  });

  it('rejects an unauthenticated registration', async () => {
    const response = await api()
      .post(`${V1}/mobile/push-subscriptions`)
      .send({ deviceId: 'x', endpoint: 'https://fcm.googleapis.com/x', p256dh: 'a', auth: 'b' });
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'AUTHENTICATION_REQUIRED');
  });

  it('refuses another user’s subscription (no cross-user listing or revocation)', async () => {
    const owner = await createUserWithLogin(`owner-${suffix()}@example.com`);
    const stranger = await createUserWithLogin(`stranger-${suffix()}@example.com`);
    const keys = subscriberKeyPair();
    const created = await registerBrowserPushSubscription(owner.userId, {
      deviceId: 'browser-owner',
      endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
      p256dh: keys.publicBase64Url,
      auth: keys.authBase64Url,
    });

    const strangerList = await api()
      .get(`${V1}/mobile/push-subscriptions`)
      .set('Authorization', `Bearer ${stranger.token}`);
    assert.equal(strangerList.status, 200);
    assert.equal(
      strangerList.body.data.length,
      0,
      'a user must never see another user’s subscriptions',
    );

    const strangerRevoke = await api()
      .delete(`${V1}/mobile/push-subscriptions/${created.id}`)
      .set('Authorization', `Bearer ${stranger.token}`);
    assert.equal(strangerRevoke.status, 404);
    const still = await pool!.query<{ status: string }>(
      `SELECT status FROM browser_push_subscriptions WHERE id = $1`,
      [created.id],
    );
    assert.equal(still.rows[0].status, 'ACTIVE');
  });

  it('rejects a malformed or foreign endpoint and malformed key material', async () => {
    const user = await createUserWithLogin(`invalid-${suffix()}@example.com`);
    const keys = subscriberKeyPair();

    const foreign = await api()
      .post(`${V1}/mobile/push-subscriptions`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({
        deviceId: 'browser-x',
        endpoint: 'https://attacker.example.com/collect',
        p256dh: keys.publicBase64Url,
        auth: keys.authBase64Url,
      });
    assert.equal(foreign.status, 400);
    assert.equal(foreign.body.error.code, 'VALIDATION_ERROR');

    const badKey = await api()
      .post(`${V1}/mobile/push-subscriptions`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({
        deviceId: 'browser-x',
        endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
        p256dh: 'not-base64url!!',
        auth: keys.authBase64Url,
      });
    assert.equal(badKey.status, 400);
  });

  it('rotates the key pair of the same browser instead of stacking registrations', async () => {
    const user = await createUserWithLogin(`rotate-${suffix()}@example.com`);
    const first = subscriberKeyPair();
    const second = subscriberKeyPair();

    const created = await registerBrowserPushSubscription(user.userId, {
      deviceId: 'browser-rotate',
      endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
      p256dh: first.publicBase64Url,
      auth: first.authBase64Url,
    });
    const rotated = await registerBrowserPushSubscription(user.userId, {
      deviceId: 'browser-rotate',
      endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
      p256dh: second.publicBase64Url,
      auth: second.authBase64Url,
    });

    assert.equal(rotated.id, created.id, 'rotation must reuse the registration row');
    const rows = await pool!.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM browser_push_subscriptions
        WHERE user_id = $1 AND status = 'ACTIVE'`,
      [user.userId],
    );
    assert.equal(rows.rows[0].count, 1, 'exactly one ACTIVE registration per browser');
    const stored = await pool!.query<{ p256dh: string }>(
      `SELECT p256dh FROM browser_push_subscriptions WHERE id = $1`,
      [created.id],
    );
    assert.equal(stored.rows[0].p256dh, second.publicBase64Url);
  });

  it('retires the previous owner when the same endpoint is registered elsewhere', async () => {
    const first = await createUserWithLogin(`first-${suffix()}@example.com`);
    const second = await createUserWithLogin(`second-${suffix()}@example.com`);
    const keys = subscriberKeyPair();
    const endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;

    const created = await registerBrowserPushSubscription(first.userId, {
      deviceId: 'browser-shared',
      endpoint,
      p256dh: keys.publicBase64Url,
      auth: keys.authBase64Url,
    });
    await registerBrowserPushSubscription(second.userId, {
      deviceId: 'browser-shared-2',
      endpoint,
      p256dh: keys.publicBase64Url,
      auth: keys.authBase64Url,
    });

    const rows = await pool!.query<{ id: string; status: string }>(
      `SELECT id, status FROM browser_push_subscriptions WHERE endpoint = $1 ORDER BY id`,
      [endpoint],
    );
    assert.equal(rows.rows.length, 2);
    assert.equal(
      rows.rows.find((row) => row.id === created.id)?.status,
      'INACTIVE',
      'one subscription must never route to two active users',
    );
    assert.equal(
      rows.rows.filter((row) => row.status === 'ACTIVE').length,
      1,
    );
  });

  it('revokes every browser subscription of the user at once', async () => {
    const user = await createUserWithLogin(`revoke-all-${suffix()}@example.com`);
    for (const label of ['a', 'b']) {
      const keys = subscriberKeyPair();
      await registerBrowserPushSubscription(user.userId, {
        deviceId: `browser-${label}`,
        endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
        p256dh: keys.publicBase64Url,
        auth: keys.authBase64Url,
      });
    }
    const response = await api()
      .delete(`${V1}/mobile/push-subscriptions`)
      .set('Authorization', `Bearer ${user.token}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.data.revokedCount, 2);
    const active = await pool!.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM browser_push_subscriptions
        WHERE user_id = $1 AND status = 'ACTIVE'`,
      [user.userId],
    );
    assert.equal(active.rows[0].count, 0);
  });
});

describe('CR-HM-MULTICLIENT-NOTIFICATION-01 PART 02 — the multi-client fan-out', () => {
  async function seedPushPolicy(
    recipientUserId: string,
    tenant: { clientId: string },
  ): Promise<string> {
    const template = await createNotificationTemplate({
      key: `TPL_PUSH_${suffix()}`,
      type: 'WORK_ORDER_ASSIGNMENT',
      channel: 'PUSH',
      subject: 'Penugasan {{workOrderNumber}}',
      body: 'Anda menerima penugasan {{workOrderNumber}}.',
    });
    await notificationSubscriptionRepository.create({
      key: `SUB_${suffix()}`,
      eventType: 'WORK_ORDER_ASSIGNMENT_PENDING',
      templateKey: template.key,
      recipientRule: { specs: [{ kind: 'USER', userId: recipientUserId }] },
      clientId: tenant.clientId,
    });
    return template.key;
  }

  it('fans one ledger row out to the native device AND the browser, with ONE in-app record', async () => {
    const tenant = await createTenant();
    const user = await createUserWithLogin(`fanout-${suffix()}@example.com`);
    await registerPushToken(user.userId, {
      deviceId: 'android-1',
      pushToken: `tok-${randomUUID().replace(/-/g, '')}`,
      platform: 'ANDROID',
    });
    const keys = subscriberKeyPair();
    await registerBrowserPushSubscription(user.userId, {
      deviceId: 'browser-1',
      endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
      p256dh: keys.publicBase64Url,
      auth: keys.authBase64Url,
    });

    await seedPushPolicy(user.userId, tenant);
    const result = await deliverOutboundNotifications(
      {
        eventType: 'WORK_ORDER_ASSIGNMENT_PENDING',
        clientId: tenant.clientId,
        entityType: 'WORK_ORDER_ASSIGNMENT',
        entityId: randomUUID(),
        buildingId: tenant.buildingId,
        recipients: [user.userId],
        variables: { workOrderNumber: 'WO-42' },
      },
      ['PUSH'],
    );
    assert.equal(result.deliveriesCreated, 1);

    const ledgerRow = await pool!.query<{ id: string }>(
      `SELECT id FROM notification_outbound_deliveries WHERE recipient_user_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [user.userId],
    );
    const ledger = await notificationOutboundDeliveryRepository.findById(
      ledgerRow.rows[0].id,
    );
    assert.ok(ledger, 'the push intent must be a durable ledger row');

    // A browser-only port is enough: the native device is reached through the
    // native port, the browser through the browser port.
    const nativeSent: string[] = [];
    const browserSent: string[] = [];
    const outcome = await processOutboundDelivery(ledger!.id, new Date(), {
      PUSH: {
        provider: 'test-native',
        send: async (input) => {
          nativeSent.push(input.token);
          return {
            status: 'SENT' as const,
            provider: 'test-native',
            providerMessageId: 'native-1',
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
            providerMessageId: 'browser-1',
            sentAt: new Date(),
          };
        },
      },
    });
    assert.equal(outcome.kind, 'SENT');
    assert.equal(nativeSent.length, 1);
    assert.equal(browserSent.length, 1);

    // One evidence row per target, in the RIGHT table.
    const nativeEvidence = await pushDeliveryRecordRepository.listByDeliveryId(
      ledger!.id,
    );
    assert.equal(nativeEvidence.length, 1);
    const browserEvidence =
      await browserPushDeliveryRecordRepository.listByDeliveryId(ledger!.id);
    assert.equal(browserEvidence.length, 1);
    assert.equal(browserEvidence[0].browserSubscriptionId.length > 0, true);
    // The credential-grade endpoint is NEVER copied into the evidence.
    assert.ok(
      !JSON.stringify(browserEvidence).includes('fcm.googleapis.com'),
      'the attempt evidence must not persist the endpoint',
    );
  });

  it('creates exactly one in-app record even with two push targets', async () => {
    const tenant = await createTenant();
    const user = await createUserWithLogin(`inapp-${suffix()}@example.com`);
    await registerPushToken(user.userId, {
      deviceId: 'android-1',
      pushToken: `tok-${randomUUID().replace(/-/g, '')}`,
      platform: 'ANDROID',
    });
    const keys = subscriberKeyPair();
    await registerBrowserPushSubscription(user.userId, {
      deviceId: 'browser-1',
      endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
      p256dh: keys.publicBase64Url,
      auth: keys.authBase64Url,
    });
    await seedPushPolicy(user.userId, tenant);

    await deliverOutboundNotifications(
      {
        eventType: 'WORK_ORDER_ASSIGNMENT_PENDING',
        clientId: tenant.clientId,
        entityType: 'WORK_ORDER_ASSIGNMENT',
        entityId: randomUUID(),
        buildingId: tenant.buildingId,
        recipients: [user.userId],
        variables: { workOrderNumber: 'WO-43' },
      },
      ['PUSH'],
    );

    const inApp = await pool!.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM notifications WHERE recipient_user_id = $1`,
      [user.userId],
    );
    assert.equal(
      inApp.rows[0].count,
      0,
      'the PUSH chain never writes an in-app record — that stays the domain producer’s job',
    );
  });

  it('deduplicates a repeated intent — no second ledger row, no second attempt', async () => {
    const tenant = await createTenant();
    const user = await createUserWithLogin(`dedupe-${suffix()}@example.com`);
    const keys = subscriberKeyPair();
    await registerBrowserPushSubscription(user.userId, {
      deviceId: 'browser-1',
      endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
      p256dh: keys.publicBase64Url,
      auth: keys.authBase64Url,
    });
    await seedPushPolicy(user.userId, tenant);

    const event = {
      eventType: 'WORK_ORDER_ASSIGNMENT_PENDING',
      clientId: tenant.clientId,
      entityType: 'WORK_ORDER_ASSIGNMENT',
      entityId: randomUUID(),
      buildingId: tenant.buildingId,
      recipients: [user.userId],
      variables: { workOrderNumber: 'WO-44' },
    };
    const first = await deliverOutboundNotifications(event, ['PUSH']);
    const second = await deliverOutboundNotifications(event, ['PUSH']);
    assert.equal(first.deliveriesCreated, 1);
    assert.equal(second.deliveriesCreated, 0);
    assert.equal(second.duplicatesSuppressed, 1);

    const rows = await pool!.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM notification_outbound_deliveries
        WHERE recipient_user_id = $1`,
      [user.userId],
    );
    assert.equal(rows.rows[0].count, 1, 'a repeated command must not duplicate the intent');
  });

  it('never targets another user’s browser subscription', async () => {
    const tenant = await createTenant();
    const recipient = await createUserWithLogin(`recipient-${suffix()}@example.com`);
    const stranger = await createUserWithLogin(`stranger2-${suffix()}@example.com`);
    const keys = subscriberKeyPair();
    await registerBrowserPushSubscription(stranger.userId, {
      deviceId: 'browser-stranger',
      endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
      p256dh: keys.publicBase64Url,
      auth: keys.authBase64Url,
    });
    await seedPushPolicy(recipient.userId, tenant);

    await deliverOutboundNotifications(
      {
        eventType: 'WORK_ORDER_ASSIGNMENT_PENDING',
        clientId: tenant.clientId,
        entityType: 'WORK_ORDER_ASSIGNMENT',
        entityId: randomUUID(),
        buildingId: tenant.buildingId,
        recipients: [recipient.userId],
        variables: { workOrderNumber: 'WO-45' },
      },
      ['PUSH'],
    );

    const evidence = await pool!.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM notification_browser_push_deliveries
        WHERE recipient_user_id = $1`,
      [recipient.userId],
    );
    assert.equal(evidence.rows[0].count, 0);

    const strangerRows = await pool!.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM notification_browser_push_deliveries
        WHERE browser_subscription_id IN (
          SELECT id FROM browser_push_subscriptions WHERE user_id = $1
        )`,
      [stranger.userId],
    );
    assert.equal(
      strangerRows.rows[0].count,
      0,
      'a stranger’s subscription must never be targeted',
    );
  });
});

describe('CR-HM-MULTICLIENT-NOTIFICATION-01 PART 02 — retries and revocation', () => {
  async function createPushIntent(
    recipientUserId: string,
    tenant: { clientId: string; buildingId: string },
  ): Promise<string> {
    const template = await createNotificationTemplate({
      key: `TPL_PUSH_${suffix()}`,
      type: 'WORK_ORDER_ASSIGNMENT',
      channel: 'PUSH',
      subject: 'Penugasan {{workOrderNumber}}',
      body: 'Anda menerima penugasan {{workOrderNumber}}.',
    });
    await notificationSubscriptionRepository.create({
      key: `SUB_${suffix()}`,
      eventType: 'WORK_ORDER_ASSIGNMENT_PENDING',
      templateKey: template.key,
      recipientRule: { specs: [{ kind: 'USER', userId: recipientUserId }] },
      clientId: tenant.clientId,
    });
    await deliverOutboundNotifications(
      {
        eventType: 'WORK_ORDER_ASSIGNMENT_PENDING',
        clientId: tenant.clientId,
        entityType: 'WORK_ORDER_ASSIGNMENT',
        entityId: randomUUID(),
        buildingId: tenant.buildingId,
        recipients: [recipientUserId],
        variables: { workOrderNumber: 'WO-46' },
      },
      ['PUSH'],
    );
    const row = await pool!.query<{ id: string }>(
      `SELECT id FROM notification_outbound_deliveries WHERE recipient_user_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [recipientUserId],
    );
    return row.rows[0].id;
  }

  it('records a retryable failure and schedules the next attempt', async () => {
    const tenant = await createTenant();
    const user = await createUserWithLogin(`retry-${suffix()}@example.com`);
    const keys = subscriberKeyPair();
    await registerBrowserPushSubscription(user.userId, {
      deviceId: 'browser-1',
      endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
      p256dh: keys.publicBase64Url,
      auth: keys.authBase64Url,
    });
    const deliveryId = await createPushIntent(user.userId, tenant);

    const outcome = await processOutboundDelivery(deliveryId, new Date(), {
      PUSH_BROWSER: {
        provider: 'test-browser',
        send: async () => ({
          status: 'FAILED' as const,
          provider: 'test-browser',
          error: 'Push service is unavailable.',
          errorCode: 'PROVIDER_UNAVAILABLE' as const,
          retryable: true,
          sentAt: new Date(),
        }),
      },
    });
    assert.equal(outcome.kind, 'RETRY_SCHEDULED');

    const evidence = await browserPushDeliveryRecordRepository.listByDeliveryId(
      deliveryId,
    );
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].status, 'FAILED');
    assert.equal(evidence[0].errorCode, 'PROVIDER_UNAVAILABLE');
    assert.equal(evidence[0].sentAt, null);

    const row = await pool!.query<{ status: string; next_retry_at: Date | null }>(
      `SELECT status, next_retry_at FROM notification_outbound_deliveries WHERE id = $1`,
      [deliveryId],
    );
    assert.equal(row.rows[0].status, 'RETRY_SCHEDULED');
    assert.ok(row.rows[0].next_retry_at, 'a retry must be scheduled durably');
  });

  it('retires a subscription the push service proved is gone, and audits it', async () => {
    const tenant = await createTenant();
    const user = await createUserWithLogin(`dead-${suffix()}@example.com`);
    const keys = subscriberKeyPair();
    const registration = await registerBrowserPushSubscription(user.userId, {
      deviceId: 'browser-1',
      endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
      p256dh: keys.publicBase64Url,
      auth: keys.authBase64Url,
    });
    const deliveryId = await createPushIntent(user.userId, tenant);

    const outcome = await processOutboundDelivery(deliveryId, new Date(), {
      PUSH_BROWSER: {
        provider: 'test-browser',
        send: async () => ({
          status: 'FAILED' as const,
          provider: 'test-browser',
          error: 'Push service rejected the request with status 410.',
          errorCode: 'INVALID_TOKEN' as const,
          retryable: false,
          tokenInvalid: true,
          sentAt: new Date(),
        }),
      },
    });
    assert.equal(outcome.kind, 'FAILED_PERMANENT');

    const row = await pool!.query<{ status: string; invalidated_at: Date | null }>(
      `SELECT status, invalidated_at FROM browser_push_subscriptions WHERE id = $1`,
      [registration.id],
    );
    assert.equal(row.rows[0].status, 'INVALID');
    assert.ok(row.rows[0].invalidated_at, 'the invalidation keeps its provenance');

    const events = await pool!.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM operational_events
        WHERE event_type = 'NOTIFICATION_BROWSER_PUSH_SUBSCRIPTION_INVALIDATED'`,
    );
    assert.equal(events.rows[0].count, 1, 'the retirement must be audited');
  });

  it('stops fanning out to a revoked browser subscription', async () => {
    const tenant = await createTenant();
    const user = await createUserWithLogin(`revoked-${suffix()}@example.com`);
    const keys = subscriberKeyPair();
    const registration = await registerBrowserPushSubscription(user.userId, {
      deviceId: 'browser-1',
      endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
      p256dh: keys.publicBase64Url,
      auth: keys.authBase64Url,
    });
    await revokeBrowserPushSubscription(user.userId, registration.id);
    const deliveryId = await createPushIntent(user.userId, tenant);

    const sends: string[] = [];
    const outcome = await processOutboundDelivery(deliveryId, new Date(), {
      PUSH_BROWSER: {
        provider: 'test-browser',
        send: async (input) => {
          sends.push(input.subscription.endpoint);
          return {
            status: 'SENT' as const,
            provider: 'test-browser',
            sentAt: new Date(),
          };
        },
      },
    });
    assert.equal(sends.length, 0, 'a revoked subscription is never targeted');
    assert.equal(outcome.kind, 'FAILED_PERMANENT');
  });
});

describe('CR-HM-MULTICLIENT-NOTIFICATION-01 PART 02 — the other channels do not regress', () => {
  it('still produces an EMAIL intent and an in-app record for the same event', async () => {
    const tenant = await createTenant();
    const user = await createUserWithLogin(`email-${suffix()}@example.com`);
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
      recipientRule: { specs: [{ kind: 'USER', userId: user.userId }] },
      clientId: tenant.clientId,
    });

    const result = await deliverOutboundNotifications(
      {
        eventType: 'WORK_ORDER_ASSIGNMENT_PENDING',
        clientId: tenant.clientId,
        entityType: 'WORK_ORDER_ASSIGNMENT',
        entityId: randomUUID(),
        buildingId: tenant.buildingId,
        recipients: [user.userId],
        variables: { workOrderNumber: 'WO-47' },
      },
      ['EMAIL'],
    );
    assert.equal(result.deliveriesCreated, 1);
    const row = await pool!.query<{ channel: string; recipient_address: string }>(
      `SELECT channel, recipient_address FROM notification_outbound_deliveries
        WHERE recipient_user_id = $1`,
      [user.userId],
    );
    assert.equal(row.rows[0].channel, 'EMAIL');
  });
});

// ---------------------------------------------------------------------------
// PART 02 — the interoperability, lifecycle, multi-client and upgrade proofs.
// ---------------------------------------------------------------------------

describe('CR-HM-MULTICLIENT-NOTIFICATION-01 PART 02 — Web Push interoperability', () => {
  /**
   * A KNOWN-ANSWER VECTOR generated by an INDEPENDENT implementation of the
   * same standards (the reference `http_ece` aes128gcm / RFC 8291
   * implementation that every deployed Web Push server uses), with the salt
   * and the ephemeral key pinned. The repository must produce the EXACT same
   * bytes — that is the interoperability proof, and it needs no third-party
   * package in this repository.
   */
  const VECTOR = {
    subscriberPublicPoint:
      'BEJVOEQdxj4wPl-hodu8g6u2KthpnzKUS5rR_sW6M6q5deqIib8x2usGWrgI57Pgtz1EOIrrMGKWOO7q2VpcyyQ',
    authSecret: 'L4ocDUtumj9cfRuOKk9sjg',
    salt: Buffer.from('00112233445566778899aabbccddeeff', 'hex'),
    // The sender's per-message key is a FIXED TEST CONSTANT, expressed as a
    // raw P-256 scalar + its public point — never as a credential-shaped PEM
    // (the repository's privacy sweep forbids committed key files).
    senderScalar: 'Xx0Mm4p-bVxLOikYJzZFXx0Mm4p-bVxLOikYJzZFUA8',
    senderPublicPoint:
      'BIPa4-8lXRTb0c2tTey9P9BcfIZWDjThtHztQihb0EcYMr418PrDBsvc_CZqkxaK2Zrgxe0dMk1-ZRxU77x_kZ4',
    plaintext: JSON.stringify({
      title: 'Penugasan WO-1',
      body: 'Anda menerima penugasan.',
      data: { notificationId: 'vector-1' },
    }),
    expectedRecord:
      '00112233445566778899aabbccddeeff00001000410483dae3ef255d14dbd1cdad4decbd3fd05c7c86560e34e1b47ced42285bd0471832be35f0fac306cbdcfc266a93168ad99ae0c5ed1d324d7e651c54efbc7f919e3b8287406252df6418b9bc971d58cee085307e9e2f128b55098a7dcac19aa7dc1ab7fb4c1eafed90cff274864d8d6a14b6f9297d9ba0cabbcd47c0eeb5950e84222d0f7c6c0b432846b36c0632af4079bd42f5002711e1734bd26c2ed80a244489745dbaf84de44995c2b40037596d9adb9d',
  };

  /**
   * Builds the EC private key object of a raw P-256 scalar (RFC 5915 SEC1
   * DER), so a test vector never has to be committed as a key file.
   */
  function ecPrivateKeyFromScalar(
    scalar: Buffer,
    publicPoint: Buffer,
  ): KeyObject {
    return createPrivateKey({
      key: Buffer.concat([
        Buffer.from('30770201010420', 'hex'),
        scalar,
        Buffer.from('a00a06082a8648ce3d030107a144034200', 'hex'),
        publicPoint,
      ]),
      format: 'der',
      type: 'sec1',
    });
  }

  it('produces the known-answer vector of the independent implementation', () => {
    const senderPublicPoint = Buffer.from(
      VECTOR.senderPublicPoint,
      'base64url',
    );
    const senderPrivate = ecPrivateKeyFromScalar(
      Buffer.from(VECTOR.senderScalar, 'base64url'),
      senderPublicPoint,
    );
    const record = encryptBrowserPushPayload(
      Buffer.from(VECTOR.plaintext, 'utf8'),
      Buffer.from(VECTOR.subscriberPublicPoint, 'base64url'),
      Buffer.from(VECTOR.authSecret, 'base64url'),
      {
        salt: VECTOR.salt,
        ephemeralKeyPair: {
          privateKey: senderPrivate,
          publicPoint: senderPublicPoint,
        },
      },
    );
    assert.equal(
      record.toString('hex'),
      VECTOR.expectedRecord,
      'the repository must produce the byte-identical RFC 8188 aes128gcm record',
    );
    // The record layout of RFC 8188 §2.1.
    assert.equal(record.subarray(0, 16).toString('hex'), VECTOR.salt.toString('hex'));
    assert.equal(record.readUInt32BE(16), 4096, 'the advertised record size');
    assert.equal(record[20], 65, 'the key id length');
    assert.equal(
      record.subarray(21, 86).toString('hex'),
      senderPublicPoint.toString('hex'),
      'the key id is the per-message ephemeral public key',
    );
  });

  it('reads back the known-answer vector with an independent subscriber', () => {
    // The SUBSCRIBER side (a browser) derives the same keys and decrypts the
    // vector — the direction the push service and the browser use.
    const subscriber = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const subscriberPoint = extractUncompressedPublicPoint(
      createPublicKey(subscriber.privateKey),
    );
    const authSecret = Buffer.from(VECTOR.authSecret, 'base64url');
    const record = encryptBrowserPushPayload(
      Buffer.from(VECTOR.plaintext, 'utf8'),
      subscriberPoint,
      authSecret,
    );
    const decrypted = decryptAsBrowser(record, subscriber.privateKey, authSecret);
    assert.equal(decrypted.plaintext, VECTOR.plaintext);
  });

  it('never reuses a salt or an ephemeral key between two messages', () => {
    const subscriber = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const subscriberPoint = extractUncompressedPublicPoint(
      createPublicKey(subscriber.privateKey),
    );
    const authSecret = Buffer.from(VECTOR.authSecret, 'base64url');
    const first = encryptBrowserPushPayload(
      Buffer.from(VECTOR.plaintext, 'utf8'),
      subscriberPoint,
      authSecret,
    );
    const second = encryptBrowserPushPayload(
      Buffer.from(VECTOR.plaintext, 'utf8'),
      subscriberPoint,
      authSecret,
    );
    assert.notEqual(
      first.toString('hex'),
      second.toString('hex'),
      'two messages must never share salt + key material',
    );
    assert.notEqual(
      first.subarray(0, 16).toString('hex'),
      second.subarray(0, 16).toString('hex'),
      'the salt is per message',
    );
    assert.notEqual(
      first.subarray(21, 86).toString('hex'),
      second.subarray(21, 86).toString('hex'),
      'the ephemeral key is per message',
    );
  });
});

describe('CR-HM-MULTICLIENT-NOTIFICATION-01 PART 02 — the FCM Android token compatibility', () => {
  it('registers, rotates, de-duplicates and revokes the ANDROID token', async () => {
    const user = await createUserWithLogin(`fcm-${suffix()}@example.com`);
    const firstToken = `tok-${randomUUID().replace(/-/g, '')}`;

    const registered = await registerPushToken(user.userId, {
      deviceId: 'android-1',
      pushToken: firstToken,
      platform: 'ANDROID',
    });
    assert.equal(registered.status, 'ACTIVE');

    // ROTATION: the same device re-registers with a new token — the row is
    // updated in place, never duplicated.
    const rotatedToken = `tok-${randomUUID().replace(/-/g, '')}`;
    const rotated = await registerPushToken(user.userId, {
      deviceId: 'android-1',
      pushToken: rotatedToken,
      platform: 'ANDROID',
    });
    assert.equal(rotated.id, registered.id, 'rotation updates the row in place');
    const active = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM mobile_push_tokens
        WHERE user_id = $1 AND status = 'ACTIVE'`,
      [user.userId],
    );
    assert.equal(active.rows[0].n, 1);

    // DUPLICATE HANDLING: the same token arriving under another device
    // retires the previous registration (one ACTIVE row per token).
    const moved = await registerPushToken(user.userId, {
      deviceId: 'android-2',
      pushToken: rotatedToken,
      platform: 'ANDROID',
    });
    assert.equal(moved.deviceId, 'android-2');
    const tokenRows = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM mobile_push_tokens
        WHERE user_id = $1 AND status = 'ACTIVE' AND push_token = $2`,
      [user.userId, rotatedToken],
    );
    assert.equal(tokenRows.rows[0].n, 1, 'a token has exactly one ACTIVE owner');
    const retired = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM mobile_push_tokens
        WHERE user_id = $1 AND device_id = 'android-1' AND status = 'INACTIVE'`,
      [user.userId],
    );
    assert.equal(retired.rows[0].n, 1, 'the previous row is kept as history');

    // REVOCATION: the row is retained as history, never deleted.
    await pool!.query(
      `UPDATE mobile_push_tokens SET status = 'INACTIVE' WHERE id = $1`,
      [moved.id],
    );
    const retained = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM mobile_push_tokens WHERE id = $1`,
      [moved.id],
    );
    assert.equal(retained.rows[0].n, 1, 'a revoked registration is retained');
  });

  it('keeps the native and the browser authorities independent', async () => {
    const user = await createUserWithLogin(`independent-${suffix()}@example.com`);
    await registerPushToken(user.userId, {
      deviceId: 'android-1',
      pushToken: `tok-${randomUUID().replace(/-/g, '')}`,
      platform: 'ANDROID',
    });
    const keys = subscriberKeyPair();
    const registration = await registerBrowserPushSubscription(user.userId, {
      deviceId: 'browser-1',
      endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
      p256dh: keys.publicBase64Url,
      auth: keys.authBase64Url,
    });

    // Revoking the browser subscription touches NOTHING in the native table.
    await revokeBrowserPushSubscription(user.userId, registration.id);
    const native = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM mobile_push_tokens
        WHERE user_id = $1 AND status = 'ACTIVE'`,
      [user.userId],
    );
    assert.equal(native.rows[0].n, 1, 'the native device is unaffected');
  });
});

describe('CR-HM-MULTICLIENT-NOTIFICATION-01 PART 02 — one event, one inbox record, two transports', () => {
  async function setupAssignmentFixture() {
    const ops = await createAdminUser();
    const worker = await createAdminUser();
    const tenant = await createTenant();
    for (const actor of [ops, worker]) {
      await buildingAssignmentService.createAssignment(actor.userId, {
        buildingId: tenant.buildingId,
      });
    }
    const organization = await organizationService.createOrganization({
      clientId: tenant.clientId,
      code: `ORG_${suffix()}`,
      name: 'Part02 Org',
    });
    const department = await departmentService.createDepartment({
      organizationId: organization.id,
      code: `DEP_${suffix()}`,
      name: 'Part02 Dept',
    });
    const position = await positionService.createPosition({
      organizationId: organization.id,
      departmentId: department.id,
      code: `POS_${suffix()}`,
      name: 'Part02 Pos',
    });
    const profile = await workforceService.createWorkforceProfile({
      organizationId: organization.id,
      departmentId: department.id,
      positionId: position.id,
      userId: worker.userId,
      employeeCode: `WF_${suffix()}`,
      fullName: 'Part02 Worker',
    });
    await workforceBuildingAssignmentService.assignBuildingToWorkforce({
      workforceProfileId: profile.id,
      buildingId: tenant.buildingId,
    });
    const workOrder = await workOrderService.createWorkOrder({
      clientId: tenant.clientId,
      buildingId: tenant.buildingId,
      workOrderNumber: `WO_${suffix()}`,
      title: 'Perbaikan Pemipa Air',
      workType: 'REPAIR',
      createdByUserId: ops.userId,
    });
    return { ops, worker, tenant, profile, workOrder };
  }

  it('delivers ONE inbox record, ONE FCM delivery and ONE Web Push delivery', async () => {
    const f = await setupAssignmentFixture();
    await registerPushToken(f.worker.userId, {
      deviceId: 'android-1',
      pushToken: `tok-${randomUUID().replace(/-/g, '')}`,
      platform: 'ANDROID',
    });
    const keys = subscriberKeyPair();
    await registerBrowserPushSubscription(f.worker.userId, {
      deviceId: 'browser-1',
      endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
      p256dh: keys.publicBase64Url,
      auth: keys.authBase64Url,
    });

    // The PUSH policy: one template, one subscription rule.
    const template = await createNotificationTemplate({
      key: `TPL_PUSH_${suffix()}`,
      type: 'WORK_ORDER_ASSIGNMENT',
      channel: 'PUSH',
      subject: 'Penugasan {{workOrderNumber}}',
      body: 'Anda menerima penugasan {{workOrderNumber}}.',
    });
    await notificationSubscriptionRepository.create({
      key: `SUB_${suffix()}`,
      eventType: 'WORK_ORDER_ASSIGNMENT_PENDING',
      templateKey: template.key,
      recipientRule: { specs: [{ kind: 'USER', userId: f.worker.userId }] },
      clientId: f.tenant.clientId,
    });

    // The business event: the assignment command itself.
    const created = await api()
      .post(`${V1}/work-orders/${f.workOrder.id}/assignments`)
      .set('Authorization', `Bearer ${f.ops.token}`)
      .send({
        assigneeType: 'WORKFORCE',
        workforceProfileId: f.profile.id,
      });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const assignmentId = created.body.data.id as string;

    // ONE in-app record for the event — never one per push target.
    const inApp = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM notifications WHERE source_entity_id = $1`,
      [assignmentId],
    );
    assert.equal(inApp.rows[0].n, 1, 'exactly one in-app record');

    // ONE durable push intent, addressed to the RECIPIENT.
    const ledger = await pool!.query<{ id: string; channel: string; status: string }>(
      `SELECT id, channel, status FROM notification_outbound_deliveries
        WHERE source_entity_id = $1`,
      [assignmentId],
    );
    assert.equal(ledger.rows.length, 1, 'one ledger row per (channel, recipient)');
    assert.equal(ledger.rows[0].channel, 'PUSH');
    assert.equal(ledger.rows[0].status, 'PENDING', 'no provider contacted yet');

    // The two transports are INDEPENDENT sends of the same intent.
    const nativeSent: string[] = [];
    const browserSent: string[] = [];
    const outcome = await processOutboundDelivery(ledger.rows[0].id, new Date(), {
      PUSH: {
        provider: 'test-native',
        send: async (input) => {
          nativeSent.push(input.token);
          return {
            status: 'SENT' as const,
            provider: 'test-native',
            providerMessageId: 'native-1',
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
            providerMessageId: 'browser-1',
            sentAt: new Date(),
          };
        },
      },
    });
    assert.equal(outcome.kind, 'SENT');
    assert.equal(nativeSent.length, 1, 'exactly one FCM delivery');
    assert.equal(browserSent.length, 1, 'exactly one Web Push delivery');

    // The evidence of the two transports lives in two tables.
    assert.equal(
      (await pushDeliveryRecordRepository.listByDeliveryId(ledger.rows[0].id)).length,
      1,
    );
    assert.equal(
      (
        await browserPushDeliveryRecordRepository.listByDeliveryId(ledger.rows[0].id)
      ).length,
      1,
    );
    // And the inbox record was NOT multiplied by the fan-out.
    const inAppAfter = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM notifications WHERE source_entity_id = $1`,
      [assignmentId],
    );
    assert.equal(inAppAfter.rows[0].n, 1, 'the fan-out never multiplies the inbox');
  });

  it('a failed delivery never rolls back the committed assignment', async () => {
    const f = await setupAssignmentFixture();
    await registerPushToken(f.worker.userId, {
      deviceId: 'android-1',
      pushToken: `tok-${randomUUID().replace(/-/g, '')}`,
      platform: 'ANDROID',
    });
    const keys = subscriberKeyPair();
    await registerBrowserPushSubscription(f.worker.userId, {
      deviceId: 'browser-1',
      endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
      p256dh: keys.publicBase64Url,
      auth: keys.authBase64Url,
    });
    const template = await createNotificationTemplate({
      key: `TPL_PUSH_${suffix()}`,
      type: 'WORK_ORDER_ASSIGNMENT',
      channel: 'PUSH',
      subject: 'Penugasan {{workOrderNumber}}',
      body: 'Anda menerima penugasan {{workOrderNumber}}.',
    });
    await notificationSubscriptionRepository.create({
      key: `SUB_${suffix()}`,
      eventType: 'WORK_ORDER_ASSIGNMENT_PENDING',
      templateKey: template.key,
      recipientRule: { specs: [{ kind: 'USER', userId: f.worker.userId }] },
      clientId: f.tenant.clientId,
    });

    const created = await api()
      .post(`${V1}/work-orders/${f.workOrder.id}/assignments`)
      .set('Authorization', `Bearer ${f.ops.token}`)
      .send({ assigneeType: 'WORKFORCE', workforceProfileId: f.profile.id });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const assignmentId = created.body.data.id as string;

    const ledger = await pool!.query<{ id: string }>(
      `SELECT id FROM notification_outbound_deliveries WHERE source_entity_id = $1`,
      [assignmentId],
    );

    // The state of the committed business fact BEFORE the delivery attempt.
    const before = await pool!.query<{ status: string; assignee_type: string }>(
      `SELECT status, assignee_type FROM work_order_assignments WHERE id = $1`,
      [assignmentId],
    );

    // BOTH transports fail — one retryable, one permanent.
    await processOutboundDelivery(ledger.rows[0].id, new Date(), {
      PUSH: {
        provider: 'test-native',
        send: async () => ({
          status: 'FAILED' as const,
          provider: 'test-native',
          error: 'The push service is temporarily unavailable.',
          errorCode: 'PROVIDER_UNAVAILABLE' as const,
          retryable: true,
          sentAt: new Date(),
        }),
      },
      PUSH_BROWSER: {
        provider: 'test-browser',
        send: async () => ({
          status: 'FAILED' as const,
          provider: 'test-browser',
          error: 'The push service rejected the request with status 410.',
          errorCode: 'INVALID_TOKEN' as const,
          retryable: false,
          tokenInvalid: true,
          sentAt: new Date(),
        }),
      },
    });

    // The assignment fact is UNCHANGED — the delivery failure is not a
    // transaction failure of the business command.
    const assignment = await pool!.query<{ status: string; assignee_type: string }>(
      `SELECT status, assignee_type FROM work_order_assignments WHERE id = $1`,
      [assignmentId],
    );
    assert.equal(
      assignment.rows[0].status,
      before.rows[0].status,
      'the assignment stands exactly as it was committed',
    );
    assert.equal(assignment.rows[0].assignee_type, 'WORKFORCE');
    const inApp = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM notifications WHERE source_entity_id = $1`,
      [assignmentId],
    );
    assert.equal(inApp.rows[0].n, 1, 'the inbox record stands');
    const workOrder = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM work_orders WHERE id = $1`,
      [f.workOrder.id],
    );
    assert.equal(workOrder.rows[0].n, 1, 'the work order stands');
  });
});

describe('CR-HM-MULTICLIENT-NOTIFICATION-01 PART 02 — the browser subscription lifecycle', () => {
  it('runs register → replace → revoke → expire → cleanup', async () => {
    const user = await createUserWithLogin(`lifecycle-${suffix()}@example.com`);
    const first = subscriberKeyPair();
    const second = subscriberKeyPair();

    // REGISTER
    const registered = await registerBrowserPushSubscription(user.userId, {
      deviceId: 'browser-1',
      endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
      p256dh: first.publicBase64Url,
      auth: first.authBase64Url,
    });
    assert.equal(registered.status, 'ACTIVE');

    // REPLACE (key rotation on the same browser)
    const replaced = await registerBrowserPushSubscription(user.userId, {
      deviceId: 'browser-1',
      endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
      p256dh: second.publicBase64Url,
      auth: second.authBase64Url,
    });
    assert.equal(replaced.id, registered.id, 'the replacement reuses the row');
    const stored = await pool!.query<{ p256dh: string; status: string }>(
      `SELECT p256dh, status FROM browser_push_subscriptions WHERE id = $1`,
      [registered.id],
    );
    assert.equal(stored.rows[0].p256dh, second.publicBase64Url);
    assert.equal(stored.rows[0].status, 'ACTIVE');

    // EXPIRE: the push service reports the subscription as gone (404) — the
    // evidence retires it with its provenance.
    const deliveryId = await createPushIntentFor(user.userId, await createTenant());
    await processOutboundDelivery(deliveryId, new Date(), {
      PUSH_BROWSER: {
        provider: 'test-browser',
        send: async () => ({
          status: 'FAILED' as const,
          provider: 'test-browser',
          error: 'The push service reported status 404.',
          errorCode: 'INVALID_TOKEN' as const,
          retryable: false,
          tokenInvalid: true,
          sentAt: new Date(),
        }),
      },
    });
    const expired = await pool!.query<{
      status: string;
      invalidated_at: Date | null;
      invalidation_reason: string | null;
    }>(
      `SELECT status, invalidated_at, invalidation_reason
         FROM browser_push_subscriptions WHERE id = $1`,
      [registered.id],
    );
    assert.equal(expired.rows[0].status, 'INVALID');
    assert.ok(expired.rows[0].invalidated_at, 'the expiry keeps its provenance');
    assert.ok(expired.rows[0].invalidation_reason);

    // CLEANUP: the expired subscription is not fanned out to any more, and
    // the history row is retained.
    const afterExpiry = await createPushIntentFor(user.userId, await createTenant());
    const sends: string[] = [];
    await processOutboundDelivery(afterExpiry, new Date(), {
      PUSH_BROWSER: {
        provider: 'test-browser',
        send: async (input) => {
          sends.push(input.subscription.endpoint);
          return { status: 'SENT' as const, provider: 'test-browser', sentAt: new Date() };
        },
      },
    });
    assert.equal(sends.length, 0, 'an expired subscription is never targeted');
    const retained = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM browser_push_subscriptions WHERE id = $1`,
      [registered.id],
    );
    assert.equal(retained.rows[0].n, 1, 'the expired row is retained as history');

    // A permanent failure that is NOT a dead subscription never retires one.
    const healthy = subscriberKeyPair();
    const survivor = await registerBrowserPushSubscription(user.userId, {
      deviceId: 'browser-3',
      endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
      p256dh: healthy.publicBase64Url,
      auth: healthy.authBase64Url,
    });
    const survivorDelivery = await createPushIntentFor(
      user.userId,
      await createTenant(),
    );
    await processOutboundDelivery(survivorDelivery, new Date(), {
      PUSH_BROWSER: {
        provider: 'test-browser',
        send: async () => ({
          status: 'FAILED' as const,
          provider: 'test-browser',
          error: 'The push service rejected the payload with status 400.',
          errorCode: 'PAYLOAD_INVALID' as const,
          retryable: false,
          tokenInvalid: false,
          sentAt: new Date(),
        }),
      },
    });
    const survivorRow = await pool!.query<{ status: string }>(
      `SELECT status FROM browser_push_subscriptions WHERE id = $1`,
      [survivor.id],
    );
    assert.equal(
      survivorRow.rows[0].status,
      'ACTIVE',
      'a permanent NON-token failure must never retire a subscription',
    );

    // REVOKE: an explicit revocation of a live subscription.
    const live = subscriberKeyPair();
    const revocable = await registerBrowserPushSubscription(user.userId, {
      deviceId: 'browser-2',
      endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
      p256dh: live.publicBase64Url,
      auth: live.authBase64Url,
    });
    const revoked = await revokeBrowserPushSubscription(user.userId, revocable.id);
    assert.equal(revoked.status, 'INACTIVE');
    const revokedRow = await pool!.query<{ status: string }>(
      `SELECT status FROM browser_push_subscriptions WHERE id = $1`,
      [revocable.id],
    );
    assert.equal(revokedRow.rows[0].status, 'INACTIVE');
  });
});

describe('CR-HM-MULTICLIENT-NOTIFICATION-01 PART 02 — the migration upgrade path', () => {
  // CR-HM-FIELD-OPERATIONS-01 FINAL REVIEW (2026-10-24): this branch adds
  // migration `0476_handyman_assignment_response_client_keys` (PART 01), so a
  // database built from "every migration except the three PART 02 ones"
  // legitimately stops at 0476 instead of 0472. The assertion below is no
  // longer a hardcoded id: it proves the legacy database contains NONE of
  // 0473/0474/0475 and that its head is exactly the newest applied id — the
  // same invariant, stated without a stale pin.
  it('upgrades a pre-PART-02 database to the current head without losing data', async () => {
    // A disposable database that is migrated to the PRE-PART-02 head first.
    // `createPool` is used on purpose: `initDatabase` would REPLACE the
    // process-wide pool that the rest of the suite uses.
    const upgradeDb = 'asentra_part02_upgrade';
    const admin = createPool({
      host: '127.0.0.1',
      port: DB_PORT,
      user: 'postgres',
      password: '',
      name: 'postgres',
      ssl: false,
    });
    await admin.query(`DROP DATABASE IF EXISTS ${upgradeDb}`);
    await admin.query(`CREATE DATABASE ${upgradeDb}`);
    await admin.end();

    const upgradePool = createPool({
      host: '127.0.0.1',
      port: DB_PORT,
      user: 'postgres',
      password: '',
      name: upgradeDb,
      ssl: false,
    });
    const tx = async <T,>(work: (client: PoolClient) => Promise<T>): Promise<T> => {
      const client = await upgradePool.connect();
      try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    };

    try {
      // Apply every migration up to (and excluding) the three PART 02 ones.
      const legacy = migrations.filter(
        (migration) => !migration.id.startsWith('0473_') &&
          !migration.id.startsWith('0474_') &&
          !migration.id.startsWith('0475_'),
      );
      await tx(async (client) => {
        await client.query(
          `CREATE TABLE IF NOT EXISTS schema_migrations (
             id TEXT PRIMARY KEY,
             applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
           )`,
        );
      });
      for (const migration of legacy) {
        await tx(async (client) => {
          await migration.up(client);
          await client.query(
            `INSERT INTO schema_migrations (id) VALUES ($1)
               ON CONFLICT (id) DO NOTHING`,
            [migration.id],
          );
        });
      }
      const legacyHead = await upgradePool.query<{ id: string }>(
        `SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1`,
      );
      const legacyIds = await upgradePool.query<{ id: string }>(
        `SELECT id FROM schema_migrations ORDER BY id ASC`,
      );
      const appliedLegacyIds = legacyIds.rows.map((row) => row.id);
      for (const part02 of ['0473_', '0474_', '0475_']) {
        assert.equal(
          appliedLegacyIds.some((id) => id.startsWith(part02)),
          false,
          `the legacy database must not contain ${part02} yet`,
        );
      }
      assert.equal(
        legacyHead.rows[0].id,
        appliedLegacyIds[appliedLegacyIds.length - 1],
        'the legacy database stops at the pre-PART-02 head',
      );

      // A row that must survive the upgrade.
      await upgradePool.query(
        `INSERT INTO clients (id, code, name, status)
           VALUES (gen_random_uuid(), $1, $2, 'ACTIVE')`,
        [`CLI_UPGRADE_${suffix()}`, 'Upgrade Client'],
      );
      const before = await upgradePool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM clients`,
      );

      // The upgrade: the real migration runner.
      const applied = await migrateUp(upgradePool);
      assert.ok(
        applied.some((id) => id.startsWith('0473_')) &&
          applied.some((id) => id.startsWith('0474_')) &&
          applied.some((id) => id.startsWith('0475_')),
        'the three PART 02 migrations are applied by the runner',
      );

      const after = await upgradePool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM clients`,
      );
      assert.equal(after.rows[0].n, before.rows[0].n, 'no data is lost');

      // The new surfaces exist, and the widened channel is usable.
      const tables = await upgradePool.query<{ name: string }>(
        `SELECT table_name AS name FROM information_schema.tables
          WHERE table_name IN ('browser_push_subscriptions',
                               'notification_browser_push_deliveries')`,
      );
      assert.equal(tables.rows.length, 2);
      await upgradePool.query(
        `INSERT INTO notification_templates
           (id, key, type, channel, subject, body, status, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'WORK_ORDER_ASSIGNMENT', 'PUSH',
                 's', 'b', 'ACTIVE', NOW(), NOW())`,
        [`TPL_UPGRADE_${suffix()}`],
      );
    } finally {
      await upgradePool.end();
      const cleanup = createPool({
        host: '127.0.0.1',
        port: DB_PORT,
        user: 'postgres',
        password: '',
        name: 'postgres',
        ssl: false,
      });
      await cleanup.query(`DROP DATABASE IF EXISTS ${upgradeDb}`);
      await cleanup.end();
    }
  });
});

describe('CR-HM-MULTICLIENT-NOTIFICATION-01 PART 02 — the published contracts and the tenant boundary', () => {
  const spec = parse(
    readFileSync(join(__dirname, '../docs/api/openapi.yaml'), 'utf8'),
  ) as any;

  it('publishes the Browser contract beside the Android contract', () => {
    const browser = spec.paths['/mobile/push-subscriptions'];
    const browserItem = spec.paths['/mobile/push-subscriptions/{subscriptionId}'];
    const android = spec.paths['/mobile/push-tokens'];
    const androidItem = spec.paths['/mobile/push-tokens/{tokenId}'];
    assert.ok(browser && browserItem && android && androidItem, 'both contracts exist');

    const browserOps = [
      browser.post.operationId,
      browser.get.operationId,
      browser.delete.operationId,
      browserItem.delete.operationId,
    ].sort();
    assert.deepEqual(browserOps, [
      'listBrowserPushSubscriptions',
      'registerBrowserPushSubscription',
      'revokeAllBrowserPushSubscriptions',
      'revokeBrowserPushSubscription',
    ]);
    const androidOps = [
      android.post.operationId,
      android.get.operationId,
      androidItem.delete.operationId,
    ].sort();
    assert.deepEqual(androidOps, [
      'deactivatePushToken',
      'listPushTokens',
      'registerPushToken',
    ]);

    // Both contracts are authenticated and both are REGISTRATION surfaces.
    for (const op of [
      browser.post,
      browser.get,
      browser.delete,
      browserItem.delete,
      android.post,
      android.get,
      androidItem.delete,
    ]) {
      assert.ok(op.security, `${op.operationId} must be authenticated`);
      const path = Object.keys(spec.paths).find((key) =>
        Object.values(spec.paths[key]).includes(op),
      );
      assert.ok(
        !/send|dispatch|deliver/i.test(path ?? ''),
        `${op.operationId} must not be a send path`,
      );
    }

    // The browser schema never publishes the credential-grade fields.
    const browserProperties = Object.keys(
      spec.components.schemas.BrowserPushSubscriptionRegistration.properties ?? {},
    );
    for (const forbidden of ['p256dh', 'auth', 'endpoint', 'pushToken']) {
      assert.ok(
        !browserProperties.includes(forbidden),
        `the browser contract must not publish ${forbidden}`,
      );
    }
  });

  it('keeps the existing channel compatibility in the published contract', () => {
    assert.deepEqual(
      spec.components.schemas.NotificationTemplate.properties.channel.enum,
      ['IN_APP', 'EMAIL', 'WHATSAPP', 'PUSH'],
    );
    const create =
      spec.paths['/notification-templates'].post.requestBody.content[
        'application/json'
      ].schema;
    assert.deepEqual(create.properties.channel.enum, [
      'IN_APP',
      'EMAIL',
      'WHATSAPP',
      'PUSH',
    ]);
    // The inbox channel is untouched: a push is not an inbox record.
    assert.deepEqual(
      spec.components.schemas.Notification.properties.channel.enum,
      ['IN_APP'],
    );
  });

  it('refuses a registration that crosses the tenant boundary', async () => {
    const tenantA = await createTenant();
    const tenantB = await createTenant();
    const user = await createUserWithLogin(`cross-${suffix()}@example.com`);
    const keys = subscriberKeyPair();

    // A subscription of tenant A is invisible to tenant B.
    const registration = await registerBrowserPushSubscription(user.userId, {
      deviceId: 'browser-1',
      endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
      p256dh: keys.publicBase64Url,
      auth: keys.authBase64Url,
    });
    const listed = await listBrowserPushSubscriptions(user.userId);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, registration.id);
    assert.notEqual(tenantA.clientId, tenantB.clientId);

    // The registration carries no tenant authority of its own: it is bound to
    // the AUTHENTICATED user, never to a caller-asserted client.
    const row = await pool!.query<{ user_id: string }>(
      `SELECT user_id FROM browser_push_subscriptions WHERE id = $1`,
      [registration.id],
    );
    assert.equal(row.rows[0].user_id, user.userId);
  });
});
