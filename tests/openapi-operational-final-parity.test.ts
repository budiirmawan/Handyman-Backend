import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import type { Express } from 'express';

// WhatsApp callback is part of the operational runtime when enabled.
process.env.WHATSAPP_WEBHOOK_ENABLED = 'true';
process.env.WHATSAPP_META_APP_SECRET = 'test-secret';
process.env.WHATSAPP_META_WEBHOOK_VERIFY_TOKEN = 'test-token';

import { createApp } from '../src/app';

/**
 * INT-LC-19-BE PART 14 — final operational parity.
 *
 * CR-HM-WORKER-COMPETENCY-01 PART 04A — pins reconciled with the ACTUAL route
 * inventory after ~330 operations landed in later PARTs.
 *
 * CR-HM-BACKEND-RELEASE-INTEGRATION-01 PART 01 — pins re-reconciled once for the
 * MERGED release (worker competency + IAM permission revocation + assignment
 * response / field expense / helper attendance), measured on the integration
 * branch with this suite's own inventory (WHATSAPP_WEBHOOK_ENABLED=true):
 *
 *   runtime routes ............ 2,052  (1,982 operational in-scope + 1 root + 69 platform)
 *   operational OpenAPI ....... 1,981
 *   platform OpenAPI ..........    69
 *   total OpenAPI ............. 2,032
 *
 * CR-HM-FIELD-OPERATIONS-01 FINAL REVIEW (2026-10-24) — re-reconciled from a
 * MEASUREMENT, not a guess, because the previous pins were already stale on
 * `main` (they were 4 behind the merged inventory). Derivation:
 *
 *   measured on `main` (ee20d218) with this suite's inventory
 *     runtime 2,038 · in-scope 1,968 · operational OpenAPI 1,967 · total 2,036
 *   approved additive deltas carried by this branch
 *     PART 02  +1  (POST .../arrival-challenge)
 *     PART 04  +6  (G-2 registry x3, G-3 geofence policy x3)
 *   => runtime 2,045 · in-scope 1,975 · operational OpenAPI 1,974 ·
 *      total OpenAPI 2,043 (1,974 + 69 platform)
 *
 * PR #60 MERGED RECONCILIATION (2026-10-24, after PR #59 landed on `main`):
 * measured on the merged tree with this suite's own inventory —
 *     runtime 2,067 · in-scope 1,997 · distinct in-scope 1,996 ·
 *     operational OpenAPI 1,996 · total OpenAPI 2,065 (1,996 + 69 platform)
 * i.e. PR #59's post-merge pins (2,045 / 1,975 / 1,974 / 2,043) plus this CR's
 * additively mounted catalogue / request-item / quotation operations, measured
 * as +22 in-scope runtime rows (1,975 -> 1,997). The exact per-PART split is
 * the one already documented in the Service Catalog delivery record; this
 * suite pins the total it actually measures.
 *
 * The structural invariants are unchanged and still asserted (unmapped = 0,
 * speculative = 0, platform parity, duplicate operationIds = 0, local $refs
 * resolve); only these snapshots moved.
 *
 * The invariants are unchanged and still asserted structurally (unmapped = 0,
 * speculative = 0, platform parity, duplicate operationIds = 0, local $refs
 * resolve); only the snapshots below were refreshed.
 *
 * The application root `GET /` stays infrastructure (never documented). The
 * duplicate task mount still collapses to one OpenAPI operation and remains the
 * only arithmetic gap (1,982 runtime rows vs 1,981 documented operations).
 */

const SPEC_PATH = resolve(__dirname, '../docs/api/openapi.yaml');
const SPEC = parse(readFileSync(SPEC_PATH, 'utf8')) as Record<string, any>;

const PART14_OPERATION_IDS = [
  'verifyWhatsAppNotificationWebhook',
  'receiveWhatsAppNotificationWebhook',
  'createReview',
  'getReview',
  'decideReview',
  'getVendorTenantKpi',
  'createInvitation',
  'acceptInvitation',
  'revokeInvitation',
  'getMeUsage',
  'createWorkOrderFromRequest',
  'resolveContractorContext',
  'validateContractorPermitEligibility',
  'listContractorContexts',
  'getContractorContext',
] as const;

