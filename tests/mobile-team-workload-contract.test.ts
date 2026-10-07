import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { FOUNDATION_PERMISSIONS } from '../src/database/seeds/foundation-access.seed';
import { api } from './helpers/http';

/**
 * CR-BE-MOB-03 PART 01 — Workforce team workload & status contract.
 *
 * Documentation-only checks (no database):
 *  - the five existing BE-03F / BE-03I2 / BE-23G reads are published with
 *    their exact operationIds, methods, permissions and (where enforced)
 *    Building scope;
 *  - the published surface is ⊆ the routes actually registered in the three
 *    workforce modules (no invented endpoint);
 *  - the BE-23G KPI + BE-03I2 reporting reads carry `x-building-scoped: true`
 *    (BE-02G enforced in the service/controller);
 *  - the BE-03F reporting-line reads are documented WITHOUT a building-scope
 *    claim — they are profile-resolved (404 on unknown profile) and carry no
 *    BE-02G gate today, so the contract must not advertise one;
 *  - every documented permission exists in the seeded permission catalogue
 *    (`workforce.read` registered by this PART, `workforce_kpi.read` already
 *    seeded);
 *  - no `/mobile/*` duplicate facade was created;
 *  - unauthenticated calls are rejected by auth middleware (401, never 404).
 */

const SPEC_PATH = resolve(__dirname, '../docs/api/openapi.yaml');
const API_PREFIX = '/api/v1';

const spec = parse(readFileSync(SPEC_PATH, 'utf8')) as any;

/** PART 01 published surface: path → { method, operationId, permission, scoped }. */
const PUBLISHED: Record<
  string,
  { method: string; operationId: string; permission: string; scoped: boolean }
> = {
  '/workforce/reports/kpi': {
    method: 'get',
    operationId: 'getWorkforceKpi',
    permission: 'workforce_kpi.read',
    scoped: true,
  },
  '/workforce/reporting': {
    method: 'get',
    operationId: 'listWorkforceReporting',
    permission: 'workforce.read',
    scoped: true,
  },
  '/workforce/reporting/{id}': {
    method: 'get',
    operationId: 'getWorkforceReporting',
    permission: 'workforce.read',
    scoped: true,
  },
  '/workforce/{workforceId}/supervisor': {
    method: 'get',
    operationId: 'getWorkforceCurrentSupervisor',
    permission: 'workforce.read',
    scoped: false,
  },
  '/workforce/{supervisorId}/direct-reports': {
    method: 'get',
    operationId: 'listWorkforceDirectReports',
    permission: 'workforce.read',
    scoped: false,
  },
};

/** Modules touched by PART 01 (read routes live here). */
const WORKFORCE_MODULES = [
  'workforce-kpi',
  'workforce-reporting',
  'workforce-reporting-lines',
];

function toExpress(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ':$1');
}

/** Collapses param names so `:id` and `{id}` compare equal. */
function canonical(route: string): string {
  return route.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':p');
}

function registeredRoutes(moduleDir: string): Set<string> {
  const dir = resolve(__dirname, '../src/modules', moduleDir);
  const routes = new Set<string>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.routes.ts')) continue;
    const source = readFileSync(join(dir, file), 'utf8');
    const pattern = /router\.(get|post|patch|put|delete)\(\s*'([^']+)'/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      routes.add(`${match[1]} ${match[2]}`);
    }
  }
  return routes;
}

const registered = new Set<string>();
for (const module of WORKFORCE_MODULES) {
  for (const route of registeredRoutes(module)) {
    registered.add(canonical(route));
  }
}

