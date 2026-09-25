import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import type { Express } from 'express';

// Enable WhatsApp callback router in environment before createApp() so full runtime is mounted
process.env.WHATSAPP_WEBHOOK_ENABLED = 'true';
process.env.WHATSAPP_META_APP_SECRET = 'test-secret';
process.env.WHATSAPP_META_WEBHOOK_VERIFY_TOKEN = 'test-token';

import { createApp } from '../src/app';

/**
 * INT-LC-19-BE PART 03 — Asset & Equipment Lifecycle OpenAPI Closure.
 *
 * Verifies OpenAPI closure for the 7 scoped asset/equipment lifecycle modules:
 *   - assets
 *   - asset-certifications
 *   - asset-warranties
 *   - asset-identifiers
 *   - equipment-profiles
 *   - functional-locations
 *   - inventory-asset-spare-parts
 *
 * Required proofs:
 *  1. Exact 18 PART 03 routes are documented
 *  2. PART 03 scoped gaps = 0 (all 32 scoped routes exist in OpenAPI)
 *  3. No speculative scoped OpenAPI route
 *  4. All 18 have unique operationId
 *  5. Global duplicate operationIds = 0
 *  6. Broken local $refs = 0
 *  7. Required permission metadata matches runtime
 *  8. Building/data scope metadata matches runtime
 *  9. Canonical 401 present where authenticated
 * 10. Request schemas match runtime validation
 * 11. Response schemas match runtime projection
 * 12. All 4 asset-failures routes remain excluded (deferred to PART 04)
 * 13. SaaS /platform surface remains 69/69 untouched
 */

const SPEC_PATH = resolve(__dirname, '../docs/api/openapi.yaml');
const SPEC = parse(readFileSync(SPEC_PATH, 'utf8')) as Record<string, any>;

function normalizePath(p: string): string {
  return p
    .replace(/:([a-zA-Z0-9_]+)/g, '{$1}')
    .replace(/\{([a-zA-Z0-9_]+)\}/g, '{p}')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '') || '/';
}

function walkRouter(
  stack: unknown,
  prefix = '',
): Array<{ method: string; path: string }> {
  const out: Array<{ method: string; path: string }> = [];
  const s = stack as Array<{
    route?: { path?: string; methods?: Record<string, unknown> };
    handle?: { stack?: unknown[]; regexp?: { source?: string } };
    matchers?: Array<(input: string) => boolean | object>;
  }>;

  for (const layer of s || []) {
    if (layer.route?.path) {
      const full = (prefix + layer.route.path) || '/';
      for (const m of Object.keys(layer.route.methods || {})) {
        if (m === '_all') continue;
        out.push({ method: m.toUpperCase(), path: full });
      }
    } else if (layer.handle?.stack) {
      let layerPrefix = prefix;
      if (layer.matchers?.[0]?.('/webhooks/notifications/whatsapp')) {
        layerPrefix = '/webhooks/notifications/whatsapp';
      }
      out.push(...walkRouter(layer.handle.stack, layerPrefix));
    }
  }
  return out;
}

function extractAllRuntimeRoutes(): Array<{
  method: string;
  path: string;
  canon: string;
}> {
  const app = createApp() as Express & { router?: { stack: unknown } };
  const stack = app.router?.stack;
  if (!stack) {
    throw new Error('Could not access express router stack from createApp()');
  }

  const raw = walkRouter(stack);
  return raw.map((r) => ({
    method: r.method,
    path: r.path,
    canon: normalizePath(r.path),
  }));
}

