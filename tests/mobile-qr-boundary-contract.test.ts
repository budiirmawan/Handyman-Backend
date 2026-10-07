import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { api } from './helpers/http';

/**
 * CR-BE-MOB-01 PART 05 — QR operational-context boundary.
 *
 * PART 05 publishes NO new QR capability. Its whole job is to freeze the
 * payload convention and make it impossible to advertise a QR target type the
 * backend cannot resolve. These guards are therefore mostly negative:
 *
 *  - the documented supported target types equal the implemented
 *    MOBILE_QR_TARGET_TYPES constant (ASSET) — a new enum value in OpenAPI
 *    without backend support fails here;
 *  - the documented identifier types equal ASSET_IDENTIFIER_TYPES;
 *  - the identifier registry is asset-scoped in the router (no location /
 *    functional-location / checkpoint / work-order identifier or resolve
 *    route exists), so the MISSING classification is truthful;
 *  - every boundary entry is MISSING and points at canonical-id reads that
 *    really are published — no unsupported context is mapped onto ASSET;
 *  - resolution is never anonymous (auth + permission, 401 probes);
 *  - no GPS / geofence field appears anywhere in the QR contract.
 */

const SPEC_PATH = resolve(__dirname, '../docs/api/openapi.yaml');
const MODULES_DIR = resolve(__dirname, '../src/modules');
const API_PREFIX = '/api/v1';

const spec = parse(readFileSync(SPEC_PATH, 'utf8')) as any;

const MOBILE_QR_PATH = '/mobile/qr/resolve/{identifier}';
const ASSET_RESOLVE_PATH = '/assets/resolve/{identifier}';

function readSource(relative: string): string {
  return readFileSync(resolve(__dirname, '..', relative), 'utf8');
}

