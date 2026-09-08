import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { Pool } from 'pg';
import { initDatabase, migrateUp, closePool } from '../src/database';
import {
  listPushTokens,
  registerPushToken,
  deactivatePushToken,
  invalidatePushToken,
} from '../src/modules/push-tokens/push-token.service';
import { PUSH_TOKEN_STATUSES } from '../src/modules/push-tokens/push-token.types';
import { NOTIFICATION_HISTORY_CHANNELS } from '../src/modules/notification-history/notification-history.types';
import { userService } from '../src/modules/users';
import { ensureTestDatabase, skipIfNoTestDatabase } from './helpers/postgres';

/**
 * CR-BE-PUSH-01 PART 05 — mobile contract, OpenAPI truth & cross-module safety.
 *
 * PART 05 adds NO capability. It proves that what PARTs 01–04 built is
 * described truthfully to mobile clients and stays inside its boundary:
 *   - the public mobile surface is exactly the 3 BE-25L registration routes,
 *   - the public representation exposes no provider-internal evidence field,
 *   - every status the runtime can return is declared in OpenAPI (the PART 04A
 *     INVALID state is observable through the public GET, so the spec must say
 *     so — the fix is the spec, never hiding the value),
 *   - the raw device token stays out of operational events, error payloads and
 *     logs even though the frozen BE-25L response shape carries it,
 *   - a user reaches only their own registrations and a token is never auth,
 *   - the mobile surface stays provider-neutral,
 *   - EMAIL/WHATSAPP, history and the shared engines are untouched.
 */

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DB_NAME = process.env.DB_NAME ?? 'asentra_test';

const REPO_ROOT = process.cwd();
const readSource = (relative: string): string =>
  readFileSync(join(REPO_ROOT, relative), 'utf8');

/** Strips comments so a guard asserts on real code, not prose. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const spec: any = parse(readSource('docs/api/openapi.yaml'));

let pool: Pool | null = null;
let clientId = '';
let userId = '';
let otherUserId = '';

const q = (text: string, params: unknown[] = []) => {
  if (!pool) {
    throw new Error('database pool is not initialized');
  }
  return pool.query(text, params);
};

async function insertRow(
  table: string,
  values: Record<string, unknown>,
  rowId = randomUUID(),
): Promise<string> {
  const columns = Object.keys(values);
  const placeholders = columns.map((_, index) => `$${index + 2}`);
  await q(
    `INSERT INTO ${table} (id, ${columns.join(', ')})
     VALUES ($1, ${placeholders.join(', ')})`,
    [rowId, ...Object.values(values)],
  );
  return rowId;
}

/**
 * Device tokens are redacted by SHAPE, so privacy fixtures must look like real
 * provider tokens. A synthetic `tok-<uuid>` would prove nothing.
 */
function fcmShapedToken(): string {
  const instance = randomUUID().replace(/-/g, '').slice(0, 18);
  const body = `APA91b${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  return `${instance}:${body}`;
}

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE notification_push_deliveries, notification_outbound_deliveries,
              mobile_push_tokens, operational_events, users, clients CASCADE`,
  );
  clientId = await insertRow('clients', {
    code: 'PUSH05',
    name: 'Push 05 Client',
    status: 'ACTIVE',
  });
  userId = (
    await userService.createUser({
      email: `push05-${randomUUID().slice(0, 8).toLowerCase()}@example.com`,
      displayName: 'Mobile Contract User',
    })
  ).id;
  otherUserId = (
    await userService.createUser({
      email: `push05b-${randomUUID().slice(0, 8).toLowerCase()}@example.com`,
      displayName: 'Other User',
    })
  ).id;
});

beforeEach(async () => {
  if (!pool) {
    return;
  }
  await pool.query('TRUNCATE mobile_push_tokens, operational_events CASCADE');
});

after(async () => {
  if (pool) {
    await closePool(pool);
  }
  pool = null;
});

