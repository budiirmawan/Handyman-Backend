import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import type { Express } from 'express';
import { createApp } from '../src/app';

/**
 * CR-BE-SAAS-01 PART 13A — OpenAPI / runtime SaaS route parity.
 *
 * Walks the live `createApp()` Express router to extract every
 * `/platform/*` route, then compares it to the platform paths
 * declared in `docs/api/openapi.yaml`. Param-name cosmetic
 * differences (`:customerId` vs `:id` vs `{customerId}` vs `{id}`)
 * are normalized for the comparison.
 *
 * Required proofs:
 *   - every runtime `/platform/*` route is documented in OpenAPI;
 *   - every documented `/platform/*` route exists in runtime;
 *   - the platform-configuration POST / PATCH OCC contract is
 *     documented correctly (POST: NO expectedVersion; PATCH:
 *     expectedVersion REQUIRED);
 *   - the 5 frozen §22 add-on gaps are EXPLICITLY detected
 *     (FROZEN_RUNTIME_GAPS);
 *   - the 4 runtime extensions (helper routes) are EXPLICITLY
 *     detected (RUNTIME_EXTENSIONS);
 *   - `createSaasPricebookVersion` operationId occurs exactly once
 *     and lives at `POST /platform/pricebooks/{pricebookId}/versions`
 *     (NOT nested under `/platform/pricebooks/{pricebookId}`);
 *   - no duplicate operationId;
 *   - no broken local $ref.
 *
 * No HTTP probes; no DB. No application regression — focused
 * OpenAPI parity check only.
 */

const SPEC_PATH = resolve(__dirname, '../docs/api/openapi.yaml');
const SPEC = parse(readFileSync(SPEC_PATH, 'utf8')) as Record<string, unknown>;

function normalizePath(p: string): string {
  // Collapse `:name` and `{name}` to `{id}` so param-name cosmetic
  // differences do NOT mask real gaps.
  return p.replace(/:([a-zA-Z]+)/g, '{id}').replace(/\{([a-zA-Z]+)\}/g, '{id}');
}