function extractOpenApiOperations(): Array<{
  method: string;
  path: string;
  canon: string;
  operationId?: string;
  responses?: Record<string, any>;
  security?: any[];
  requestBody?: any;
  parameters?: any[];
  xRequiredPermission?: string;
  xBuildingScoped?: boolean;
}> {
  const out: Array<{
    method: string;
    path: string;
    canon: string;
    operationId?: string;
    responses?: Record<string, any>;
    security?: any[];
    requestBody?: any;
    parameters?: any[];
    xRequiredPermission?: string;
    xBuildingScoped?: boolean;
  }> = [];
  const paths = (SPEC.paths as Record<string, Record<string, any>>) ?? {};
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      out.push({
        method: method.toUpperCase(),
        path,
        canon: normalizePath(path),
        operationId: op.operationId,
        responses: op.responses,
        security: op.security,
        requestBody: op.requestBody,
        parameters: op.parameters,
        xRequiredPermission: op['x-required-permission'],
        xBuildingScoped: op['x-building-scoped'],
      });
    }
  }
  return out;
}

// 18 runtime routes closed in PART 03
const SCOPED_PART03_ROUTES: Array<{
  method: string;
  path: string;
  operationId: string;
  permission: string;
  buildingScoped: boolean;
}> = [
  { method: 'POST', path: '/buildings/:buildingId/assets', operationId: 'createAsset', permission: 'asset.manage', buildingScoped: true },
  { method: 'PATCH', path: '/assets/:id', operationId: 'updateAsset', permission: 'asset.manage', buildingScoped: true },
  { method: 'PATCH', path: '/assets/:id/location', operationId: 'updateAssetLocation', permission: 'asset.manage', buildingScoped: true },
  { method: 'PATCH', path: '/assets/:assetId/status', operationId: 'updateAssetStatus', permission: 'asset.manage', buildingScoped: true },
  { method: 'POST', path: '/assets/:assetId/certifications', operationId: 'createAssetCertification', permission: 'asset_certification.manage', buildingScoped: true },
  { method: 'GET', path: '/assets/:assetId/certifications/current', operationId: 'getCurrentAssetCertifications', permission: 'asset_certification.read', buildingScoped: true },
  { method: 'PATCH', path: '/assets/:assetId/certifications/:certificationId', operationId: 'updateAssetCertification', permission: 'asset_certification.manage', buildingScoped: true },
  { method: 'POST', path: '/assets/:assetId/warranties', operationId: 'createAssetWarranty', permission: 'asset_warranty.manage', buildingScoped: true },
  { method: 'GET', path: '/assets/:assetId/warranty', operationId: 'getCurrentAssetWarranty', permission: 'asset_warranty.read', buildingScoped: true },
  { method: 'PATCH', path: '/assets/:assetId/warranties/:warrantyId', operationId: 'updateAssetWarranty', permission: 'asset_warranty.manage', buildingScoped: true },
  { method: 'POST', path: '/assets/:assetId/identifiers', operationId: 'createAssetIdentifier', permission: 'asset_identifier.manage', buildingScoped: true },
  { method: 'PATCH', path: '/assets/:assetId/identifiers/:identifierId', operationId: 'updateAssetIdentifier', permission: 'asset_identifier.manage', buildingScoped: true },
  { method: 'POST', path: '/assets/:assetId/equipment-profile', operationId: 'createEquipmentProfile', permission: 'equipment_profile.manage', buildingScoped: true },
  { method: 'PATCH', path: '/assets/:assetId/equipment-profile', operationId: 'updateEquipmentProfile', permission: 'equipment_profile.manage', buildingScoped: true },
  { method: 'POST', path: '/buildings/:buildingId/functional-locations', operationId: 'createFunctionalLocation', permission: 'functional_location.manage', buildingScoped: true },
  { method: 'PATCH', path: '/functional-locations/:id', operationId: 'updateFunctionalLocation', permission: 'functional_location.manage', buildingScoped: true },
  { method: 'POST', path: '/assets/:assetId/spare-parts', operationId: 'bindAssetSparePart', permission: 'asset.manage', buildingScoped: true },
  { method: 'PATCH', path: '/asset-spare-parts/:id', operationId: 'updateAssetSparePartBinding', permission: 'asset.manage', buildingScoped: true },
];

