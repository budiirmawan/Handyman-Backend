import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { FOUNDATION_PERMISSIONS } from '../src/database/seeds/foundation-access.seed';
import { MOBILE_QR_TARGET_TYPES } from '../src/modules/mobile-qr-resolution/mobile-qr.types';
import { MOBILE_SYNC_RESOURCE_TYPES } from '../src/modules/mobile-sync/mobile-sync.types';
import { NOTIFICATION_HISTORY_CHANNELS } from '../src/modules/notification-history/notification-history.types';

/**
 * CR-BE-MOB-01 PART 08 — cross-contract regression.
 *
 * One suite that re-validates PART 01–07 TOGETHER, so a later change cannot
 * break one PART's guarantee while the others still pass. It asserts the
 * exact confirmations the CR must be able to make at handoff:
 *
 *   PART 01–04  the published domain surfaces exist, are registered, and are
 *               scoped + permission-tagged with REAL seeded permission codes;
 *   PART 04     the Work Order material/verification composition is intact;
 *   PART 05     QR stays ASSET-only;
 *   PART 06     sync kinds are explicit and unsupported records stay local;
 *   PART 07     token registration is not delivery; push provider is MISSING;
 *   all         authoritative ids only, no fabricated capability.
 */

const SPEC_PATH = resolve(__dirname, '../docs/api/openapi.yaml');
const MODULES_DIR = resolve(__dirname, '../src/modules');
const ROUTES_DIR = resolve(__dirname, '../src/routes');

const spec = parse(readFileSync(SPEC_PATH, 'utf8')) as any;

/**
 * The tags CR-BE-MOB-01 PART 01–04 published, with their frozen size.
 *
 * CR-BE-MOB-02 PART 07B publishes 5 existing Security Shift Handover
 * operations (BE-12G binding CRUD + BE-12M reporting dataset) under the
 * existing `Security` tag, so the Security size is reconciled 41 → 46.
 *
 * CR-BE-MOB-03 PART 02 publishes 28 existing Housekeeping supervisor
 * supporting operations (BE-11J consumable requirements/readiness, BE-16J
 * consumable bindings, BE-11L complaint bindings, BE-11M report datasets)
 * under the existing `Housekeeping` tag, so the Housekeeping size is
 * reconciled 34 → 62.
 *
 * CR-BE-MOB-03 PART 03 publishes 8 existing BE-10I engineering report
 * datasets under the existing `Engineering` tag, so the Engineering size is
 * reconciled 54 → 62. (The 6 BE-21J corrective-action verification
 * operations are published under a new `Corrective Action Verification`
 * tag, which this guard does not pin.) Inventory Master size is unchanged.
 */
const PUBLISHED_TAGS: Record<string, number> = {
  Housekeeping: 62,
  Security: 46,
  Engineering: 62,
  'Inventory Master': 8,
};

type Operation = { path: string; method: string; op: any };

function operations(): Operation[] {
  const out: Operation[] = [];
  for (const [path, item] of Object.entries<any>(spec.paths ?? {})) {
    for (const [method, op] of Object.entries<any>(item)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      out.push({ path, method, op });
    }
  }
  return out;
}

function taggedOperations(tag: string): Operation[] {
  return operations().filter(({ op }) => (op.tags ?? []).includes(tag));
}

function normalize(path: string): string {
  return path.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':p').replace(/\{[^}]+\}/g, ':p');
}

function registeredRoutes(): Set<string> {
  const set = new Set<string>();
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
        set.add(`${match[1].toUpperCase()} ${normalize(match[2])}`);
      }
    }
  }
  walk(MODULES_DIR);
  walk(ROUTES_DIR);
  return set;
}

const SEEDED_PERMISSIONS = new Set(
  FOUNDATION_PERMISSIONS.map((permission) => permission.code),
);

