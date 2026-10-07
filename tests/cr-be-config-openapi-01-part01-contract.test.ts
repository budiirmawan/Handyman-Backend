import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { FOUNDATION_PERMISSIONS } from '../src/database/seeds/foundation-access.seed';

/**
 * CR-BE-CONFIG-OPENAPI-01 PART 01 — Organization & Workforce admin contract.
 *
 * Focused, documentation-only route-vs-OpenAPI check for the seven domains
 * reconciled by this CR. No database, no HTTP server, no runtime behaviour:
 * the test proves the published contract and the registered routers agree, in
 * both directions.
 *
 *   forward  — every route registered by the eight domain route files is
 *              published with its exact method, path, permission and
 *              Building-scope flag;
 *   reverse  — every operation published for those domains corresponds to a
 *              route that actually exists (nothing was invented);
 *   hygiene  — every operationId is present and unique, every published
 *              permission is a real seeded catalogue code, and the shared
 *              request-id header contract is untouched.
 */

const SPEC_PATH = resolve(__dirname, '../docs/api/openapi.yaml');

const spec = parse(readFileSync(SPEC_PATH, 'utf8')) as any;

/** Route files whose registered routes this CR reconciles. */
const DOMAIN_ROUTE_FILES = [
  'src/modules/organizations/organization.routes.ts',
  'src/modules/departments/department.routes.ts',
  'src/modules/positions/position.routes.ts',
  'src/modules/teams/team.routes.ts',
  'src/modules/shifts/shift.routes.ts',
  'src/modules/skills/skill.routes.ts',
  'src/modules/workforce/workforce.routes.ts',
  'src/modules/workforce-skills/workforce-skill.routes.ts',
  'src/modules/workforce-shifts/workforce-shift.routes.ts',
  'src/modules/workforce-building-assignments/workforce-building-assignment.routes.ts',
  'src/modules/workforce-reporting-lines/workforce-reporting-line.routes.ts',
  'src/modules/external-workforce/external-workforce.routes.ts',
];

/**
 * Path keys this CR publishes. `/workforce/{workforceId}/supervisor` already
 * existed for its GET operation; this CR completes it with POST and PATCH.
 */
const PUBLISHED_PATH_KEYS = [
  '/organizations',
  '/organizations/{id}',
  '/departments',
  '/departments/{id}',
  '/departments/{departmentId}/teams',
  '/teams/{id}',
  '/organizations/{organizationId}/positions',
  '/departments/{departmentId}/positions',
  '/positions/{id}',
  '/clients/{clientId}/skills',
  '/skills/{id}',
  '/buildings/{buildingId}/shifts',
  '/shifts/{id}',
  '/organizations/{organizationId}/workforce-profiles',
  '/departments/{departmentId}/workforce-profiles',
  '/teams/{teamId}/workforce-profiles',
  '/workforce-profiles/{id}',
  '/workforce/{workforceId}/skills',
  '/workforce/{workforceId}/skills/effective',
  '/workforce/{workforceId}/skills/{skillId}',
  '/workforce/{workforceId}/shifts',
  '/workforce/{workforceId}/shifts/{shiftId}',
  '/workforce/{workforceId}/buildings',
  '/buildings/{buildingId}/workforce',
  '/workforce/{workforceId}/buildings/{buildingId}',
  '/workforce/{workforceId}/supervisor',
  '/workforce/{workforceId}/external-affiliations',
  '/workforce/{workforceId}/external-affiliations/{externalOrganizationId}',
  '/external-organizations/{externalOrganizationId}/workforce',
];

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

type RegisteredRoute = {
  method: string;
  /** Express path, e.g. `/organizations/:organizationId/positions`. */
  expressPath: string;
  /** OpenAPI path key, e.g. `/organizations/{organizationId}/positions`. */
  openapiPath: string;
  permission: string;
  buildingScoped: boolean;
  file: string;
};

