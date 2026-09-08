import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { FOUNDATION_PERMISSIONS } from '../src/database/seeds/foundation-access.seed';
import { api } from './helpers/http';

/**
 * CR-BE-MOB-03 PART 04 — Team-scoped Work Order read (TMW-04).
 *
 * Extends the existing BE-08 Work Order domain with a self-service
 * supervisor read (`GET /work-orders/team`) that derives the caller's team
 * from the authenticated session (linked ACTIVE BE-03C Workforce Profile's
 * `team_id`) and lists Work Orders whose ACTIVE BE-08E assignment targets
 * the team or one of its ACTIVE members, constrained to the caller's BE-02G
 * accessible Buildings.
 *
 * Focused contract checks (documentation-only, no database):
 *  - the new operation is published with the exact operationId, existing
 *    `work_order.read` permission and `x-building-scoped: true`;
 *  - the operation is registered in the existing work-orders router (no
 *    invented endpoint) and is an EXTENSION of that router — no new domain,
 *    no `/mobile/work-orders` facade, no duplicate operationId;
 *  - the response reuses the authoritative `WorkOrder` schema (existing BE-08
 *    ids/lifecycle — no new id, no projection);
 *  - team/user context is session-derived (no `teamId` / `workforceId` /
 *    `buildingId` request parameters — the only parameters are the same
 *    optional filters as `listBuildingWorkOrders`);
 *  - the documented permission is a REAL seeded code;
 *  - unauthenticated calls are rejected by auth middleware (401, never 404),
 *    and the literal `/work-orders/team` path is never shadowed by
 *    `/work-orders/:id` (still 401, not 400/404).
 */

const SPEC_PATH = resolve(__dirname, '../docs/api/openapi.yaml');
const API_PREFIX = '/api/v1';

const spec = parse(readFileSync(SPEC_PATH, 'utf8')) as any;

const WORK_ORDERS_MODULE = 'work-orders';

function toExpress(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ':$1');
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

const registered = registeredRoutes(WORK_ORDERS_MODULE);

describe('CR-BE-MOB-03 PART 04 — Team-scoped Work Order read', () => {
  it('publishes GET /work-orders/team with the correct operationId, permission and scope', () => {
    const op = spec.paths?.['/work-orders/team']?.get;
    assert.ok(op, 'GET /work-orders/team must exist in OpenAPI');
    assert.equal(op.operationId, 'listTeamWorkOrders');
    assert.ok((op.tags ?? []).includes('Work Orders'));
    assert.equal(op['x-required-permission'], 'work_order.read');
    assert.equal(op['x-building-scoped'], true);
    assert.ok(
      (op.security ?? []).some((s: Record<string, unknown>) => 'bearerAuth' in s),
      'must require bearer auth',
    );
  });

  it('is an extension of the existing BE-08 router — documented and registered, no new domain', () => {
    // Documented ⊆ registered.
    assert.ok(
      registered.has('get /work-orders/team'),
      'GET /work-orders/team must be registered in the work-orders router',
    );
    // No /mobile/work-orders facade.
    const mobile: string[] = [];
    for (const p of Object.keys(spec.paths ?? {})) {
      if (p.startsWith('/mobile/work-orders')) mobile.push(p);
    }
    assert.deepEqual(mobile, [], 'no /mobile/work-orders facade may exist');
    // No duplicate operationId anywhere.
    const allOpIds = new Set<string>();
    const duplicates: string[] = [];
    for (const [p, methods] of Object.entries<any>(spec.paths ?? {})) {
      for (const [m, op] of Object.entries<any>(methods)) {
        if (!op?.operationId) continue;
        if (allOpIds.has(op.operationId)) duplicates.push(`${op.operationId} (${p})`);
        allOpIds.add(op.operationId);
      }
    }
    assert.deepEqual(duplicates, [], 'no duplicate operationId may exist');
  });

  it('preserves authoritative IDs — the response reuses the existing WorkOrder schema', () => {
    const op = spec.paths?.['/work-orders/team']?.get;
    const schema = op?.responses?.['200']?.content?.['application/json']?.schema;
    const data = schema?.allOf?.find(
      (s: { properties?: Record<string, unknown> }) => s?.properties?.data,
    );
    assert.ok(data, 'response data must be described');
    assert.equal(
      data.properties.data.items.$ref,
      '#/components/schemas/WorkOrder',
      'must reuse the authoritative WorkOrder schema (BE-08 ids, no new id)',
    );
    // The WorkOrder schema must not carry any fabricated local id.
    const woSchema = JSON.stringify(spec.components.schemas.WorkOrder ?? {});
    for (const forbidden of ['localId', 'tempId', 'clientGeneratedId']) {
      assert.ok(!woSchema.includes(forbidden), `${forbidden} must not appear`);
    }
  });

  it('derives team/user context from the session — no caller-supplied scope parameters', () => {
    const op = spec.paths?.['/work-orders/team']?.get;
    const params = op?.parameters ?? [];
    const names = params.map((p: { name?: string }) => p?.name ?? '');
    assert.deepEqual(
      names.sort(),
      ['status', 'workRequestId', 'workType'],
      'only the existing optional WorkOrderFilters are accepted — no teamId/workforceId/buildingId from the caller',
    );
  });

  it('preserves RBAC with a REAL seeded permission code', () => {
    const seeded = new Set(FOUNDATION_PERMISSIONS.map((p) => p.code));
    const op = spec.paths?.['/work-orders/team']?.get;
    assert.ok(seeded.has(op['x-required-permission']), 'work_order.read must be seeded');
  });

  it('documents authentication and the standard failure responses', () => {
    const op = spec.paths?.['/work-orders/team']?.get;
    assert.ok(op.responses?.['401'], '401 must be documented');
    assert.ok(op.responses?.['403'], '403 must be documented');
  });

  it('rejects unauthenticated requests with 401, never 404 (and is not shadowed by /work-orders/:id)', async () => {
    const request = api();
    const response = await request.get(`${API_PREFIX}/work-orders/team`);
    assert.notEqual(
      response.status,
      404,
      'GET /work-orders/team is documented but not registered (got 404)',
    );
    assert.notEqual(
      response.status,
      400,
      'GET /work-orders/team must not be captured by /work-orders/:id (got 400)',
    );
    assert.equal(response.status, 401, 'must require authentication');
    assert.equal(response.body.error.code, 'AUTHENTICATION_REQUIRED');
  });
});