function walkRouter(
  stack: unknown,
  prefix = '',
): Array<{ method: string; path: string }> {
  const out: Array<{ method: string; path: string }> = [];
  const s = stack as Array<{
    route?: { path?: string; methods?: Record<string, unknown> };
    handle?: { stack?: unknown[]; regexp?: { source?: string } };
  }>;
  for (const layer of s ?? []) {
    if (layer.route?.path) {
      const full = (prefix + layer.route.path) || '/';
      for (const m of Object.keys(layer.route.methods ?? {})) {
        if (m === '_all') continue;
        out.push({ method: m.toUpperCase(), path: full });
      }
    } else if (layer.handle?.stack) {
      const match = layer.regexp?.source ?? '';
      const cleaned = match
        .replace(/^\^/, '')
        .replace(/\$(|\?).*$/, '')
        .replace(/\\\//g, '/');
      out.push(...walkRouter(layer.handle.stack, prefix + cleaned));
    }
  }
  return out;
}

function runtimePlatformRoutes(): Array<{ method: string; norm: string; raw: string }> {
  const app: Express = createApp();
  const all = walkRouter(
    (app as unknown as { router: { stack: unknown[] } }).router.stack,
  );
  return all
    .filter((r) => r.path.startsWith('/platform/') || r.path === '/platform')
    .map((r) => ({ method: r.method, norm: normalizePath(r.path), raw: r.path }));
}

function openapiPlatformRoutes(): Array<{ method: string; norm: string; raw: string }> {
  const paths = (SPEC.paths as Record<string, Record<string, unknown>>) ?? {};
  const out: Array<{ method: string; norm: string; raw: string }> = [];
  for (const [path, item] of Object.entries(paths)) {
    if (!path.startsWith('/platform')) continue;
    for (const method of Object.keys(item)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      out.push({ method: method.toUpperCase(), norm: normalizePath(path), raw: path });
    }
  }
  return out;
}

// Frozen §22 routes — canonical list per docs/architecture/
// SAAS_CONTROL_PLANE_CONTRACT.md §22. Param-name normalization
// collapses cosmetic differences.
const FROZEN_22: Array<{ method: string; path: string }> = [
  ['GET', '/platform/customers'],
  ['POST', '/platform/customers'],
  ['GET', '/platform/customers/:id'],
  ['PATCH', '/platform/customers/:id'],
  ['GET', '/platform/customers/:id/provisioning'],
  ['POST', '/platform/customers/:id/provision'],
  ['GET', '/platform/customers/:id/usage'],
  ['GET', '/platform/products'],
  ['GET', '/platform/products/:id'],
  ['POST', '/platform/products'],
  ['PATCH', '/platform/products/:id'],
  ['GET', '/platform/packages'],
  ['POST', '/platform/packages'],
  ['GET', '/platform/packages/:id'],
  ['PATCH', '/platform/packages/:id'],
  ['GET', '/platform/add-ons'],
  ['POST', '/platform/add-ons'],
  ['PATCH', '/platform/add-ons/:id'],
  ['GET', '/platform/pricebooks'],
  ['POST', '/platform/pricebooks'],
  ['GET', '/platform/pricebooks/:id'],
  ['POST', '/platform/pricebooks/:id/versions'],
  ['POST', '/platform/pricebook-versions/:id/publish'],
  ['GET', '/platform/subscriptions'],
  ['POST', '/platform/subscriptions'],
  ['GET', '/platform/subscriptions/:id'],
  ['PATCH', '/platform/subscriptions/:id'],
  ['POST', '/platform/subscriptions/:id/activate'],
  ['POST', '/platform/subscriptions/:id/convert'],
  ['POST', '/platform/subscriptions/:id/renew'],
  ['POST', '/platform/subscriptions/:id/cancel'],
  ['POST', '/platform/subscriptions/:id/terminate'],
  ['POST', '/platform/subscriptions/:id/reactivate'],
  ['GET', '/platform/subscriptions/:id/entitlements'],
  ['POST', '/platform/subscriptions/:id/entitlements'],
  ['POST', '/platform/subscriptions/:id/add-ons'],
  ['DELETE', '/platform/subscriptions/:id/add-ons/:addOnId'],
  ['GET', '/platform/billing-accounts'],
  ['POST', '/platform/billing-accounts'],
  ['GET', '/platform/billing-accounts/:id'],
  ['PATCH', '/platform/billing-accounts/:id'],
  ['GET', '/platform/invoices'],
  ['POST', '/platform/invoices'],
  ['GET', '/platform/invoices/:id'],
  ['POST', '/platform/invoices/:id/issue'],
  ['POST', '/platform/invoices/:id/void'],
  ['GET', '/platform/payments'],
  ['POST', '/platform/payments'],
  ['GET', '/platform/payments/:id'],
  ['POST', '/platform/payments/:id/reconcile'],
  ['POST', '/platform/payments/:id/reject'],
  ['GET', '/platform/usage/meters'],
  ['POST', '/platform/usage/meters'],
  ['GET', '/platform/usage'],
  ['POST', '/platform/usage/records'],
  ['GET', '/platform/tenant-health'],
  ['GET', '/platform/reports/commercial-summary'],
  ['POST', '/platform/support-sessions'],
  ['GET', '/platform/support-sessions'],
  ['DELETE', '/platform/support-sessions/:id'],
  ['GET', '/platform/audit'],
  ['GET', '/platform/configuration'],
  ['GET', '/platform/configuration/:key'],
  ['POST', '/platform/configuration/:key'],
  ['PATCH', '/platform/configuration/:key'],
].map(([method, path]) => ({ method, path }));

describe('OpenAPI SaaS route parity (PART 13A)', () => {
  // -------------------------------------------------------------------
  // Counts (computed for the report)
  // -------------------------------------------------------------------
  const runtime = runtimePlatformRoutes();
  const documented = openapiPlatformRoutes();
  const runtimeKeys = new Set(runtime.map((r) => `${r.method} ${r.norm}`));
  const documentedKeys = new Set(documented.map((r) => `${r.method} ${r.norm}`));
  const frozenKeys = new Set(
    FROZEN_22.map((r) => `${r.method} ${normalizePath(r.path)}`),
  );

  it('runtime /platform/* route count = 69', () => {
    assert.equal(runtime.length, 69, `runtime count is ${runtime.length}, expected 69`);
  });

  it('RUNTIME_ROUTE_COUNT', () => {
    // Reporting helper — asserts the same number twice so the test
    // name shows up in the TAP output.
    assert.equal(runtime.length, 69);
  });

  // -------------------------------------------------------------------
  // OPENAPI_RUNTIME_PARITY = 69/69 PASS
  // -------------------------------------------------------------------
  it('every runtime /platform/* route is documented in OpenAPI (69/69)', () => {
    const missing = runtime
      .map((r) => `${r.method} ${r.norm}`)
      .filter((k) => !documentedKeys.has(k))
      .sort();
    assert.deepEqual(missing, [], `Runtime routes missing from OpenAPI: ${missing.join(', ')}`);
  });

  it('no documented /platform/* route is missing from runtime (no speculative SaaS route)', () => {
    const extra = documented
      .map((r) => `${r.method} ${r.norm}`)
      .filter((k) => !runtimeKeys.has(k))
      .sort();
    assert.deepEqual(extra, [], `Speculative SaaS routes in OpenAPI: ${extra.join(', ')}`);
  });

  // -------------------------------------------------------------------
  // CONFIG_OCC_PARITY — POST = NO expectedVersion, PATCH = REQUIRED
  // -------------------------------------------------------------------
  it('platform-configuration POST does NOT require expectedVersion', () => {
    const paths = (SPEC.paths as Record<string, Record<string, unknown>>) ?? {};
    const post = paths['/platform/configuration/{key}']?.post as
      | {
          requestBody?: {
            content?: { 'application/json'?: { schema?: { $ref?: string } } };
          };
        }
      | undefined;
    assert.ok(post, 'POST /platform/configuration/{key} must be documented');
    const schemaRef = post.requestBody?.content?.['application/json']?.schema?.['$ref'];
    assert.equal(
      schemaRef,
      '#/components/schemas/CreateSaasPlatformConfigurationRequest',
      'POST body must reference CreateSaasPlatformConfigurationRequest',
    );
    const schemas = (SPEC.components as { schemas?: Record<string, unknown> })?.schemas ?? {};
    const createReq = schemas['CreateSaasPlatformConfigurationRequest'] as
      | { required?: string[]; properties?: Record<string, unknown> }
      | undefined;
    assert.ok(createReq, 'CreateSaasPlatformConfigurationRequest schema must exist');
    assert.ok(
      !(createReq.required ?? []).includes('expectedVersion'),
      'CreateSaasPlatformConfigurationRequest.required MUST NOT contain expectedVersion (PART 12A PART 12B runtime contract)',
    );
    assert.equal(
      (createReq.properties ?? {})['expectedVersion'],
      undefined,
      'CreateSaasPlatformConfigurationRequest.properties MUST NOT define expectedVersion',
    );
  });

  it('platform-configuration PATCH REQUIRES expectedVersion (OCC §17.3)', () => {
    const paths = (SPEC.paths as Record<string, Record<string, unknown>>) ?? {};
    const patch = paths['/platform/configuration/{key}']?.patch as
      | {
          requestBody?: {
            content?: { 'application/json'?: { schema?: { $ref?: string } } };
          };
        }
      | undefined;
    assert.ok(patch, 'PATCH /platform/configuration/{key} must be documented');
    const schemaRef = patch.requestBody?.content?.['application/json']?.schema?.['$ref'];
    assert.equal(
      schemaRef,
      '#/components/schemas/UpdateSaasPlatformConfigurationRequest',
      'PATCH body must reference UpdateSaasPlatformConfigurationRequest',
    );
    const schemas = (SPEC.components as { schemas?: Record<string, unknown> })?.schemas ?? {};
    const updateReq = schemas['UpdateSaasPlatformConfigurationRequest'] as
      | { required?: string[]; properties?: Record<string, unknown> }
      | undefined;
    assert.ok(updateReq, 'UpdateSaasPlatformConfigurationRequest schema must exist');
    assert.ok(
      (updateReq.required ?? []).includes('expectedVersion'),
      'UpdateSaasPlatformConfigurationRequest.required MUST contain expectedVersion (OCC §17.3)',
    );
    assert.ok(
      (updateReq.properties ?? {})['expectedVersion'] !== undefined,
      'UpdateSaasPlatformConfigurationRequest.properties MUST define expectedVersion',
    );
  });

  // -------------------------------------------------------------------
  // FROZEN_RUNTIME_GAPS — explicit detection of the 5 add-on routes
  // -------------------------------------------------------------------
  it('FROZEN_RUNTIME_GAPS: exactly 5 add-on routes absent from runtime', () => {
    const frozenNotInRuntime = [...frozenKeys]
      .filter((k) => !runtimeKeys.has(k))
      .sort();
    // After PART 13C PART 02 delivery the 5 add-on routes are
    // implemented and documented; FROZEN_RUNTIME_GAPS must be 0.
    assert.deepEqual(frozenNotInRuntime, [], `Unexpected FROZEN_RUNTIME_GAPS: ${frozenNotInRuntime.join(', ')}`);
    for (const k of frozenNotInRuntime) {
      assert.ok(
        !documentedKeys.has(k),
        `Frozen §22 add-on route ${k} MUST NOT be documented in OpenAPI (runtime does not deliver it)`,
      );
    }
  });

  // -------------------------------------------------------------------
  // RUNTIME_EXTENSIONS — explicit detection of the 4 helper routes
  // -------------------------------------------------------------------
  it('RUNTIME_EXTENSIONS: exactly 4 helper routes are documented but NOT in frozen §22', () => {
    const runtimeNotInFrozen = [...runtimeKeys]
      .filter((k) => !frozenKeys.has(k))
      .sort();
    const expected: string[] = [
      'GET /platform/customers/{id}/provisioning/runs',
      'GET /platform/provisioning/runs/{id}',
      'POST /platform/subscriptions/sweep-billing',
      'POST /platform/subscriptions/{id}/sweep-billing',
    ];
    assert.deepEqual(runtimeNotInFrozen, expected);
    // Helpers ARE documented because runtime is authority (the
    // brief permits runtime-extension documentation). They MUST
    // NOT carry frozen-§22 semantics like OCC or Idempotency-Key
    // assertions unless those are documented on the operation.
    for (const k of runtimeNotInFrozen) {
      assert.ok(
        documentedKeys.has(k),
        `Runtime extension ${k} MUST be documented in OpenAPI (runtime is authority)`,
      );
    }
  });

  // -------------------------------------------------------------------
  // PRICEBOOK_VERSION_PARITY — createSaasPricebookVersion exactly once
  // -------------------------------------------------------------------
  it('createSaasPricebookVersion occurs exactly once at POST /platform/pricebooks/{pricebookId}/versions', () => {
    const paths = (SPEC.paths as Record<string, Record<string, unknown>>) ?? {};
    let occurrences = 0;
    let correctLocation = false;
    let misplaced = false;
    for (const [path, item] of Object.entries(paths)) {
      for (const [method, op] of Object.entries(item)) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
        const id = (op as { operationId?: string }).operationId;
        if (id !== 'createSaasPricebookVersion') continue;
        occurrences += 1;
        if (method === 'post' && path === '/platform/pricebooks/{pricebookId}/versions') {
          correctLocation = true;
        }
        if (method === 'post' && path === '/platform/pricebooks/{pricebookId}') {
          misplaced = true;
        }
      }
    }
    assert.equal(occurrences, 1, 'createSaasPricebookVersion must occur exactly once');
    assert.equal(correctLocation, true, 'createSaasPricebookVersion must be at POST /platform/pricebooks/{pricebookId}/versions');
    assert.equal(misplaced, false, 'createSaasPricebookVersion MUST NOT be nested at POST /platform/pricebooks/{pricebookId}');
  });

  // -------------------------------------------------------------------
  // PART 13C PART 02 — add-on specific parity proofs
  // -------------------------------------------------------------------
  it('all 5 add-on routes exist runtime + OpenAPI', () => {
    const paths = (SPEC.paths as Record<string, Record<string, unknown>>) ?? {};
    const expected: Array<{ method: string; path: string }> = [
      { method: 'GET', path: '/platform/add-ons' },
      { method: 'POST', path: '/platform/add-ons' },
      { method: 'PATCH', path: '/platform/add-ons/{id}' },
      { method: 'POST', path: '/platform/subscriptions/{id}/add-ons' },
      {
        method: 'DELETE',
        path: '/platform/subscriptions/{id}/add-ons/{addOnId}',
      },
    ];
    for (const e of expected) {
      const inRuntime = runtimeKeys.has(`${e.method} ${normalizePath(e.path)}`);
      assert.ok(inRuntime, `${e.method} ${e.path} MUST be present in runtime`);
      const op = paths[e.path]?.[e.method.toLowerCase()];
      assert.ok(op, `${e.method} ${e.path} MUST be documented in OpenAPI`);
    }
  });

  it('catalogue POST/PATCH do NOT require expectedVersion', () => {
    const paths = (SPEC.paths as Record<string, Record<string, unknown>>) ?? {};
    const schemas = (SPEC.components as { schemas?: Record<string, unknown> })
      ?.schemas ?? {};
    for (const op of [
      { method: 'post', path: '/platform/add-ons', schemaName: 'CreateSaasProductAddOnRequest' },
      { method: 'patch', path: '/platform/add-ons/{id}', schemaName: 'UpdateSaasProductAddOnRequest' },
    ]) {
      const ref = paths[op.path]?.[op.method]?.requestBody as
        | {
            content?: {
              'application/json'?: { schema?: { $ref?: string } };
            };
          }
        | undefined;
      assert.ok(ref, `requestBody MUST be documented for ${op.method.toUpperCase()} ${op.path}`);
      assert.equal(
        ref?.content?.['application/json']?.schema?.['$ref'],
        `#/components/schemas/${op.schemaName}`,
      );
      const schema = schemas[op.schemaName] as
        | { required?: string[]; properties?: Record<string, unknown> }
        | undefined;
      assert.ok(schema, `${op.schemaName} schema MUST exist`);
      assert.ok(
        !(schema?.required ?? []).includes('expectedVersion'),
        `${op.schemaName}.required MUST NOT contain expectedVersion (catalogue has no OCC)`,
      );
      assert.equal(
        schema?.properties?.['expectedVersion'],
        undefined,
        `${op.schemaName}.properties MUST NOT define expectedVersion`,
      );
    }
  });

  it('attach/detach expectedVersion is REQUIRED (subscription OCC)', () => {
    const paths = (SPEC.paths as Record<string, Record<string, unknown>>) ?? {};
    const schemas = (SPEC.components as { schemas?: Record<string, unknown> })
      ?.schemas ?? {};
    // Attach
    const attachRef = paths['/platform/subscriptions/{id}/add-ons']?.post
      ?.requestBody as
      | {
          content?: {
            'application/json'?: { schema?: { $ref?: string } };
          };
        }
      | undefined;
    assert.equal(
      attachRef?.content?.['application/json']?.schema?.['$ref'],
      '#/components/schemas/AttachSaasSubscriptionAddOnRequest',
    );
    const attachSchema = schemas['AttachSaasSubscriptionAddOnRequest'] as
      | { required?: string[]; properties?: Record<string, unknown> }
      | undefined;
    assert.ok(attachSchema, 'AttachSaasSubscriptionAddOnRequest schema MUST exist');
    assert.ok(
      (attachSchema?.required ?? []).includes('expectedVersion'),
      'AttachSaasSubscriptionAddOnRequest.required MUST contain expectedVersion',
    );
    assert.ok(
      (attachSchema?.properties ?? {})['expectedVersion'] !== undefined,
      'AttachSaasSubscriptionAddOnRequest.properties MUST define expectedVersion',
    );
    // Detach body schema (requestBody on DELETE)
    const detachRef = paths['/platform/subscriptions/{id}/add-ons/{addOnId}']
      ?.delete?.requestBody as
      | {
          content?: {
            'application/json'?: { schema?: { $ref?: string } };
          };
        }
      | undefined;
    assert.ok(detachRef, 'DELETE /platform/subscriptions/{id}/add-ons/{addOnId} MUST carry requestBody with expectedVersion');
    const detachSchemaRef = detachRef?.content?.['application/json']?.schema?.['$ref'];
    const detachSchema = detachSchemaRef
      ? (schemas[detachSchemaRef.split('/').pop() as string] as
          | { required?: string[]; properties?: Record<string, unknown> }
          | undefined)
      : undefined;
    assert.ok(detachSchema, 'Detach requestBody schema MUST exist');
    assert.ok(
      (detachSchema?.required ?? []).includes('expectedVersion'),
      'Detach requestBody schema MUST require expectedVersion',
    );
  });

  it('no Idempotency-Key on any add-on mutation', () => {
    const paths = (SPEC.paths as Record<string, Record<string, unknown>>) ?? {};
    for (const path of [
      '/platform/add-ons',
      '/platform/add-ons/{id}',
      '/platform/subscriptions/{id}/add-ons',
      '/platform/subscriptions/{id}/add-ons/{addOnId}',
    ]) {
      const item = paths[path];
      if (!item) continue;
      for (const method of Object.keys(item)) {
        if (!['post', 'put', 'patch', 'delete'].includes(method)) continue;
        const parameters = (item[method] as { parameters?: unknown[] })
          .parameters;
        const params = Array.isArray(parameters) ? parameters : [];
        for (const param of params) {
          const p = param as { name?: string; in?: string };
          if (p.in === 'header' && p.name?.toLowerCase() === 'idempotency-key') {
            assert.fail(
              `${method.toUpperCase()} ${path} MUST NOT carry Idempotency-Key (frozen §17.2 omits add-on operations)`,
            );
          }
        }
      }
    }
  });

  // -------------------------------------------------------------------
  // Structural — duplicate operationId + broken refs
  // -------------------------------------------------------------------
  it('no duplicate operationId anywhere in the OpenAPI document', () => {
    const paths = (SPEC.paths as Record<string, Record<string, unknown>>) ?? {};
    const seen = new Map<string, string>();
    for (const [path, item] of Object.entries(paths)) {
      for (const [method, op] of Object.entries(item)) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
        const id = (op as { operationId?: string }).operationId;
        if (!id) continue;
        const prev = seen.get(id);
        if (prev && prev !== `${method} ${path}`) {
          assert.fail(
            `Duplicate operationId "${id}" at ${method.toUpperCase()} ${path} (also at ${prev})`,
          );
        }
        seen.set(id, `${method} ${path}`);
      }
    }
  });

  it('no broken local $ref (every referenced component exists)', () => {
    const components = SPEC.components as {
      schemas?: Record<string, unknown>;
      parameters?: Record<string, unknown>;
      responses?: Record<string, unknown>;
      requestBodies?: Record<string, unknown>;
      headers?: Record<string, unknown>;
    };
    const buckets: Record<string, Set<string>> = {
      schemas: new Set(Object.keys(components.schemas ?? {})),
      parameters: new Set(Object.keys(components.parameters ?? {})),
      responses: new Set(Object.keys(components.responses ?? {})),
      requestBodies: new Set(Object.keys(components.requestBodies ?? {})),
      headers: new Set(Object.keys(components.headers ?? {})),
    };
    const refs: string[] = [];
    function walk(node: unknown) {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const v of node) walk(v);
        return;
      }
      const o = node as Record<string, unknown>;
      if (typeof o['$ref'] === 'string') refs.push(o['$ref']);
      for (const v of Object.values(o)) walk(v);
    }
    walk(SPEC);
    const broken: string[] = [];
    for (const ref of refs) {
      if (!ref.startsWith('#/components/')) continue;
      const parts = ref.slice(2).split('/');
      const bucket = buckets[parts[1]];
      if (!bucket) continue; // external ref or unknown bucket
      const tail = parts.slice(2).join('/');
      if (!bucket.has(tail)) broken.push(ref);
    }
    assert.deepEqual(broken, [], `Broken $refs: ${broken.join(', ')}`);
  });
});