const PUBLIC_OR_PROVIDER = new Set([
  'GET /health',
  'GET /health/database',
  'POST /auth/login',
  'POST /invitations/accept',
  // `security: []` in the spec: token-based public validation, no session, so
  // a 401 is not part of its contract (same treatment as acceptInvitation).
  'POST /invitations/validate',
  'POST /handyman/requests/care',
]);

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
    handle?: { stack?: unknown[] };
    matchers?: Array<(input: string) => boolean | object>;
  }>;
  for (const layer of s ?? []) {
    if (layer.route?.path) {
      // Express accepts an ARRAY of paths for a single handler
      // (`router.get(['/a', '/a/:id'], handler)`); each entry is its own route.
      // Treating the array as one string used to hide those operations from the
      // parity inventory and report them as speculative OpenAPI.
      const paths = Array.isArray(layer.route.path)
        ? layer.route.path
        : [layer.route.path];
      for (const routePath of paths) {
        const full = (prefix + routePath) || '/';
        for (const m of Object.keys(layer.route.methods ?? {})) {
          if (m === '_all') continue;
          out.push({ method: m.toUpperCase(), path: full });
        }
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

type RuntimeRoute = { method: string; path: string; canon: string };
type OpenApiOp = {
  method: string;
  path: string;
  canon: string;
  operationId?: string;
  responses?: Record<string, unknown>;
  security?: unknown[];
  requiredPermission?: string;
  errorCodes?: unknown;
};

function extractAllRuntimeRoutes(): RuntimeRoute[] {
  const app: Express = createApp();
  return walkRouter((app as any).router.stack).map((r) => ({
    method: r.method,
    path: r.path,
    canon: normalizePath(r.path),
  }));
}

function extractOpenApiOperations(): OpenApiOp[] {
  const out: OpenApiOp[] = [];
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
        requiredPermission: op['x-required-permission'],
        errorCodes: op['x-error-codes'],
      });
    }
  }
  return out;
}

