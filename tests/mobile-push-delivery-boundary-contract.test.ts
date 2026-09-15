import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { api } from './helpers/http';
import { PUSH_PLATFORMS } from '../src/modules/push-tokens/push-token.types';
import { NOTIFICATION_CHANNELS } from '../src/modules/notifications/notification.types';
import { NOTIFICATION_HISTORY_CHANNELS } from '../src/modules/notification-history/notification-history.types';

/**
 * CR-BE-MOB-01 PART 07 — push delivery boundary (BE-26 channel).
 *
 * BE-26 delivers IN_APP / EMAIL / WHATSAPP. It does NOT deliver push: there is
 * no push delivery attempt record, no adapter, no provider integration and no
 * token fan-out. PART 07 publishes nothing new; these guards keep the four
 * stages separated and stop a future change from advertising push delivery
 * that does not exist:
 *
 *  1. token registration    — EXISTING, and must not imply delivery;
 *  2. notification creation — EXISTING, IN_APP records only;
 *  3. delivery attempt      — documented channels == implemented channels,
 *                             PUSH absent;
 *  4. provider delivery     — no adapter / vendor / send route may appear.
 */

const SPEC_PATH = resolve(__dirname, '../docs/api/openapi.yaml');
const MODULES_DIR = resolve(__dirname, '../src/modules');
const MIGRATIONS_DIR = resolve(__dirname, '../src/database/migrations');
const API_PREFIX = '/api/v1';

const spec = parse(readFileSync(SPEC_PATH, 'utf8')) as any;
const tokenOp = spec.paths['/mobile/push-tokens'].post;
const historyOp = spec.paths['/notification-history'].get;

function readSource(relative: string): string {
  return readFileSync(resolve(__dirname, '..', relative), 'utf8');
}

function allRoutes(): string[] {
  const routes: string[] = [];
  const pattern = /\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  function walk(dir: string): void {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!name.endsWith('.routes.ts')) continue;
      const source = readFileSync(full, 'utf8');
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(source)) !== null) {
        routes.push(`${match[1].toUpperCase()} ${match[2]}`);
      }
    }
  }
  walk(MODULES_DIR);
  return routes;
}

function publishedOperationIds(): Set<string> {
  const ids = new Set<string>();
  for (const item of Object.values<any>(spec.paths ?? {})) {
    for (const [method, op] of Object.entries<any>(item)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      if (op?.operationId) ids.add(op.operationId);
    }
  }
  return ids;
}