/** Extracts a `const X = ['A', 'B'] as const` string-literal array. */
function implementedConstant(source: string, name: string): string[] {
  const match = new RegExp(`${name}\\s*=\\s*\\[([^\\]]+)\\]`).exec(source);
  assert.ok(match, `constant ${name} not found in source`);
  return [...match[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
}

/** Every route registration in the backend, as "METHOD /path". */
function allRegisteredRoutes(): string[] {
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

function documentedOperationIds(): Set<string> {
  const ids = new Set<string>();
  for (const item of Object.values<any>(spec.paths ?? {})) {
    for (const [method, op] of Object.entries<any>(item)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      if (op?.operationId) ids.add(op.operationId);
    }
  }
  return ids;
}

describe('CR-BE-MOB-01 PART 05 — QR target types cannot outrun the backend', () => {
  const qrOp = spec.paths[MOBILE_QR_PATH]?.get;
  const assetOp = spec.paths[ASSET_RESOLVE_PATH]?.get;

  it('keeps both QR operations published and unchanged in shape', () => {
    assert.ok(qrOp, `${MOBILE_QR_PATH} must stay published`);
    assert.equal(qrOp.operationId, 'resolveMobileQr');
    assert.ok(assetOp, `${ASSET_RESOLVE_PATH} must stay published`);
    assert.equal(assetOp.operationId, 'resolveAssetByIdentifier');
    // The Asset QR response contract is preserved exactly.
    assert.equal(
      qrOp.responses['200'].content['application/json'].schema.allOf[1]
        .properties.data.$ref,
      '#/components/schemas/MobileQrResolution',
    );
    assert.equal(
      assetOp.responses['200'].content['application/json'].schema.allOf[1]
        .properties.data.$ref,
      '#/components/schemas/AssetResolution',
    );
  });

  it('advertises exactly the implemented MOBILE_QR_TARGET_TYPES', () => {
    const implemented = implementedConstant(
      readSource('src/modules/mobile-qr-resolution/mobile-qr.types.ts'),
      'MOBILE_QR_TARGET_TYPES',
    );
    assert.deepEqual(implemented, ['ASSET'], 'backend resolver changed');
    assert.deepEqual(
      qrOp['x-qr-supported-target-types'],
      implemented,
      'documented supported QR targets must equal the implemented constant',
    );
    assert.deepEqual(
      assetOp['x-qr-supported-target-types'],
      implemented,
      'the asset resolver must advertise the same single target',
    );
    assert.deepEqual(
      spec.components.schemas.MobileQrResolution.properties.targetType.enum,
      implemented,
      'MobileQrResolution.targetType must equal the implemented constant',
    );
  });

  it('advertises exactly the implemented ASSET_IDENTIFIER_TYPES', () => {
    const implemented = implementedConstant(
      readSource('src/modules/asset-identifiers/asset-identifier.types.ts'),
      'ASSET_IDENTIFIER_TYPES',
    );
    assert.deepEqual(
      spec.components.schemas.AssetIdentifierType.enum,
      implemented,
    );
    assert.deepEqual(
      spec.components.schemas.MobileQrResolution.properties.identifier
        .properties.identifierType.enum,
      implemented,
    );
  });

  it('documents every unsupported operational context as MISSING', () => {
    const boundary = qrOp['x-qr-target-type-boundary'];
    assert.ok(Array.isArray(boundary), 'boundary metadata required');
    assert.deepEqual(
      boundary.map((e: any) => e.targetType),
      ['LOCATION', 'FUNCTIONAL_LOCATION', 'CHECKPOINT', 'WORK_ORDER'],
    );
    const published = documentedOperationIds();
    const supported: string[] = qrOp['x-qr-supported-target-types'];
    for (const entry of boundary) {
      assert.equal(
        entry.status,
        'MISSING',
        `${entry.targetType} must be MISSING, never silently supported`,
      );
      assert.ok(entry.reason && entry.authority, `${entry.targetType} needs a documented reason + authority`);
      assert.ok(
        !supported.includes(entry.targetType),
        `${entry.targetType} must not appear in the supported list`,
      );
      assert.ok(
        Array.isArray(entry.canonicalIdReads) && entry.canonicalIdReads.length > 0,
        `${entry.targetType} must name an authoritative canonical-id fallback`,
      );
      for (const operationId of entry.canonicalIdReads) {
        assert.ok(
          published.has(operationId),
          `fallback ${operationId} for ${entry.targetType} is not published`,
        );
      }
    }
  });

  it('never maps an unsupported context onto ASSET anywhere in the spec', () => {
    const forbidden = ['LOCATION', 'FUNCTIONAL_LOCATION', 'CHECKPOINT', 'WORK_ORDER'];
    // No QR-facing enum may contain a target the resolver cannot produce.
    const qrEnums = [
      spec.components.schemas.MobileQrResolution.properties.targetType.enum,
      spec.paths[MOBILE_QR_PATH].get['x-qr-supported-target-types'],
      spec.paths[ASSET_RESOLVE_PATH].get['x-qr-supported-target-types'],
    ];
    for (const values of qrEnums) {
      for (const value of forbidden) {
        assert.ok(
          !values.includes(value),
          `${value} must not be advertised as a QR target type`,
        );
      }
    }
  });
});

describe('PART 05 creates no QR engine, endpoint or identifier authority', () => {
  it('registers no scan resolver beyond the two asset-identifier routes', () => {
    // A "scan resolver" is a resolve route keyed by an opaque VALUE
    // (`.../resolve/:something`), as opposed to unrelated business
    // operations that merely contain the word resolve
    // (`POST /utility/abnormal-consumptions/:id/resolve`,
    //  `POST /work-order-procurement-bindings/:id/resolve-readiness`,
    //  `POST /contractor-contexts/resolve`, `POST /notification-links/resolve`).
    const scanResolvers = allRegisteredRoutes().filter((route) =>
      /\/resolve\/:/.test(route),
    );
    assert.deepEqual(
      scanResolvers.sort(),
      [
        'GET /assets/resolve/:identifier',
        'GET /mobile/qr/resolve/:identifier',
      ],
      'a new scan resolver appeared — PART 05 forbids new QR resolution',
    );
  });

  it('keeps the identifier registry asset-scoped in the router', () => {
    const identifierRoutes = allRegisteredRoutes().filter((route) =>
      /\/identifiers(\/|$)/.test(route),
    );
    for (const route of identifierRoutes) {
      assert.match(
        route,
        /\/assets\/:assetId\/identifiers/,
        `identifier route ${route} is not asset-scoped — the MISSING classification would be wrong`,
      );
    }
    // No non-asset resolve-by-identifier surface exists.
    const nonAsset = allRegisteredRoutes().filter((route) =>
      /(floors|areas|rooms|spaces|functional-locations|patrol-route-points|patrol-routes|work-orders)\/[^/]*\/(identifiers|resolve)/.test(
        route,
      ),
    );
    assert.deepEqual(nonAsset, []);
  });

  it('documents no /mobile/qr path other than the resolver', () => {
    const qrPaths = Object.keys(spec.paths).filter((p: string) =>
      p.startsWith('/mobile/qr'),
    );
    assert.deepEqual(qrPaths, [MOBILE_QR_PATH]);
    const inventedSchemas = Object.keys(spec.components.schemas).filter(
      (n: string) =>
        /^(LocationQr|CheckpointQr|WorkOrderQr|QrCode|QrScan|MobileQrLocation$)/.test(
          n,
        ),
    );
    assert.deepEqual(inventedSchemas, []);
  });

  it('records no GPS / geofence behaviour in the QR contract', () => {
    const qrSchemaNames = Object.keys(spec.components.schemas).filter((n) =>
      n.startsWith('MobileQr'),
    );
    const banned = /(gps|latitude|longitude|geofence|geo_fence|coordinate|accuracyMeters)/i;
    for (const name of qrSchemaNames) {
      const serialized = JSON.stringify(spec.components.schemas[name]);
      assert.ok(
        !banned.test(serialized),
        `${name} must not carry GPS / geofence data`,
      );
    }
    const source = readSource(
      'src/modules/mobile-qr-resolution/mobile-qr.service.ts',
    );
    assert.ok(
      !banned.test(source),
      'the QR resolver must not implement GPS / geofencing',
    );
  });
});

describe('QR resolution is never anonymous and stays Building-scoped', () => {
  it('documents bearer auth, the exact permission and Building scope', () => {
    for (const path of [MOBILE_QR_PATH, ASSET_RESOLVE_PATH]) {
      const op = spec.paths[path].get;
      assert.ok(
        (op.security ?? []).some(
          (s: Record<string, unknown>) => 'bearerAuth' in s,
        ),
        `${path} must require bearer auth`,
      );
      assert.equal(op['x-required-permission'], 'asset_identifier.read');
      assert.equal(op['x-building-scoped'], true);
      assert.ok(op.responses['401'] && op.responses['403'] && op.responses['404']);
    }
  });

  it('matches the permission the router actually enforces', () => {
    const source = readSource(
      'src/modules/mobile-qr-resolution/mobile-qr.routes.ts',
    );
    assert.match(source, /requirePermission\('asset_identifier\.read'\)/);
    assert.match(source, /authenticationMiddleware/);
  });

  it('rejects unauthenticated scans with 401, never 404 or 200', async () => {
    const request = api();
    for (const path of [
      '/mobile/qr/resolve/QR-UNKNOWN-VALUE',
      '/assets/resolve/QR-UNKNOWN-VALUE',
    ]) {
      const response = await request.get(`${API_PREFIX}${path}`);
      assert.equal(
        response.status,
        401,
        `${path} must reject anonymous resolution`,
      );
      assert.equal(response.body.error.code, 'AUTHENTICATION_REQUIRED');
    }
  });
});