describe('CR-BE-PUSH-01 PART 05 — public status contract matches runtime', () => {
  it('returns INVALID through the public listing, so OpenAPI must declare it', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) return;

    const created = await registerPushToken(userId, {
      deviceId: `dev-${randomUUID()}`,
      pushToken: fcmShapedToken(),
      platform: 'ANDROID',
    });
    await invalidatePushToken(created.id, 'INVALID_TOKEN');

    const listed = await listPushTokens(userId);
    assert.equal(listed.length, 1, 'an invalidated row stays listable as history');
    assert.equal(
      listed[0].status,
      'INVALID',
      'PART 04A retires a rejected registration to INVALID and the GET shows it',
    );

    // The spec must not hide a runtime-observable value.
    const specEnum: string[] =
      spec.components.schemas.PushTokenRegistration.properties.status.enum;
    assert.ok(
      specEnum.includes('INVALID'),
      'OpenAPI must declare every status the public GET can return',
    );
  });

  it('declares exactly the runtime status vocabulary — no speculative value', () => {
    const specEnum: string[] = [
      ...spec.components.schemas.PushTokenRegistration.properties.status.enum,
    ];
    assert.deepEqual(
      specEnum.slice().sort(),
      [...PUSH_TOKEN_STATUSES].slice().sort(),
      'the documented status enum must equal the implemented one',
    );
  });

  it('never deletes a registration row when it is retired', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) return;

    const created = await registerPushToken(userId, {
      deviceId: `dev-${randomUUID()}`,
      pushToken: fcmShapedToken(),
      platform: 'IOS',
    });
    await invalidatePushToken(created.id, 'INVALID_TOKEN');
    const { rows } = await q('SELECT id, status FROM mobile_push_tokens WHERE id = $1', [
      created.id,
    ]);
    assert.equal(rows.length, 1, 'retirement is a status change, never a DELETE');
    assert.equal(rows[0].status, 'INVALID');
  });
});

describe('CR-BE-PUSH-01 PART 05 — public representation hides provider-internal state', () => {
  it('exposes no delivery evidence or provider field on a listed registration', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) return;

    const created = await registerPushToken(userId, {
      deviceId: `dev-${randomUUID()}`,
      pushToken: fcmShapedToken(),
      platform: 'ANDROID',
    });
    await invalidatePushToken(created.id, 'INVALID_TOKEN');
    const [listed] = await listPushTokens(userId);

    for (const forbidden of [
      'provider',
      'lastSuccessAt',
      'lastFailureAt',
      'consecutiveFailureCount',
      'invalidatedAt',
      'invalidationReason',
      'delivered',
      'deliveredAt',
      'deliveryStatus',
      'sentAt',
      'lastNotificationAt',
      'providerMessageId',
    ]) {
      assert.ok(
        !(forbidden in (listed as Record<string, unknown>)),
        `the public registration must not expose ${forbidden}`,
      );
    }

    // The internal row genuinely carries the evidence that stays hidden.
    const { rows } = await q(
      'SELECT invalidation_reason FROM mobile_push_tokens WHERE id = $1',
      [created.id],
    );
    assert.equal(rows[0].invalidation_reason, 'INVALID_TOKEN');
  });

  it('documents no provider-internal field in the published schema', () => {
    const props = Object.keys(
      spec.components.schemas.PushTokenRegistration.properties,
    );
    for (const forbidden of [
      'provider',
      'providerMessageId',
      'lastSuccessAt',
      'lastFailureAt',
      'consecutiveFailureCount',
      'invalidatedAt',
      'invalidationReason',
    ]) {
      assert.ok(
        !props.includes(forbidden),
        `PushTokenRegistration must not document ${forbidden}`,
      );
    }
  });

  it('keeps the documented schema and the runtime mapper in step', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) return;

    const created = await registerPushToken(userId, {
      deviceId: `dev-${randomUUID()}`,
      pushToken: fcmShapedToken(),
      platform: 'ANDROID',
      appVersion: '3.2.1',
      deviceModel: 'Pixel 8',
      deviceOsVersion: '14',
    });
    const documented = Object.keys(
      spec.components.schemas.PushTokenRegistration.properties,
    ).sort();
    assert.deepEqual(
      Object.keys(created).sort(),
      documented,
      'every runtime key must be documented and vice versa',
    );
    assert.equal(created.appVersion, '3.2.1');
    assert.equal(created.deviceModel, 'Pixel 8');
    assert.equal(created.deviceOsVersion, '14');
  });
});