describe('CR-BE-MOB-01 PART 07 — the four delivery stages stay separated', () => {
  const lifecycle = tokenOp['x-push-delivery-lifecycle'];

  it('documents all four stages in order with an explicit status', () => {
    assert.ok(Array.isArray(lifecycle), 'lifecycle metadata required');
    assert.deepEqual(
      lifecycle.map((s: any) => [s.stage, s.name]),
      [
        [1, 'TOKEN_REGISTRATION'],
        [2, 'NOTIFICATION_CREATION'],
        [3, 'DELIVERY_ATTEMPT'],
        [4, 'PROVIDER_DELIVERY'],
      ],
    );
    const published = publishedOperationIds();
    for (const stage of lifecycle) {
      assert.ok(
        ['EXISTING', 'PARTIAL', 'MISSING'].includes(stage.status),
        `${stage.name} needs an explicit status`,
      );
      assert.ok(
        typeof stage.notes === 'string' && stage.notes.length > 30,
        `${stage.name} needs documented notes`,
      );
      for (const operationId of stage.operationIds ?? []) {
        assert.ok(
          published.has(operationId),
          `${stage.name} references unpublished ${operationId}`,
        );
      }
    }
  });

  const publishedPushOperationIds = (): string[] => {
    const ids: string[] = [];
    for (const [path, item] of Object.entries<any>(spec.paths)) {
      if (!/push/i.test(path)) continue;
      for (const [method, op] of Object.entries<any>(item)) {
        if (['get', 'post', 'put', 'patch', 'delete'].includes(method) && op?.operationId) {
          ids.push(op.operationId);
        }
      }
    }
    return ids;
  };

  it('describes the push delivery stages truthfully and exposes no push operation', () => {
    // CR-BE-PUSH-01 PART 05 — B-01a/B-01b rewritten, NOT weakened.
    //
    // As written for CR-BE-MOB-01 PART 07 these assertions demanded that push
    // delivery NOT EXIST (stage 3 PARTIAL/missing PUSH, stage 4 MISSING).
    // PART 03/04 built a governed push delivery path, so the old form now
    // asserts a falsehood and the spec must say so. What the guard protects
    // is unchanged and re-expressed below: the capability may exist, but it
    // must remain unreachable from the published API, and the spec must never
    // claim a channel it does not actually implement.
    const attempt = lifecycle.find((s: any) => s.name === 'DELIVERY_ATTEMPT');
    const provider = lifecycle.find((s: any) => s.name === 'PROVIDER_DELIVERY');

    // The attempt stage must enumerate exactly the channels that really
    // persist attempt evidence — the history channels plus PUSH.
    assert.deepEqual(attempt.implementedChannels, [
      ...NOTIFICATION_HISTORY_CHANNELS,
      'PUSH',
    ]);
    assert.deepEqual(attempt.missingChannels, []);

    // The permanent half of the guard: no push send/test/resend operation may
    // ever be published, so the provider stage exposes NO operationId.
    assert.deepEqual(
      provider.operationIds,
      [],
      'no published operation may trigger a push',
    );
    // …and every operationId the whole spec publishes for push is read-only
    // registration management.
    assert.deepEqual(publishedPushOperationIds().sort(), [
      'deactivatePushToken',
      'listPushTokens',
      'registerPushToken',
    ]);
  });

  it('never presents provider acceptance as device delivery', () => {
    // Permanent guard: the backend cannot observe display/read, so neither
    // the lifecycle notes nor the failure behaviour may imply that it can.
    const provider = lifecycle.find((s: any) => s.name === 'PROVIDER_DELIVERY');
    const prose = `${provider.notes} ${tokenOp['x-push-delivery-failure-behavior']}`;
    assert.match(
      prose,
      /acceptance is not delivery|NOT proof|not proof/i,
      'the contract must state that provider acceptance is not device delivery',
    );
    assert.ok(
      !/\bdelivered to the device\b|\bconfirms? (?:device )?(?:receipt|display)\b/i.test(prose),
      'the contract must not claim device-level delivery confirmation',
    );
  });

  it('documents the delivery failure behaviour', () => {
    const behavior = String(tokenOp['x-push-delivery-failure-behavior']);
    assert.match(behavior, /FAILED/);
    assert.match(behavior, /failureReason/);
    assert.match(behavior, /never fabricate|never silently dropped|never retried/i);
  });

  it('keeps token registration from implying delivery', () => {
    assert.match(
      String(tokenOp.description),
      /registration is NOT delivery/i,
      'the registration contract must state it does not deliver',
    );
    // The registration payload/response must carry no delivery outcome.
    const registration = spec.components.schemas.PushTokenRegistration.properties;
    for (const forbidden of [
      'delivered',
      'deliveredAt',
      'deliveryStatus',
      'sentAt',
      'lastNotificationAt',
      'provider',
    ]) {
      assert.ok(
        !(forbidden in registration),
        `PushTokenRegistration must not expose ${forbidden}`,
      );
    }
  });
});