function toOpenApiPath(expressPath: string): string {
  return expressPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

/** Extracts `router.<method>('<path>', ..., requirePermission(...), ...)`. */
function extractRegisteredRoutes(): RegisteredRoute[] {
  const out: RegisteredRoute[] = [];

  for (const relative of DOMAIN_ROUTE_FILES) {
    const source = readFileSync(resolve(__dirname, '..', relative), 'utf8');
    const chunks = source.split(/\brouter\./).slice(1);

    for (const chunk of chunks) {
      const head = /^(get|post|put|patch|delete)\(\s*'([^']+)'/.exec(chunk);
      if (!head) continue;

      const permission = /requirePermission\(\s*'([^']+)'\s*\)/.exec(chunk);
      assert.ok(
        permission,
        `every route in ${relative} must declare requirePermission(): ${head[2]}`,
      );

      out.push({
        method: head[1],
        expressPath: head[2],
        openapiPath: toOpenApiPath(head[2]),
        permission: permission[1],
        buildingScoped: /requireBuildingAccess\(/.test(chunk),
        file: relative,
      });
    }
  }

  return out;
}

const registered = extractRegisteredRoutes();

function publishedOperation(path: string, method: string): any {
  return spec.paths?.[path]?.[method];
}

describe('CR-BE-CONFIG-OPENAPI-01 PART 01 — organization & workforce admin contract', () => {
  it('registers at least the seven reconciled domains', () => {
    // Guards against a silently broken extractor: the eight route files must
    // yield a substantial, non-empty surface.
    assert.ok(
      registered.length >= 47,
      `expected at least 47 registered routes, extracted ${registered.length}`,
    );
  });

  it('publishes every registered domain route with its exact permission (forward)', () => {
    for (const route of registered) {
      const op = publishedOperation(route.openapiPath, route.method);
      assert.ok(
        op,
        `${route.method.toUpperCase()} ${route.expressPath} is registered in ${route.file} but is NOT published in OpenAPI`,
      );
      assert.equal(
        op['x-required-permission'],
        route.permission,
        `${route.method.toUpperCase()} ${route.openapiPath} must require ${route.permission}`,
      );
      assert.deepEqual(
        op.security,
        [{ bearerAuth: [] }],
        `${route.method.toUpperCase()} ${route.openapiPath} must require the bearer session`,
      );
      if (route.buildingScoped) {
        assert.equal(
          op['x-building-scoped'],
          true,
          `${route.method.toUpperCase()} ${route.openapiPath} passes requireBuildingAccess and must be marked x-building-scoped`,
        );
      } else {
        assert.notEqual(
          op['x-building-scoped'],
          true,
          `${route.method.toUpperCase()} ${route.openapiPath} has no requireBuildingAccess and must not claim x-building-scoped`,
        );
      }
    }
  });

  it('publishes nothing that is not registered (reverse)', () => {
    const runtime = new Set(
      registered.map((route) => `${route.method} ${route.openapiPath}`),
    );

    for (const path of PUBLISHED_PATH_KEYS) {
      const item = spec.paths?.[path];
      assert.ok(item, `path key ${path} must be published`);

      for (const [method, op] of Object.entries<any>(item)) {
        if (!HTTP_METHODS.includes(method)) continue;
        assert.ok(
          runtime.has(`${method} ${path}`),
          `${method.toUpperCase()} ${path} is published but no runtime route matches it`,
        );
        assert.ok(
          typeof op.operationId === 'string' && op.operationId.length > 0,
          `${method.toUpperCase()} ${path} must declare an operationId`,
        );
      }
    }
  });

  it('declares unique operationIds across the whole contract', () => {
    const seen = new Map<string, string>();

    for (const [path, item] of Object.entries<any>(spec.paths ?? {})) {
      for (const [method, op] of Object.entries<any>(item)) {
        if (!HTTP_METHODS.includes(method)) continue;
        if (op.operationId === undefined) continue; // pre-existing SLA gap
        const where = `${method.toUpperCase()} ${path}`;
        assert.ok(
          !seen.has(op.operationId),
          `duplicate operationId ${op.operationId} on ${where} and ${seen.get(op.operationId)}`,
        );
        seen.set(op.operationId, where);
      }
    }
  });

  it('uses only real seeded catalogue permissions', () => {
    const seeded = new Set(FOUNDATION_PERMISSIONS.map((entry) => entry.code));

    for (const path of PUBLISHED_PATH_KEYS) {
      for (const [method, op] of Object.entries<any>(spec.paths[path])) {
        if (!HTTP_METHODS.includes(method)) continue;
        const permission = op['x-required-permission'];
        assert.ok(
          seeded.has(permission),
          `${method.toUpperCase()} ${path} requires ${permission}, which is not a seeded permission code`,
        );
      }
    }
  });

  it('names exactly the permissions registered by CR-BE-CONFIG-PERM-01', () => {
    const expected = new Set([
      'organization.read',
      'organization.manage',
      'department.read',
      'department.manage',
      'position.read',
      'position.manage',
      'team.read',
      'team.manage',
      'shift.read',
      'shift.manage',
      'skill.read',
      'skill.manage',
      'workforce.read',
      'workforce.manage',
    ]);

    for (const route of registered) {
      assert.ok(
        expected.has(route.permission),
        `${route.file} uses unexpected permission ${route.permission}`,
      );
    }
    for (const permission of expected) {
      assert.ok(
        FOUNDATION_PERMISSIONS.some((entry) => entry.code === permission),
        `${permission} must be registered in the foundation access seed`,
      );
    }
  });

  it('reuses the shared envelope, error and request-id components', () => {
    assert.ok(spec.components.schemas.SuccessEnvelope, 'SuccessEnvelope must exist');
    assert.ok(spec.components.schemas.ErrorEnvelope, 'ErrorEnvelope must exist');
    assert.equal(spec.components.headers.RequestId.required, true);
    assert.match(
      spec.components.headers.RequestId.description,
      /never taken from a caller/i,
    );

    for (const path of PUBLISHED_PATH_KEYS) {
      for (const [method, op] of Object.entries<any>(spec.paths[path])) {
        if (!HTTP_METHODS.includes(method)) continue;
        const success = Object.entries<any>(op.responses).find(
          ([status]) => status.startsWith('2'),
        );
        assert.ok(success, `${method.toUpperCase()} ${path} must declare a 2xx response`);
        assert.deepEqual(
          success[1].content['application/json'].schema.allOf[0],
          { $ref: '#/components/schemas/SuccessEnvelope' },
          `${method.toUpperCase()} ${path} must use the shared SuccessEnvelope`,
        );
        assert.ok(
          op.responses['400'],
          `${method.toUpperCase()} ${path} must document the canonical 400`,
        );
        assert.ok(
          op.responses['401'],
          `${method.toUpperCase()} ${path} must document the canonical 401`,
        );
      }
    }
  });

  it('does not rename or remove any pre-existing operationId', () => {
    // The four operations of the pre-existing Workforce block that PART 01
    // completes must survive untouched.
    const preserved: Record<string, [string, string]> = {
      listWorkforceReporting: ['/workforce/reporting', 'get'],
      getWorkforceReporting: ['/workforce/reporting/{id}', 'get'],
      getWorkforceCurrentSupervisor: ['/workforce/{workforceId}/supervisor', 'get'],
      listWorkforceDirectReports: ['/workforce/{supervisorId}/direct-reports', 'get'],
    };

    for (const [operationId, [path, method]] of Object.entries(preserved)) {
      const op = spec.paths?.[path]?.[method];
      if (!op) continue; // covered by the reporting-api test when present
      assert.equal(
        op.operationId,
        operationId,
        `${method.toUpperCase()} ${path} must keep operationId ${operationId}`,
      );
    }

    const supervisor = spec.paths['/workforce/{workforceId}/supervisor'];
    assert.equal(supervisor.get.operationId, 'getWorkforceCurrentSupervisor');
    assert.equal(supervisor.post.operationId, 'assignWorkforceSupervisor');
    assert.equal(supervisor.patch.operationId, 'updateWorkforceReportingLine');
  });
});