describe('CR-BE-PUSH-01 PART 05 — raw device token privacy', () => {
  it('keeps the raw token out of operational events even when it is invalidated', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) return;

    const rawToken = fcmShapedToken();
    const created = await registerPushToken(userId, {
      deviceId: `dev-${randomUUID()}`,
      pushToken: rawToken,
      platform: 'ANDROID',
    });
    await invalidatePushToken(created.id, 'INVALID_TOKEN');

    const { rows } = await q('SELECT * FROM operational_events');
    const serialized = JSON.stringify(rows);
    assert.ok(
      !serialized.includes(rawToken),
      'no operational event may carry the raw device token',
    );
    // The token body must not leak in fragments either.
    assert.ok(
      !serialized.includes(rawToken.split(':')[1] ?? '@@none@@'),
      'no operational event may carry the token body',
    );
  });

  it('logs and fingerprints tokens instead of printing them', () => {
    const adapter = stripComments(readSource('src/modules/push-delivery/fcm-push-adapter.ts'));
    const fanout = stripComments(
      readSource('src/modules/notification-delivery/outbound-push-fanout.service.ts'),
    );
    // Any diagnostic that mentions a device token must go through the fingerprint.
    for (const [name, source] of [
      ['fcm-push-adapter', adapter],
      ['outbound-push-fanout', fanout],
    ] as const) {
      const loggedRaw = /logger\.(?:info|warn|error|debug)\([^)]*\b(?:input\.token|token\.pushToken)\b/.test(
        source,
      );
      assert.ok(!loggedRaw, `${name} must never log a raw device token`);
    }
    assert.match(
      adapter,
      /pushTokenFingerprint\(/,
      'the adapter must fingerprint tokens for diagnostics',
    );
  });

  it('is the frozen BE-25L contract that keeps pushToken in the response', () => {
    // Documented deliberately: the token is returned ONLY because the frozen
    // BE-25L response shape requires it, not because PUSH added it.
    const props = spec.components.schemas.PushTokenRegistration.properties;
    assert.ok('pushToken' in props, 'the frozen contract carries pushToken');
    const frozen = readSource('tests/push01-part01-device-registration-foundation.test.ts');
    assert.match(
      frozen,
      /'pushToken'/,
      'pushToken is a member of the frozen public key list',
    );
  });
});

describe('CR-BE-PUSH-01 PART 05 — ownership, isolation and no token-as-auth', () => {
  it('lists only the authenticated user’s own registrations', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) return;

    await registerPushToken(userId, {
      deviceId: `dev-${randomUUID()}`,
      pushToken: fcmShapedToken(),
      platform: 'ANDROID',
    });
    await registerPushToken(otherUserId, {
      deviceId: `dev-${randomUUID()}`,
      pushToken: fcmShapedToken(),
      platform: 'IOS',
    });

    const mine = await listPushTokens(userId);
    const theirs = await listPushTokens(otherUserId);
    assert.equal(mine.length, 1);
    assert.equal(theirs.length, 1);
    assert.equal(mine[0].userId, userId);
    assert.notEqual(mine[0].id, theirs[0].id);
  });

  it('refuses to deactivate another user’s registration', async (t) => {
    if (!(await skipIfNoTestDatabase(t))) return;

    const victim = await registerPushToken(otherUserId, {
      deviceId: `dev-${randomUUID()}`,
      pushToken: fcmShapedToken(),
      platform: 'ANDROID',
    });
    const result = await deactivatePushToken(userId, victim.id);
    assert.equal(result, null, 'a cross-user deactivation must not succeed');

    const { rows } = await q('SELECT status FROM mobile_push_tokens WHERE id = $1', [
      victim.id,
    ]);
    assert.equal(rows[0].status, 'ACTIVE', 'the victim row must be untouched');
  });

  it('derives the user from the session only — never from the request body', () => {
    const controller = stripComments(
      readSource('src/modules/push-tokens/push-token.controller.ts'),
    );
    assert.ok(
      !/req\.body\.userId|body\.userId|params\.userId|query\.userId/.test(controller),
      'the controller must never take a userId from client input',
    );
    assert.match(controller, /req\.auth/, 'the controller derives identity from the session');
  });

  it('never treats a push token as an authentication credential', () => {
    const authFiles = readdirSync(join(REPO_ROOT, 'src/modules/auth')).filter((f) =>
      f.endsWith('.ts'),
    );
    for (const file of authFiles) {
      const source = stripComments(readSource(join('src/modules/auth', file)));
      assert.ok(
        !/mobile_push_tokens|pushToken/.test(source),
        `${file} must not consult a push token for authentication`,
      );
    }
  });
});