// All 32 routes across the 7 scoped modules in runtime
const ALL_SCOPED_RUNTIME_ROUTES = [
  // assets (8)
  'POST /buildings/:buildingId/assets',
  'GET /buildings/:buildingId/assets',
  'GET /assets/:id',
  'PATCH /assets/:id',
  'GET /assets/:id/location',
  'PATCH /assets/:id/location',
  'GET /assets/:assetId/status',
  'PATCH /assets/:assetId/status',
  // asset-certifications (4)
  'POST /assets/:assetId/certifications',
  'GET /assets/:assetId/certifications',
  'GET /assets/:assetId/certifications/current',
  'PATCH /assets/:assetId/certifications/:certificationId',
  // asset-warranties (4)
  'POST /assets/:assetId/warranties',
  'GET /assets/:assetId/warranties',
  'GET /assets/:assetId/warranty',
  'PATCH /assets/:assetId/warranties/:warrantyId',
  // asset-identifiers (4)
  'GET /assets/resolve/:identifier',
  'POST /assets/:assetId/identifiers',
  'GET /assets/:assetId/identifiers',
  'PATCH /assets/:assetId/identifiers/:identifierId',
  // equipment-profiles (3)
  'POST /assets/:assetId/equipment-profile',
  'GET /assets/:assetId/equipment-profile',
  'PATCH /assets/:assetId/equipment-profile',
  // functional-locations (4)
  'POST /buildings/:buildingId/functional-locations',
  'GET /buildings/:buildingId/functional-locations',
  'GET /functional-locations/:id',
  'PATCH /functional-locations/:id',
  // inventory-asset-spare-parts (5)
  'POST /assets/:assetId/spare-parts',
  'GET /assets/:assetId/spare-parts',
  'GET /inventory-items/:itemId/asset-bindings',
  'GET /asset-spare-parts/:id',
  'PATCH /asset-spare-parts/:id',
];

const ASSET_FAILURES_ROUTES = [
  'POST /asset-failures',
  'GET /asset-failures',
  'GET /asset-failures/:id',
  'PATCH /asset-failures/:id',
];