describe('CR-BE-MOB-01 PART 08 — PART 01–04 published surfaces', () => {
  it('publishes each domain tag at its frozen size', () => {
    for (const [tag, expected] of Object.entries(PUBLISHED_TAGS)) {
      assert.ok(
        (spec.tags ?? []).some((t: { name: string }) => t.name === tag),
        `tag ${tag} must exist`,
      );
      assert.equal(
        taggedOperations(tag).length,
        expected,
        `${tag} must publish ${expected} operations`,
      );
    }
  });

  it('documents only operations the router actually registers', () => {
    const registered = registeredRoutes();
    const phantom: string[] = [];
    for (const tag of Object.keys(PUBLISHED_TAGS)) {
      for (const { path, method } of taggedOperations(tag)) {
        const key = `${method.toUpperCase()} ${normalize(path)}`;
        if (!registered.has(key)) phantom.push(`${tag}: ${key}`);
      }
    }
    assert.deepEqual(phantom, [], 'no invented endpoint may be published');
  });

  it('preserves tenant/Building scope on every published operation', () => {
    const unscoped: string[] = [];
    for (const tag of Object.keys(PUBLISHED_TAGS)) {
      for (const { path, method, op } of taggedOperations(tag)) {
        if (op['x-building-scoped'] !== true) {
          unscoped.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }
    assert.deepEqual(unscoped, []);
  });

  it('preserves RBAC with REAL seeded permission codes', () => {
    const unknown: string[] = [];
    const missing: string[] = [];
    for (const tag of Object.keys(PUBLISHED_TAGS)) {
      for (const { path, method, op } of taggedOperations(tag)) {
        const code = op['x-required-permission'];
        if (!code) {
          missing.push(`${method.toUpperCase()} ${path}`);
          continue;
        }
        if (!SEEDED_PERMISSIONS.has(code)) {
          unknown.push(`${op.operationId} -> ${code}`);
        }
      }
    }
    assert.deepEqual(missing, [], 'every published operation records a permission');
    assert.deepEqual(
      unknown,
      [],
      'a documented permission must exist in the seeded permission catalogue',
    );
  });

  it('documents authentication and the standard failure responses', () => {
    const bad: string[] = [];
    for (const tag of Object.keys(PUBLISHED_TAGS)) {
      for (const { path, method, op } of taggedOperations(tag)) {
        const hasBearer = (op.security ?? []).some(
          (s: Record<string, unknown>) => 'bearerAuth' in s,
        );
        if (!hasBearer || !op.responses?.['401'] || !op.responses?.['403']) {
          bad.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }
    assert.deepEqual(bad, []);
  });
});

describe('CR-BE-MOB-01 PART 08 — cross-PART invariants hold together', () => {
  it('PART 04: the Work Order material + verification composition is intact', () => {
    const byId = new Map(
      operations().map(({ path, method, op }) => [
        op.operationId,
        `${method.toUpperCase()} ${path}`,
      ]),
    );
    for (const operationId of [
      'recordWorkOrderMaterialUsage',
      'listWorkOrderMaterialUsages',
      'getWorkOrderMaterialCostSummary',
      'listWarehouseStockBalances',
      'getMaterialRequest',
      'getWorkOrderVerification',
      'submitWorkOrderVerification',
      'listClientInventoryItems',
      'listBuildingWarehouses',
      'listAssetSpareParts',
    ]) {
      assert.ok(byId.has(operationId), `${operationId} must stay published`);
    }
    // The three quantity concepts must remain distinct.
    assert.ok(spec.components.schemas.AssetSparePart.properties.requiredQuantity);
    assert.ok(spec.components.schemas.MaterialRequest.properties.approvedQuantity);
    assert.ok(spec.components.schemas.WorkOrderMaterialUsage.properties.quantity);
  });

  it('PART 05: QR resolution remains ASSET-only', () => {
    assert.deepEqual([...MOBILE_QR_TARGET_TYPES], ['ASSET']);
    const qr = spec.paths['/mobile/qr/resolve/{identifier}'].get;
    assert.deepEqual(qr['x-qr-supported-target-types'], [...MOBILE_QR_TARGET_TYPES]);
    assert.deepEqual(
      spec.components.schemas.MobileQrResolution.properties.targetType.enum,
      [...MOBILE_QR_TARGET_TYPES],
    );
    for (const entry of qr['x-qr-target-type-boundary']) {
      assert.equal(entry.status, 'MISSING', `${entry.targetType} must stay MISSING`);
    }
  });

  it('PART 06: supported sync kinds are explicit and unsupported stay local', () => {
    const sync = spec.paths['/mobile/sync'].post;
    assert.deepEqual(
      spec.components.schemas.MobileSyncOperationItem.properties.resourceType.enum,
      [...MOBILE_SYNC_RESOURCE_TYPES],
    );
    assert.deepEqual(
      sync['x-sync-supported-resource-types'].map((e: any) => e.resourceType),
      [...MOBILE_SYNC_RESOURCE_TYPES],
    );
    for (const entry of sync['x-sync-unsupported-resource-types']) {
      assert.ok(
        !(MOBILE_SYNC_RESOURCE_TYPES as readonly string[]).includes(
          entry.resourceType,
        ),
        `${entry.resourceType} must remain non-syncable`,
      );
    }
  });

  it('PART 07: token registration is not delivery and push stays out of history', () => {
    const token = spec.paths['/mobile/push-tokens'].post;
    assert.match(String(token.description), /registration is NOT delivery/i);
    // CR-BE-PUSH-01 PART 05 — push delivery now exists server-side, so the
    // old "PROVIDER_DELIVERY MISSING" assertion was retired with the spec it
    // guarded (see mobile-push-delivery-boundary-contract). What still holds,
    // and is asserted here, is that registration never delivers and that push
    // is NOT a client-readable history channel.
    assert.ok(
      !NOTIFICATION_HISTORY_CHANNELS.includes('PUSH' as never),
      'PUSH must not be a client-readable notification history channel',
    );
    for (const forbidden of ['delivered', 'deliveryStatus', 'sentAt']) {
      assert.ok(
        !(forbidden in spec.components.schemas.PushTokenRegistration.properties),
        `PushTokenRegistration must not expose ${forbidden}`,
      );
    }
  });
});

describe('CR-BE-MOB-01 PART 08 — authoritative ids, no fabricated capability', () => {
  it('exposes no client-generated or temporary id in any published schema', () => {
    const banned = /^(localId|tempId|clientId_local|clientGeneratedId|offlineId|fakeId|mockId)$/;
    const offenders: string[] = [];
    for (const [name, schema] of Object.entries<any>(spec.components.schemas)) {
      for (const property of Object.keys(schema.properties ?? {})) {
        if (banned.test(property)) offenders.push(`${name}.${property}`);
      }
    }
    assert.deepEqual(offenders, []);
    // The one client-generated value in the contract is the sync operationId,
    // which is an idempotency key — never a resource id.
    const syncItem = spec.components.schemas.MobileSyncOperationItem.properties;
    assert.match(String(syncItem.operationId.description), /operation identifier/i);
    assert.match(String(syncItem.resourceId.description), /never client-generated/i);
  });

  it('adds no mobile-specific domain facade', () => {
    const facades = Object.keys(spec.paths).filter((p: string) =>
      /\/mobile\/(housekeeping|security|engineering|material|inventory|work-order|patrol|incident|push-send)/.test(
        p,
      ),
    );
    assert.deepEqual(facades, [], 'no mobile-specific domain API may exist');
  });

  it('keeps every documented operationId unique and resolvable', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const { op } of operations()) {
      if (!op.operationId) continue;
      if (seen.has(op.operationId)) duplicates.push(op.operationId);
      seen.add(op.operationId);
    }
    assert.deepEqual(duplicates, []);
    const known = new Set([
      ...Object.keys(spec.components.schemas ?? {}),
      ...Object.keys(spec.components.responses ?? {}),
      ...Object.keys(spec.components.parameters ?? {}),
    ]);
    const unresolved: string[] = [];
    (function walk(node: unknown): void {
      if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          if (key === '$ref') {
            const target = String(value).split('/').pop()!;
            if (!known.has(target)) unresolved.push(String(value));
          } else {
            walk(value);
          }
        }
      }
    })(spec);
    assert.deepEqual(unresolved, []);
  });
});