describe('CR-BE-MOB-03 PART 01 — Workforce team workload & status contract', () => {
  it('publishes exactly the five existing read operations with correct ids', () => {
    for (const [path, expected] of Object.entries(PUBLISHED)) {
      const op = spec.paths?.[path]?.[expected.method];
      assert.ok(op, `${expected.method.toUpperCase()} ${path} must exist in OpenAPI`);
      assert.equal(op.operationId, expected.operationId);
      assert.deepEqual(op.tags ?? [], ['Workforce']);
      assert.ok(
        (spec.tags ?? []).some((t: { name: string }) => t.name === 'Workforce'),
        'the Workforce tag must be declared',
      );
    }
    // No other operation may carry the Workforce tag (the surface is frozen).
    const tagged: string[] = [];
    for (const [p, methods] of Object.entries<any>(spec.paths ?? {})) {
      for (const [m, op] of Object.entries<any>(methods)) {
        if ((op.tags ?? []).includes('Workforce')) {
          tagged.push(`${m.toUpperCase()} ${p}`);
        }
      }
    }
    const expected = Object.entries(PUBLISHED).map(
      ([p, v]) => `${v.method.toUpperCase()} ${p}`,
    );
    assert.deepEqual(tagged.sort(), expected.sort());
  });

  it('documents only operations the routers actually register', () => {
    const phantom: string[] = [];
    for (const [path, expected] of Object.entries(PUBLISHED)) {
      const key = canonical(`${expected.method} ${toExpress(path)}`);
      if (!registered.has(key)) phantom.push(`${expected.method.toUpperCase()} ${path}`);
    }
    assert.deepEqual(phantom, [], 'no invented endpoint may be published');
  });

  it('documents Building scope exactly as enforced', () => {
    const wronglyScoped: string[] = [];
    const wronglyUnscoped: string[] = [];
    for (const [path, expected] of Object.entries(PUBLISHED)) {
      const op = spec.paths[path][expected.method];
      const actual = op['x-building-scoped'] === true;
      if (expected.scoped && !actual) {
        wronglyUnscoped.push(`${expected.method.toUpperCase()} ${path}`);
      }
      if (!expected.scoped && actual) {
        wronglyScoped.push(`${expected.method.toUpperCase()} ${path}`);
      }
    }
    assert.deepEqual(wronglyUnscoped, [], 'BE-02G-scoped reads must carry x-building-scoped: true');
    assert.deepEqual(
      wronglyScoped,
      [],
      'the BE-03F reporting-line reads carry no BE-02G gate and must not claim x-building-scoped',
    );
  });

  it('preserves RBAC with REAL seeded permission codes', () => {
    const seeded = new Set(FOUNDATION_PERMISSIONS.map((p) => p.code));
    const unknown: string[] = [];
    const missing: string[] = [];
    for (const [path, expected] of Object.entries(PUBLISHED)) {
      const op = spec.paths[path][expected.method];
      const code = op['x-required-permission'];
      if (!code) missing.push(`${expected.method.toUpperCase()} ${path}`);
      else if (!seeded.has(code)) unknown.push(`${expected.operationId} -> ${code}`);
      assert.equal(code, expected.permission, `${path} must require ${expected.permission}`);
    }
    assert.deepEqual(missing, [], 'every published operation records a permission');
    assert.deepEqual(unknown, [], 'a documented permission must exist in the seeded permission catalogue');
    assert.ok(seeded.has('workforce.read'), 'workforce.read must be seeded (registered by PART 01)');
    assert.ok(seeded.has('workforce_kpi.read'), 'workforce_kpi.read must be seeded');
  });

  it('documents authentication and the standard failure responses', () => {
    const bad: string[] = [];
    for (const [path, expected] of Object.entries(PUBLISHED)) {
      const op = spec.paths[path][expected.method];
      const hasBearer = (op.security ?? []).some(
        (s: Record<string, unknown>) => 'bearerAuth' in s,
      );
      if (!hasBearer || !op.responses?.['401'] || !op.responses?.['403']) {
        bad.push(`${expected.method.toUpperCase()} ${path}`);
      }
    }
    assert.deepEqual(bad, []);
  });

  it('creates no /mobile/{domain} duplicate facade', () => {
    const mobile: string[] = [];
    for (const [path, expected] of Object.entries(PUBLISHED)) {
      if (path.startsWith('/mobile/')) mobile.push(path);
      const op = spec.paths[path][expected.method];
      for (const [p, methods] of Object.entries<any>(spec.paths ?? {})) {
        if (!p.startsWith('/mobile/')) continue;
        for (const [m, candidate] of Object.entries<any>(methods)) {
          if (candidate.operationId === expected.operationId) {
            mobile.push(`${p} (duplicate operationId of ${path})`);
          }
        }
      }
    }
    assert.deepEqual(mobile, [], 'no mobile facade and no duplicate operationId may exist');
  });

  it('rejects unauthenticated requests with 401, never 404', async () => {
    const request = api();
    const samples: Array<{ method: 'get'; path: string }> = [
      { method: 'get', path: '/workforce/reports/kpi' },
      { method: 'get', path: '/workforce/reporting' },
      { method: 'get', path: '/workforce/reporting/00000000-0000-4000-8000-000000000001' },
      { method: 'get', path: '/workforce/00000000-0000-4000-8000-000000000001/supervisor' },
      { method: 'get', path: '/workforce/00000000-0000-4000-8000-000000000001/direct-reports' },
    ];
    for (const { path } of samples) {
      const response = await request.get(`${API_PREFIX}${path}`);
      assert.notEqual(
        response.status,
        404,
        `GET ${path} is documented but not registered (got 404)`,
      );
      assert.equal(response.status, 401, `${path} must require authentication`);
      assert.equal(response.body.error.code, 'AUTHENTICATION_REQUIRED');
    }
  });
});