describe('CR-BE-PUSH-01 PART 05 — the mobile surface stays provider-neutral', () => {
  it('leaks no provider vocabulary into the published push contract', () => {
    const pushPaths = Object.entries<any>(spec.paths).filter(([p]) => /push/i.test(p));
    assert.ok(pushPaths.length > 0, 'the push paths must exist');
    const raw = JSON.stringify(
      Object.fromEntries(pushPaths.concat([['schema', spec.components.schemas.PushTokenRegistration]])),
    );

    // One pre-existing BE-25L mention names the token FORMAT ("FCM/APNs style
    // opaque token") on the request field. That is a shape hint for the client,
    // not provider relay/credential/project detail, and it predates this CR, so
    // PART 05 leaves it alone rather than inventing a change. It is excluded
    // here explicitly — and asserted to be the ONLY such mention.
    const FORMAT_HINT = 'Provider push token (FCM/APNs style opaque token).';
    assert.equal(
      raw.split(FORMAT_HINT).length - 1,
      1,
      'the token format hint must appear exactly once',
    );
    const published = raw.split(FORMAT_HINT).join('');
    // Word-bounded: substrings of ordinary English (e.g. "exposed" contains
    // "expo") must not masquerade as a vendor leak.
    const vendorPatterns: [string, RegExp][] = [
      ['firebase', /\bfirebase\b/i],
      ['googleapis', /\bgoogleapis\b/i],
      ['onesignal', /\bone\s?signal\b/i],
      ['expo', /\bexpo\b|expo-notifications/i],
      ['apns', /\bapns\b/i],
      ['fcm', /\bfcm\b/i],
      ['service account', /\bservice account\b/i],
      ['ya29', /\bya29\b/i],
      ['oauth', /\boauth\b/i],
    ];
    for (const [vendor, pattern] of vendorPatterns) {
      assert.ok(
        !pattern.test(published),
        `the mobile push contract must not mention ${vendor}`,
      );
    }
  });

  it('exposes exactly the three BE-25L routes and no send path', () => {
    const routes = stripComments(readSource('src/modules/push-tokens/push-token.routes.ts'));
    const verbs = [...routes.matchAll(/router\.(get|post|put|patch|delete)\(/g)].map(
      (m) => m[1],
    );
    assert.deepEqual(
      verbs.sort(),
      ['delete', 'get', 'post'],
      'the push token router exposes exactly three routes',
    );
    assert.ok(
      !/send|test|resend|dispatch|broadcast/i.test(routes),
      'no send/test/resend route may exist on the mobile surface',
    );
    const documentedPushPaths = Object.keys(spec.paths).filter((p) => /push/i.test(p)).sort();
    assert.deepEqual(documentedPushPaths, [
      '/mobile/push-tokens',
      '/mobile/push-tokens/{tokenId}',
    ]);
  });
});

describe('CR-BE-PUSH-01 PART 05 — cross-module safety', () => {
  it('keeps PUSH out of the client-readable notification history channels', () => {
    assert.deepEqual(
      [...NOTIFICATION_HISTORY_CHANNELS],
      ['IN_APP', 'EMAIL', 'WHATSAPP'],
      'push evidence is internal; it is not a history channel',
    );
    const historyChannelEnum =
      spec.components.schemas.NotificationHistoryItem?.properties?.channel?.enum;
    if (historyChannelEnum) {
      assert.ok(
        !historyChannelEnum.includes('PUSH'),
        'the documented history channel enum must not advertise PUSH',
      );
    }
  });

  it('adds no migration — the governed sequence ends at 0336', () => {
    const migrations = readdirSync(join(REPO_ROOT, 'src/database/migrations'))
      .filter((f) => /^\d{4}_/.test(f))
      .map((f) => f.slice(0, 4));
    assert.ok(!migrations.includes('0337'), 'PART 05 introduces no migration');
    for (const expected of ['0334', '0335', '0336']) {
      assert.ok(migrations.includes(expected), `migration ${expected} must remain`);
    }
  });

  it('leaves the push token service free of any delivery path', () => {
    const service = stripComments(
      readSource('src/modules/push-tokens/push-token.service.ts'),
    );
    assert.ok(
      !/\b(send|deliver|notify|dispatch)[A-Za-z]*\s*\(/.test(service),
      'registration must never gain a delivery call',
    );
    assert.ok(
      !/push_deliveries|notification_deliveries/.test(service),
      'the token service must not read or write delivery tables',
    );
  });
});