describe('OpenAPI operational final parity (INT-LC-19-BE PART 14)', () => {
  const runtime = extractAllRuntimeRoutes();
  const openapi = extractOpenApiOperations();

  const platformRuntime = runtime.filter((r) => r.path.startsWith('/platform'));
  const operationalRuntime = runtime.filter((r) => !r.path.startsWith('/platform'));
  const platformOpenApi = openapi.filter((o) => o.path.startsWith('/platform'));
  const operationalOpenApi = openapi.filter((o) => !o.path.startsWith('/platform'));
  const inScopeOperational = operationalRuntime.filter((r) => r.path !== '/');

  const documentedCanon = new Set(
    operationalOpenApi.map((o) => `${o.method} ${o.canon}`),
  );
  const runtimeCanon = new Set(
    inScopeOperational.map((r) => `${r.method} ${r.canon}`),
  );
  const unmapped = inScopeOperational.filter(
    (r) => !documentedCanon.has(`${r.method} ${r.canon}`),
  );
  const speculative = operationalOpenApi.filter(
    (o) => !runtimeCanon.has(`${o.method} ${o.canon}`),
  );

  it('1. total runtime is 2067 and root GET / is the only infrastructure exclusion', () => {
    assert.equal(runtime.length, 2067);
    const root = operationalRuntime.filter((r) => r.path === '/');
    assert.equal(root.length, 1);
    assert.equal(root[0]?.method, 'GET');
    assert.equal(
      openapi.some((o) => o.path === '/' || o.canon === '/'),
      false,
      'GET / stays NON_OPENAPI_INFRASTRUCTURE_ROUTE',
    );
  });

  it('2. in-scope operational runtime is 1997 and the task duplicate collapses to one operation', () => {
    assert.equal(inScopeOperational.length, 1997);
    const taskGets = inScopeOperational.filter(
      (r) => r.method === 'GET' && r.canon === '/tasks/{p}',
    );
    assert.equal(taskGets.length, 2, 'GET /tasks/:id and GET /tasks/:taskId both mount');
    const documentedTaskGets = operationalOpenApi.filter(
      (o) => o.method === 'GET' && o.canon === '/tasks/{p}',
    );
    assert.equal(documentedTaskGets.length, 1);
    assert.equal(new Set(inScopeOperational.map((r) => `${r.method} ${r.canon}`)).size, 1996);
  });

  it('3. operational OpenAPI is 1996 and distinct operational gap is 0', () => {
    assert.equal(operationalOpenApi.length, 1996);
    assert.equal(inScopeOperational.length - operationalOpenApi.length, 1);
    assert.equal(unmapped.length, 0);
    assert.deepEqual(unmapped, []);
  });

  it('4. platform SaaS remains 69 and normalized parity is 2065/2065', () => {
    assert.equal(platformRuntime.length, 69);
    assert.equal(platformOpenApi.length, 69);
    const runtimeKeys = new Set(platformRuntime.map((r) => `${r.method} ${r.canon}`));
    const openapiKeys = new Set(platformOpenApi.map((o) => `${o.method} ${o.canon}`));
    assert.deepEqual([...runtimeKeys].filter((k) => !openapiKeys.has(k)), []);
    assert.deepEqual([...openapiKeys].filter((k) => !runtimeKeys.has(k)), []);
    assert.equal(openapi.length, 2065);
    assert.equal(1996 + 69, 2065);
    assert.equal(operationalOpenApi.length + platformOpenApi.length, openapi.length);
  });

  it('5. speculative OpenAPI is 0 and PART 14 documents exactly the remaining operations', () => {
    assert.deepEqual(
      speculative.map((o) => `${o.method} ${o.path}`),
      [],
    );
    const byId = new Map(openapi.map((o) => [o.operationId, o]));
    for (const id of PART14_OPERATION_IDS) {
      assert.equal(openapi.filter((o) => o.operationId === id).length, 1, id);
      const op = byId.get(id);
      assert.ok(op);
      assert.equal(op.path.startsWith('/platform'), false);
      assert.equal(runtimeCanon.has(`${op.method} ${op.canon}`), true, id);
    }
  });

  it('6. duplicate operationIds are 0 and local component refs resolve', () => {
    const seen = new Map<string, string>();
    const dups: string[] = [];
    for (const op of openapi) {
      assert.equal(typeof op.operationId, 'string', `${op.method} ${op.path}`);
      const key = `${op.method} ${op.path}`;
      if (seen.has(op.operationId!)) {
        dups.push(`${op.operationId} (${key} and ${seen.get(op.operationId!)})`);
      }
      seen.set(op.operationId!, key);
    }
    assert.deepEqual(dups, []);

    const buckets: Record<string, Set<string>> = {};
    for (const [name, value] of Object.entries(
      (SPEC.components as Record<string, Record<string, unknown>>) ?? {},
    )) {
      buckets[name] = new Set(Object.keys(value ?? {}));
    }
    // A `$ref` may point anywhere inside the document (for example into
    // `.../HandymanStatusVisibilityReadView/properties/stages/properties/...`),
    // so resolution walks the full JSON pointer instead of assuming a
    // `#/components/<bucket>/<name>` shape.
    const resolvePointer = (ref: string): unknown => {
      let current: unknown = SPEC;
      for (const rawPart of ref.slice(2).split('/')) {
        const part = rawPart.replace(/~1/g, '/').replace(/~0/g, '~');
        if (current === null || typeof current !== 'object') return undefined;
        current = (current as Record<string, unknown>)[part];
        if (current === undefined) return undefined;
      }
      return current;
    };
    const broken: string[] = [];
    const walk = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        for (const item of value) walk(item);
        return;
      }
      const record = value as Record<string, unknown>;
      if (typeof record.$ref === 'string' && record.$ref.startsWith('#/')) {
        if (resolvePointer(record.$ref) === undefined) broken.push(record.$ref);
      }
      for (const child of Object.values(record)) walk(child);
    };
    walk(SPEC);
    assert.deepEqual(broken, []);
  });

  it('7. authenticated documented operations have structural auth and error metadata', () => {
    const missing: string[] = [];
    for (const op of operationalOpenApi) {
      const key = `${op.method} ${op.path}`;
      if (PUBLIC_OR_PROVIDER.has(key)) continue;
      if (op.path.startsWith('/mobile/app-version')) continue;
      if (op.path.includes('webhook') || op.path.includes('callback')) continue;
      if (!op.responses?.['401']) missing.push(key);
    }
    assert.deepEqual(missing, []);

    const accept = openapi.find((o) => o.operationId === 'acceptInvitation');
    assert.deepEqual(accept?.security, []);
    assert.equal(accept?.responses?.['401'], undefined);

    const handshake = openapi.find((o) => o.operationId === 'verifyWhatsAppNotificationWebhook');
    const callback = openapi.find((o) => o.operationId === 'receiveWhatsAppNotificationWebhook');
    assert.deepEqual(handshake?.security, []);
    assert.deepEqual(callback?.security, []);
    assert.ok(callback?.responses?.['401']);

    for (const id of PART14_OPERATION_IDS) {
      if (id === 'acceptInvitation' || id === 'verifyWhatsAppNotificationWebhook' || id === 'receiveWhatsAppNotificationWebhook') {
        continue;
      }
      const op = openapi.find((item) => item.operationId === id);
      const bearer = Array.isArray(op?.security)
        && op.security.some((entry) => entry && typeof entry === 'object' && 'bearerAuth' in (entry as object));
      assert.equal(bearer, true, id);
      assert.equal(typeof op?.requiredPermission, 'string', id);
      assert.ok(Array.isArray(op?.errorCodes), id);
      assert.equal(
        (op?.errorCodes as string[]).includes('AUTHENTICATION_REQUIRED'),
        true,
        id,
      );
    }
  });
});