describe('CR-BE-MOB-01 PART 07 — documented channels equal implemented channels', () => {
  it('publishes exactly the implemented notification-record channel', () => {
    assert.deepEqual([...NOTIFICATION_CHANNELS], ['IN_APP']);
    assert.deepEqual(
      spec.components.schemas.Notification.properties.channel.enum,
      [...NOTIFICATION_CHANNELS],
    );
  });

  it('publishes exactly the implemented history channels in every place', () => {
    assert.deepEqual([...NOTIFICATION_HISTORY_CHANNELS], [
      'IN_APP',
      'EMAIL',
      'WHATSAPP',
    ]);
    const expected = [...NOTIFICATION_HISTORY_CHANNELS];
    assert.deepEqual(
      spec.components.schemas.NotificationHistoryItem.properties.channel.enum,
      expected,
    );
    const listChannel = historyOp.parameters.find(
      (p: any) => p.name === 'channel',
    );
    assert.deepEqual(listChannel.schema.enum, expected);
    const itemChannel = spec.paths[
      '/notification-history/{channel}/{historyId}'
    ].get.parameters.find((p: any) => p.name === 'channel');
    assert.deepEqual(itemChannel.schema.enum, expected);
    assert.deepEqual(historyOp['x-delivery-channels-implemented'], expected);
    assert.deepEqual(historyOp['x-delivery-channels-missing'], ['PUSH']);
  });

  it('never advertises PUSH as a deliverable channel', () => {
    for (const values of [
      spec.components.schemas.Notification.properties.channel.enum,
      spec.components.schemas.NotificationHistoryItem.properties.channel.enum,
      historyOp.parameters.find((p: any) => p.name === 'channel').schema.enum,
      historyOp['x-delivery-channels-implemented'],
    ]) {
      assert.ok(
        !values.includes('PUSH'),
        'PUSH must not be advertised until a push delivery attempt exists',
      );
    }
  });

  it('publishes exactly the implemented push platforms', () => {
    assert.deepEqual(
      spec.components.schemas.PushTokenRegistration.properties.platform.enum,
      [...PUSH_PLATFORMS],
    );
  });
});

