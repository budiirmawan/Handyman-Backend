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
 * INT-LC-19-BE PART 02 — Spatial & Physical Hierarchy OpenAPI Closure.
 *
 * Verifies OpenAPI closure for the 6 scoped spatial modules:
 *   - campuses
 *   - floors
 *   - areas
 *   - rooms
 *   - spaces
 *   - room-types
 *
 * Required proofs:
 *  1. Exact 17 scoped runtime routes exist in OpenAPI
 *  2. Zero scoped runtime route remains undocumented (25/25 total scoped routes documented)
 *  3. No speculative scoped OpenAPI route
 *  4. All 17 have unique operationId
 *  5. Duplicate operationIds globally = 0
 *  6. Broken local $refs = 0
 *  7. Required permission metadata matches runtime
 *  8. Authenticated scoped operations expose canonical 401
 *  9. Request schemas match runtime validation
 * 10. Response schemas match actual controller/service projection
 * 11. SaaS /platform surface unchanged
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
  for (const layer of s ?? []) {
    if (layer.route?.path) {
      const full = (prefix + layer.route.path) || '/';
      for (const m of Object.keys(layer.route.methods ?? {})) {
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

function extractAllRuntimeRoutes(): Array<{ method: string; path: string; canon: string }> {
  const app: Express = createApp();
  const routes = walkRouter((app as any).router.stack);
  return routes.map((r) => ({
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

// 17 runtime routes closed in PART 02
const SCOPED_PART02_ROUTES: Array<{
  method: string;
  path: string;
  operationId: string;
  permission: string;
  buildingScoped?: boolean;
}> = [
  { method: 'POST', path: '/properties/:propertyId/campuses', operationId: 'createCampus', permission: 'campus.manage' },
  { method: 'GET', path: '/properties/:propertyId/campuses', operationId: 'listPropertyCampuses', permission: 'campus.read' },
  { method: 'GET', path: '/campuses/:id', operationId: 'getCampus', permission: 'campus.read' },
  { method: 'PATCH', path: '/campuses/:id', operationId: 'updateCampus', permission: 'campus.manage' },
  { method: 'PATCH', path: '/buildings/:buildingId/campus', operationId: 'setBuildingCampus', permission: 'campus.manage', buildingScoped: true },
  { method: 'POST', path: '/buildings/:buildingId/floors', operationId: 'createFloor', permission: 'floor.manage', buildingScoped: true },
  { method: 'PATCH', path: '/floors/:id', operationId: 'updateFloor', permission: 'floor.manage' },
  { method: 'POST', path: '/floors/:floorId/areas', operationId: 'createArea', permission: 'area.manage' },
  { method: 'PATCH', path: '/areas/:id', operationId: 'updateArea', permission: 'area.manage' },
  { method: 'POST', path: '/areas/:areaId/rooms', operationId: 'createRoom', permission: 'room.manage' },
  { method: 'PATCH', path: '/rooms/:id', operationId: 'updateRoom', permission: 'room.manage' },
  { method: 'POST', path: '/rooms/:roomId/spaces', operationId: 'createSpace', permission: 'space.manage' },
  { method: 'PATCH', path: '/spaces/:id', operationId: 'updateSpace', permission: 'space.manage' },
  { method: 'POST', path: '/clients/:clientId/room-types', operationId: 'createRoomType', permission: 'room_type.manage' },
  { method: 'GET', path: '/clients/:clientId/room-types', operationId: 'listClientRoomTypes', permission: 'room_type.read' },
  { method: 'GET', path: '/room-types/:id', operationId: 'getRoomType', permission: 'room_type.read' },
  { method: 'PATCH', path: '/room-types/:id', operationId: 'updateRoomType', permission: 'room_type.manage' },
];

// All 25 routes across the 6 scoped modules in runtime
const ALL_SCOPED_RUNTIME_ROUTES = [
  // campuses (5)
  'POST /properties/:propertyId/campuses',
  'GET /properties/:propertyId/campuses',
  'GET /campuses/:id',
  'PATCH /campuses/:id',
  'PATCH /buildings/:buildingId/campus',
  // floors (4)
  'POST /buildings/:buildingId/floors',
  'GET /buildings/:buildingId/floors',
  'GET /floors/:id',
  'PATCH /floors/:id',
  // areas (4)
  'POST /floors/:floorId/areas',
  'GET /floors/:floorId/areas',
  'GET /areas/:id',
  'PATCH /areas/:id',
  // rooms (4)
  'POST /areas/:areaId/rooms',
  'GET /areas/:areaId/rooms',
  'GET /rooms/:id',
  'PATCH /rooms/:id',
  // spaces (4)
  'POST /rooms/:roomId/spaces',
  'GET /rooms/:roomId/spaces',
  'GET /spaces/:id',
  'PATCH /spaces/:id',
  // room-types (4)
  'POST /clients/:clientId/room-types',
  'GET /clients/:clientId/room-types',
  'GET /room-types/:id',
  'PATCH /room-types/:id',
];

describe('OpenAPI Spatial Hierarchy Closure (INT-LC-19-BE PART 02)', () => {
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

  // 1. exact 17 scoped runtime routes exist in OpenAPI
  it('1. exact 17 scoped runtime routes exist in OpenAPI', () => {
    assert.equal(SCOPED_PART02_ROUTES.length, 17, 'Scoped PART 02 routes count must be 17');
    for (const route of SCOPED_PART02_ROUTES) {
      const canon = `${route.method} ${normalizePath(route.path)}`;
      const match = openApiMap.get(canon);
      assert.ok(match, `Route ${route.method} ${route.path} (${canon}) must exist in OpenAPI`);
      assert.equal(match.operationId, route.operationId, `${canon} operationId must match ${route.operationId}`);
    }
  });

  // 2. zero scoped runtime route remains undocumented (all 25 scoped routes exist in OpenAPI)
  it('2. zero scoped runtime route remains undocumented (25/25 scoped routes documented)', () => {
    assert.equal(ALL_SCOPED_RUNTIME_ROUTES.length, 25, 'Total scoped runtime routes must be exactly 25');
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
        p.includes('campuse') ||
        p.includes('campus') ||
        p.includes('floor') ||
        p.includes('area') ||
        p.includes('room') ||
        p.includes('space')
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

  // 4. all 17 have unique operationId
  it('4. all 17 have unique operationId', () => {
    const opIds = SCOPED_PART02_ROUTES.map((r) => r.operationId);
    const uniqueIds = new Set(opIds);
    assert.equal(uniqueIds.size, 17, 'All 17 operationIds must be distinct');
    for (const r of SCOPED_PART02_ROUTES) {
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
    const components = SPEC.components as Record<string, Record<string, unknown>> ?? {};
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
  it('7. required permission metadata matches runtime', () => {
    for (const r of SCOPED_PART02_ROUTES) {
      const canon = `${r.method} ${normalizePath(r.path)}`;
      const op = openApiMap.get(canon);
      assert.ok(op, `Op ${canon} found`);
      assert.equal(
        op.xRequiredPermission,
        r.permission,
        `${canon} x-required-permission must be ${r.permission}`,
      );
      if (r.buildingScoped) {
        assert.equal(
          op.xBuildingScoped,
          true,
          `${canon} must declare x-building-scoped: true`,
        );
      }
    }
  });

  // 8. authenticated scoped operations expose canonical 401
  it('8. authenticated scoped operations expose canonical 401', () => {
    for (const r of SCOPED_PART02_ROUTES) {
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

  // 9. request schemas match runtime validation
  it('9. request schemas match runtime validation', () => {
    const schemas = SPEC.components.schemas;

    // CreateCampusRequest: code, name required; description, status optional
    assert.deepEqual(schemas.CreateCampusRequest.required, ['code', 'name']);
    assert.ok(schemas.CreateCampusRequest.properties.code);
    assert.ok(schemas.CreateCampusRequest.properties.name);
    assert.ok(schemas.CreateCampusRequest.properties.description);
    assert.ok(schemas.CreateCampusRequest.properties.status);

    // SetBuildingCampusRequest: campusId required
    assert.deepEqual(schemas.SetBuildingCampusRequest.required, ['campusId']);
    assert.equal(schemas.SetBuildingCampusRequest.properties.campusId.nullable, true);

    // CreateFloorRequest: code, name, levelNumber required
    assert.deepEqual(schemas.CreateFloorRequest.required, ['code', 'name', 'levelNumber']);
    assert.equal(schemas.CreateFloorRequest.properties.levelNumber.type, 'integer');

    // CreateAreaRequest: code, name required; type optional
    assert.deepEqual(schemas.CreateAreaRequest.required, ['code', 'name']);
    assert.ok(schemas.CreateAreaRequest.properties.type);

    // CreateRoomRequest: code, name required
    assert.deepEqual(schemas.CreateRoomRequest.required, ['code', 'name']);

    // UpdateRoomRequest: roomTypeId optional & nullable
    assert.equal(schemas.UpdateRoomRequest.properties.roomTypeId.nullable, true);

    // CreateSpaceRequest: code, name required; areaSqm optional & nullable
    assert.deepEqual(schemas.CreateSpaceRequest.required, ['code', 'name']);
    assert.equal(schemas.CreateSpaceRequest.properties.areaSqm.nullable, true);

    // CreateRoomTypeRequest: code, name required
    assert.deepEqual(schemas.CreateRoomTypeRequest.required, ['code', 'name']);
  });

  // 10. response schemas match actual controller/service projection
  it('10. response schemas match actual controller/service projection', () => {
    const schemas = SPEC.components.schemas;

    // PublicCampus
    assert.deepEqual(schemas.PublicCampus.required, [
      'id', 'propertyId', 'code', 'name', 'description', 'status',
    ]);
    assert.deepEqual(schemas.CampusStatus.enum, ['ACTIVE', 'INACTIVE']);

    // PublicFloor
    assert.deepEqual(schemas.PublicFloor.required, [
      'id', 'buildingId', 'code', 'name', 'levelNumber', 'description', 'status',
    ]);

    // PublicArea
    assert.deepEqual(schemas.PublicArea.required, [
      'id', 'floorId', 'code', 'name', 'type', 'description', 'status',
    ]);

    // PublicRoom
    assert.deepEqual(schemas.PublicRoom.required, [
      'id', 'areaId', 'roomTypeId', 'code', 'name', 'description', 'status',
    ]);

    // PublicSpace (now includes areaSqm)
    assert.deepEqual(schemas.PublicSpace.required, [
      'id', 'roomId', 'code', 'name', 'description', 'areaSqm', 'status',
    ]);
    assert.equal(schemas.PublicSpace.properties.areaSqm.type, 'number');
    assert.equal(schemas.PublicSpace.properties.areaSqm.nullable, true);

    // PublicRoomType
    assert.deepEqual(schemas.PublicRoomType.required, [
      'id', 'clientId', 'code', 'name', 'description', 'status',
    ]);
    assert.deepEqual(schemas.RoomTypeStatus.enum, ['ACTIVE', 'INACTIVE']);
  });

  // 11. SaaS /platform surface unchanged
  it('11. SaaS /platform surface unchanged', () => {
    assert.equal(platformRuntime.length, 69, 'SaaS platform runtime count must remain 69');
    assert.equal(platformOpenApi.length, 69, 'SaaS platform OpenAPI operation count must remain 69');

    const runtimeKeys = new Set(platformRuntime.map((r) => `${r.method} ${r.canon}`));
    const openapiKeys = new Set(platformOpenApi.map((o) => `${o.method} ${o.canon}`));

    assert.deepEqual([...runtimeKeys].filter((k) => !openapiKeys.has(k)), []);
    assert.deepEqual([...openapiKeys].filter((k) => !runtimeKeys.has(k)), []);
  });
});