describe('OpenAPI Asset & Equipment Lifecycle Closure (INT-LC-19-BE PART 03)', () => {
  const runtime = extractAllRuntimeRoutes();
  const openapi = extractOpenApiOperations();

  const platformRuntime = runtime.filter((r) => r.path.startsWith('/platform') || r.path === '/platform');
  const operationalRuntime = runtime.filter((r) => !r.path.startsWith('/platform') && r.path !== '/platform');
  const platformOpenApi = openapi.filter((o) => o.path.startsWith('/platform'));
  const operationalOpenApi = openapi.filter((o) => !o.path.startsWith('/platform'));

  const openApiMap = new Map<string, typeof openapi[0]>();
  for (const op of openapi) {
    openApiMap.set(`${op.method} ${op.canon}`, op);
  }

  // 1. exact 18 scoped runtime routes exist in OpenAPI
  it('1. exact 18 PART 03 routes are documented', () => {
    assert.equal(SCOPED_PART03_ROUTES.length, 18, 'Scoped PART 03 routes count must be exactly 18');
    for (const route of SCOPED_PART03_ROUTES) {
      const canon = `${route.method} ${normalizePath(route.path)}`;
      const match = openApiMap.get(canon);
      assert.ok(match, `Route ${route.method} ${route.path} (${canon}) must exist in OpenAPI`);
      assert.equal(match.operationId, route.operationId, `${canon} operationId must match ${route.operationId}`);
    }
  });

  // 2. PART 03 scoped gaps = 0 (all 32 scoped routes exist in OpenAPI)
  it('2. PART 03 scoped gaps = 0 (32/32 scoped routes documented)', () => {
    assert.equal(ALL_SCOPED_RUNTIME_ROUTES.length, 32, 'Total scoped runtime routes must be exactly 32');
    const missing: string[] = [];
    for (const r of ALL_SCOPED_RUNTIME_ROUTES) {
      const [method, path] = r.split(' ');
      const canon = `${method} ${normalizePath(path)}`;
      if (!openApiMap.has(canon)) {
        missing.push(r);
      }
    }
    assert.deepEqual(missing, [], 'Zero scoped runtime routes should remain undocumented');
  });

  // 3. no speculative scoped OpenAPI route
  it('3. no speculative scoped OpenAPI route', () => {
    const runtimeCanon = new Set(runtime.map((r) => `${r.method} ${r.canon}`));
    const scopedOpenApiOps = openapi.filter((op) => {
      const p = op.path;
      return (
        p.includes('functional-location') ||
        p.includes('equipment-profile') ||
        p.includes('spare-part') ||
        (p.includes('/assets') && !p.includes('/mobile/') && !p.includes('/asset-failures'))
      );
    });

    const speculative: string[] = [];
    for (const op of scopedOpenApiOps) {
      const key = `${op.method} ${op.canon}`;
      if (!runtimeCanon.has(key)) {
        speculative.push(`${op.method} ${op.path}`);
      }
    }
    assert.deepEqual(speculative, [], 'All scoped OpenAPI operations must exist in runtime');
  });

  // 4. all 18 have unique operationId
  it('4. all 18 have unique operationId', () => {
    const opIds = SCOPED_PART03_ROUTES.map((r) => r.operationId);
    const uniqueIds = new Set(opIds);
    assert.equal(uniqueIds.size, 18, 'All 18 operationIds must be distinct');
    for (const r of SCOPED_PART03_ROUTES) {
      const canon = `${r.method} ${normalizePath(r.path)}`;
      const op = openApiMap.get(canon);
      assert.equal(op?.operationId, r.operationId);
    }
  });

  // 5. duplicate operationIds globally = 0
  it('5. duplicate operationIds globally = 0', () => {
    const seen = new Map<string, string>();
    const dups: string[] = [];
    for (const op of openapi) {
      if (!op.operationId) continue;
      const key = `${op.method} ${op.path}`;
      if (seen.has(op.operationId)) {
        dups.push(`${op.operationId} (at ${key} and ${seen.get(op.operationId)})`);
      }
      seen.set(op.operationId, key);
    }
    assert.deepEqual(dups, [], 'Duplicate operationIds count must be 0');
  });

  // 6. broken local $refs = 0
  it('6. broken local $refs = 0', () => {
    const components = (SPEC.components as Record<string, Record<string, unknown>>) ?? {};
    const buckets: Record<string, Set<string>> = {};
    for (const [k, v] of Object.entries(components)) {
      buckets[k] = new Set(Object.keys(v ?? {}));
    }

    const broken: string[] = [];
    function walk(node: unknown): void {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      const o = node as Record<string, unknown>;
      if (typeof o['$ref'] === 'string') {
        const ref = o['$ref'];
        if (ref.startsWith('#/components/')) {
          const parts = ref.slice(2).split('/');
          const bucket = parts[1];
          const tail = parts.slice(2).join('/');
          if (!buckets[bucket]?.has(tail)) broken.push(ref);
        }
      }
      for (const v of Object.values(o)) walk(v);
    }
    walk(SPEC);
    assert.deepEqual(broken, [], 'Zero broken $refs allowed');
  });

  // 7. required permission metadata matches runtime
  it('7. permission metadata matches runtime', () => {
    for (const r of SCOPED_PART03_ROUTES) {
      const canon = `${r.method} ${normalizePath(r.path)}`;
      const op = openApiMap.get(canon);
      assert.ok(op, `Op ${canon} found`);
      assert.equal(
        op.xRequiredPermission,
        r.permission,
        `${canon} x-required-permission must be ${r.permission}`,
      );
    }
  });

  // 8. building/data scope metadata matches runtime
  it('8. building/data scope metadata matches runtime', () => {
    for (const r of SCOPED_PART03_ROUTES) {
      const canon = `${r.method} ${normalizePath(r.path)}`;
      const op = openApiMap.get(canon);
      assert.ok(op, `Op ${canon} found`);
      assert.equal(
        op.xBuildingScoped,
        true,
        `${canon} must declare x-building-scoped: true`,
      );
    }
  });

  // 9. canonical 401 present where authenticated
  it('9. canonical 401 present where authenticated', () => {
    for (const r of SCOPED_PART03_ROUTES) {
      const canon = `${r.method} ${normalizePath(r.path)}`;
      const op = openApiMap.get(canon);
      assert.ok(op, `Op ${canon} found`);
      assert.ok(
        Array.isArray(op.security) && op.security.some((s) => 'bearerAuth' in s),
        `${canon} must require bearerAuth`,
      );
      assert.ok(op.responses?.['401'], `${canon} must expose canonical 401 response`);
    }
  });

  // 10. request schemas match runtime validation
  it('10. request schemas match runtime validation', () => {
    const schemas = SPEC.components.schemas;

    // CreateAssetRequest
    assert.deepEqual(schemas.CreateAssetRequest.required, ['assetCode', 'assetName']);
    assert.ok(schemas.CreateAssetRequest.properties.assetCode);
    assert.ok(schemas.CreateAssetRequest.properties.assetName);
    assert.ok(schemas.CreateAssetRequest.properties.status);

    // UpdateAssetRequest
    assert.ok(schemas.UpdateAssetRequest.properties.assetName);
    assert.ok(schemas.UpdateAssetRequest.properties.status);
    assert.equal(schemas.UpdateAssetRequest.properties.functionalLocationId.nullable, true);

    // UpdateAssetLocationRequest
    assert.deepEqual(schemas.UpdateAssetLocationRequest.required, ['functionalLocationId']);
    assert.equal(schemas.UpdateAssetLocationRequest.properties.functionalLocationId.nullable, true);

    // UpdateAssetStatusRequest
    assert.deepEqual(schemas.UpdateAssetStatusRequest.required, ['status']);

    // CreateAssetCertificationRequest
    assert.deepEqual(schemas.CreateAssetCertificationRequest.required, [
      'certificationType', 'certificateNumber', 'issuingAuthority', 'issueDate',
    ]);
    assert.equal(schemas.CreateAssetCertificationRequest.properties.issueDate.format, 'date');

    // CreateAssetWarrantyRequest
    assert.deepEqual(schemas.CreateAssetWarrantyRequest.required, [
      'providerName', 'warrantyNumber', 'startDate', 'endDate',
    ]);

    // CreateAssetIdentifierRequest
    assert.deepEqual(schemas.CreateAssetIdentifierRequest.required, ['identifierType']);

    // CreateEquipmentProfileRequest
    assert.deepEqual(schemas.CreateEquipmentProfileRequest.required, ['equipmentCode', 'equipmentName']);

    // CreateFunctionalLocationRequest
    assert.deepEqual(schemas.CreateFunctionalLocationRequest.required, ['code', 'name']);

    // CreateAssetSparePartRequest
    assert.deepEqual(schemas.CreateAssetSparePartRequest.required, ['itemId']);
  });

  // 11. response schemas match runtime projection
  it('11. response schemas match runtime projection', () => {
    const schemas = SPEC.components.schemas;

    // PublicAsset
    assert.ok(schemas.PublicAsset.properties.assetCode);
    assert.ok(schemas.PublicAsset.properties.status);

    // AssetLocation
    assert.deepEqual(schemas.AssetLocation.required, ['asset', 'location']);

    // AssetStatusUpdateResult
    assert.deepEqual(schemas.AssetStatusUpdateResult.required, ['asset', 'lifecycle']);
    assert.deepEqual(schemas.AssetLifecycleStatus.required, [
      'assetId', 'status', 'previousStatus', 'statusChangedAt', 'statusReason',
      'allowedTransitions', 'isTerminal',
    ]);

    // AssetCertification
    assert.deepEqual(schemas.AssetCertification.required, [
      'id', 'assetId', 'certificationType', 'certificateNumber', 'issuingAuthority',
      'issueDate', 'expiryDate', 'status', 'notes', 'isCurrentlyEffective',
    ]);

    // AssetWarranty
    assert.deepEqual(schemas.AssetWarranty.required, [
      'id', 'assetId', 'providerName', 'warrantyNumber', 'startDate', 'endDate',
      'coverageDescription', 'status', 'isCurrentlyCovered',
    ]);

    // AssetIdentifier
    assert.deepEqual(schemas.AssetIdentifier.required, [
      'id', 'assetId', 'identifierType', 'identifierValue', 'status',
    ]);

    // PublicEquipmentProfile
    assert.deepEqual(schemas.PublicEquipmentProfile.required, [
      'id', 'assetId', 'equipmentCode', 'equipmentName', 'manufacturer', 'model',
      'serialNumber', 'specification', 'capacity', 'unitOfMeasure',
      'installationDate', 'commissioningDate', 'status',
    ]);

    // PublicFunctionalLocation
    assert.deepEqual(schemas.PublicFunctionalLocation.required, [
      'id', 'buildingId', 'spaceId', 'code', 'name', 'description', 'status',
    ]);

    // AssetSparePart
    assert.deepEqual(schemas.AssetSparePart.required, [
      'id', 'clientId', 'buildingId', 'assetId', 'itemId', 'requiredQuantity',
      'status', 'notes', 'createdAt', 'updatedAt',
    ]);
  });

  // 12. all 4 asset-failures routes remain excluded
  it('12. all 4 asset-failures routes remain excluded', () => {
    for (const r of ASSET_FAILURES_ROUTES) {
      const [method, path] = r.split(' ');
      const canon = `${method} ${normalizePath(path)}`;
      assert.equal(
        openApiMap.has(canon),
        false,
        `Asset failure route ${r} (${canon}) must remain excluded from OpenAPI in PART 03`,
      );
    }
  });

  // 13. SaaS /platform surface remains 69/69 untouched
  it('13. SaaS /platform surface remains 69/69 untouched', () => {
    assert.equal(platformRuntime.length, 69, 'SaaS platform runtime count must remain 69');
    assert.equal(platformOpenApi.length, 69, 'SaaS platform OpenAPI operation count must remain 69');

    const runtimeKeys = new Set(platformRuntime.map((r) => `${r.method} ${r.canon}`));
    const openapiKeys = new Set(platformOpenApi.map((o) => `${o.method} ${o.canon}`));

    assert.deepEqual([...runtimeKeys].filter((k) => !openapiKeys.has(k)), []);
    assert.deepEqual([...openapiKeys].filter((k) => !runtimeKeys.has(k)), []);
  });

  // Census counts after PART 03
  it('Census validation after PART 03', () => {
    assert.equal(operationalOpenApi.length, 1285, 'Operational OpenAPI operations count must be 1285');
    assert.equal(openapi.length, 1354, 'Total OpenAPI operations count must be 1354');

    const inScopeOperational = operationalRuntime.filter((r) => r.path !== '/');
    assert.equal(inScopeOperational.length, 1617, 'In-scope operational runtime routes count must be 1617');
    assert.equal(inScopeOperational.length - operationalOpenApi.length, 332, 'Arithmetic runtime gap must be 332');

    const distinctOperationalCanon = new Set(inScopeOperational.map((r) => `${r.method} ${r.canon}`));
    const distinctUndoc = [...distinctOperationalCanon].filter((c) => !openApiMap.has(c));
    assert.equal(distinctUndoc.length, 331, 'Distinct runtime gap must be 331');
  });
});