describe('CR-BE-MOB-01 PART 07 — no push engine, provider or table was created', () => {
  it('registers no push send / delivery route', () => {
    const pushRoutes = allRoutes().filter((route) => /push/i.test(route));
    assert.deepEqual(
      pushRoutes.sort(),
      [
        'DELETE /mobile/push-tokens/:tokenId',
        'GET /mobile/push-tokens',
        'POST /mobile/push-tokens',
      ],
      'only BE-25L token registration routes may exist',
    );
    const documentedPushPaths = Object.keys(spec.paths).filter((p: string) =>
      /push/i.test(p),
    );
    assert.deepEqual(documentedPushPaths.sort(), [
      '/mobile/push-tokens',
      '/mobile/push-tokens/{tokenId}',
    ]);
  });

  it('keeps push provider code inside the one governed module', () => {
    // CR-BE-PUSH-01 PART 02 retires the "no push-delivery module" form of this
    // assertion: the governed provider abstraction lives at
    // `src/modules/push-delivery/`. The guard is not weakened — a SECOND push
    // engine (a parallel module, a queue, a notification fork) still fails
    // here, and the module below is still forbidden from owning routes,
    // migrations or a delivery pipeline (asserted elsewhere in this file).
    assert.ok(
      existsSync(join(MODULES_DIR, 'push-delivery')),
      'the governed provider module src/modules/push-delivery must exist',
    );
    for (const moduleName of ['mobile-push-delivery', 'push-notifications']) {
      assert.ok(
        !existsSync(join(MODULES_DIR, moduleName)),
        `parallel push module ${moduleName} must not exist`,
      );
    }
    // The provider module is an ADAPTER, not a pipeline: no route file, no
    // repository, no database access, no scheduler/worker.
    const providerFiles = readdirSync(join(MODULES_DIR, 'push-delivery'));
    for (const name of providerFiles) {
      assert.ok(
        !/\.(routes|controller|repository)\.ts$/.test(name),
        `push-delivery must not own ${name} — PART 02 is an adapter seam only`,
      );
    }
    for (const name of providerFiles) {
      const source = readFileSync(join(MODULES_DIR, 'push-delivery', name), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      assert.ok(
        !/\b(getPool|withTransaction|query\s*\(|PoolClient)\b/.test(source),
        `${name} must not access the database — the adapter is side-effect free`,
      );
      assert.ok(
        !/mobile_push_tokens|invalidatePushToken|notification_outbound_deliveries/.test(
          source,
        ),
        `${name} must not touch token or ledger state (PART 03/04 own that)`,
      );
      assert.ok(
        !/setInterval|nextRetryAt|next_retry_at|scheduleRetry|attemptCount|backoff/i.test(
          source,
        ),
        `${name} must not schedule retries or run a worker (PART 04 owns that)`,
      );
    }
  });

  it('adds no push delivery migration', () => {
    // CR-BE-PUSH-01 PART 01 retires the "0235 only" form of this assertion:
    // `0334` additively extends the SAME BE-25L device table with internal
    // delivery-readiness evidence and the INVALID lifecycle state. The guard
    // is not weakened — the allow-list is exact, so a push DELIVERY table
    // (per-device attempt history, a queue, a provider log) still fails here
    // until the PART that governs it lands and names it.
    // CR-BE-PUSH-01 PART 03A adds `0335`, which ONLY replaces the outbound
    // ledger's channel CHECK so PUSH is an admissible channel value.
    // PART 03C adds `0336`, the per-device attempt-evidence table reserved in
    // §12.7 — the very table earlier PARTs held back until the PART that
    // governs persistence landed. Per B-01h, PART 03 sets the FINAL push
    // migration list, so this is the complete and closed set: the allow-list
    // stays exact and stays a list (not a count), so any further push
    // migration fails here until governance names it.
    const pushMigrations = readdirSync(MIGRATIONS_DIR).filter((f) =>
      /push/i.test(f),
    );
    assert.deepEqual(
      pushMigrations.sort(),
      [
        '0235_create_mobile_push_tokens.ts',
        '0334_extend_mobile_push_tokens_for_delivery.ts',
        '0335_widen_outbound_delivery_channels_for_push.ts',
        '0336_create_notification_push_deliveries.ts',
      ],
      'only the BE-25L token table, its PART 01 extension, the PART 03A channel widening and the PART 03C evidence table may exist',
    );
    // The extension must remain additive: it may not create a table.
    const extension = readSource(
      'src/database/migrations/0334_extend_mobile_push_tokens_for_delivery.ts',
    );
    assert.ok(
      !/CREATE\s+TABLE/i.test(extension),
      'the PART 01 migration must extend mobile_push_tokens, not create a table',
    );
    // PART 03A is a CHECK replacement and nothing else: no table, no column,
    // no index, and above all no per-device attempt storage.
    const widening = readSource(
      'src/database/migrations/0335_widen_outbound_delivery_channels_for_push.ts',
    );
    assert.ok(
      !/CREATE\s+(TABLE|INDEX)|ADD\s+COLUMN/i.test(widening),
      'the PART 03A migration must only replace the channel CHECK',
    );
    assert.ok(
      !/notification_push_deliveries|push_token_id/i.test(widening),
      'per-device push delivery storage belongs to 0336, not the 03A widening',
    );
    // The PART 03C evidence table stores per-device ATTEMPT facts only. It
    // must never carry a token VALUE: §12.7 freezes the reference as a
    // push_token_id FK, so a leaked device token cannot be reconstructed from
    // the delivery audit trail.
    const evidence = readSource(
      'src/database/migrations/0336_create_notification_push_deliveries.ts',
    );
    assert.ok(
      /push_token_id/i.test(evidence),
      'attempt evidence must reference the device registration by id',
    );
    assert.ok(
      !/\b(token_value|device_token|token\s+text|token\s+varchar)\b/i.test(evidence),
      'attempt evidence must not persist a raw device token value',
    );
  });

  it('integrates no push vendor or provider SDK outside the governed module', () => {
    // CR-BE-PUSH-01 PART 02 narrows this ban rather than removing it: push
    // provider vocabulary may appear ONLY under `src/modules/push-delivery/`
    // (the single governed adapter seam). Everywhere else in the codebase the
    // original ban still holds byte-for-byte, so no other module may learn to
    // talk to a push provider or leak an SDK object.
    const banned = /(sendPush|deliverPush|pushAdapter|\bfcm\b|\bapns\b|firebase|onesignal|expo-notifications)/i;
    const PROVIDER_MODULE = join(MODULES_DIR, 'push-delivery');
    function walk(dir: string): void {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          if (full === PROVIDER_MODULE) continue;
          walk(full);
          continue;
        }
        if (!name.endsWith('.ts')) continue;
        const source = readFileSync(full, 'utf8');
        assert.ok(
          !banned.test(source),
          `${full} must not contain a push provider integration`,
        );
      }
    }
    walk(MODULES_DIR);
    // Even inside the governed module, only FCM may appear: no direct APNs
    // client, no OneSignal/Expo, and no browser Web Push / VAPID (§5.2, D-02).
    const forbiddenVendors =
      /(onesignal|expo-notifications|node-apn|@parse\/node-apn|web-push|vapid|applicationServerKey|apns-connect|http2\.connect)/i;
    for (const name of readdirSync(PROVIDER_MODULE)) {
      // Comments legitimately NAME the banned vendors (to record that they are
      // out of scope); only executable code is checked.
      const source = readFileSync(join(PROVIDER_MODULE, name), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      assert.ok(
        !forbiddenVendors.test(source),
        `${name} must use FCM only — no direct APNs, OneSignal, Expo or Web Push`,
      );
    }
    const pkg = JSON.parse(readSource('package.json'));
    const deps = Object.keys({
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    });
    for (const dep of deps) {
      assert.ok(
        !/firebase|fcm|apn|onesignal|expo/i.test(dep),
        `push vendor dependency ${dep} must not be added`,
      );
    }
  });

  it('keeps the token service free of any send path', () => {
    // Comments legitimately discuss delivery (to state that it does not
    // happen here); only executable code is checked.
    const service = readSource('src/modules/push-tokens/push-token.service.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    assert.ok(
      !/\b(send|deliver|notify|dispatch)[A-Za-z]*\s*\(/i.test(service),
      'the token module must only register/rotate/deactivate tokens',
    );
    assert.ok(
      !/push_deliveries|notification_deliveries/i.test(service),
      'the token module must not touch a delivery table',
    );
  });
});

describe('CR-BE-MOB-01 PART 07 — scope and access are documented as enforced', () => {
  it('documents the recipient/self scope the routes actually enforce', () => {
    assert.equal(tokenOp['x-recipient-scoped'], true);
    assert.equal(historyOp['x-recipient-scoped'], true);
    // These routes are authenticated and self-scoped by userId — they carry no
    // permission code, so the contract must not claim one.
    assert.equal(tokenOp['x-required-permission'], undefined);
    assert.equal(historyOp['x-required-permission'], undefined);
    const tokenRoutes = readSource('src/modules/push-tokens/push-token.routes.ts');
    const historyRoutes = readSource(
      'src/modules/notification-history/notification-history.routes.ts',
    );
    for (const source of [tokenRoutes, historyRoutes]) {
      assert.match(source, /authenticationMiddleware/);
      assert.ok(
        !/requirePermission/.test(source),
        'documented scope must match the router (no permission code here)',
      );
    }
  });

  it('rejects anonymous access to tokens and history', async () => {
    const request = api();
    const responses = [
      await request.get(`${API_PREFIX}/mobile/push-tokens`),
      await request
        .post(`${API_PREFIX}/mobile/push-tokens`)
        .send({ deviceId: 'd', pushToken: 't', platform: 'ANDROID' }),
      await request.get(`${API_PREFIX}/notification-history`),
      await request.get(`${API_PREFIX}/notifications`),
    ];
    for (const response of responses) {
      assert.equal(response.status, 401);
      assert.equal(response.body.error.code, 'AUTHENTICATION_REQUIRED');
    }
  });
});
