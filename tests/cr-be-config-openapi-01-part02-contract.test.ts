import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { FOUNDATION_PERMISSIONS } from '../src/database/seeds/foundation-access.seed';

/**
 * CR-BE-CONFIG-OPENAPI-01 PART 02 — remaining configuration master contract.
 *
 * Focused, documentation-only route-vs-OpenAPI check for the seven domains
 * reconciled by this part of the CR (vendor master, compliance, asset
 * category, asset type, utility type configuration, form template version,
 * finding classification, finding severity). No database, no HTTP server, no
 * runtime behaviour: the test proves the published contract and the
 * registered routers agree, in both directions.
 *
 *   forward  — every route registered by the fourteen domain route files is
 *              published with its exact method, path, permission and
 *              Building-scope flag;
 *   reverse  — every operation published for those domains corresponds to a
 *              route that actually exists (nothing was invented);
 *   hygiene  — every operationId is present and unique, every published
 *              permission is a real seeded catalogue code, the shared
 *              envelope/request-id contract is reused, and the PART 01
 *              organization/workforce contract is untouched.
 */

const SPEC_PATH = resolve(__dirname, '../docs/api/openapi.yaml');

const spec = parse(readFileSync(SPEC_PATH, 'utf8')) as any;

/** Route files whose registered routes this CR part reconciles. */
const DOMAIN_ROUTE_FILES = [
  'src/modules/vendors/vendor.routes.ts',
  'src/modules/vendor-categories/vendor-category.routes.ts',
  'src/modules/vendor-pics/vendor-pic.routes.ts',
  'src/modules/vendor-buildings/vendor-building.routes.ts',
  'src/modules/vendor-capabilities/vendor-capability.routes.ts',
  'src/modules/vendor-workforce/vendor-workforce.routes.ts',
  'src/modules/vendor-compliance-documents/vendor-compliance-document.routes.ts',
  'src/modules/vendor-licenses/vendor-license.routes.ts',
  'src/modules/asset-categories/asset-category.routes.ts',
  'src/modules/asset-types/asset-type.routes.ts',
  'src/modules/utility-type-configurations/utility-type-configuration.routes.ts',
  'src/modules/form-template-versions/form-template-version.routes.ts',
  'src/modules/finding-classifications/finding-classification.routes.ts',
  'src/modules/finding-severities/finding-severity.routes.ts',
];

/** Path keys this CR part publishes — every one of them is new. */
const PUBLISHED_PATH_KEYS = [
  '/clients/{clientId}/vendors',
  '/vendors/{id}',
  '/clients/{clientId}/vendor-categories',
  '/vendor-categories/{id}',
  '/vendors/{vendorId}/pics',
  '/vendor-pics/{id}',
  '/vendors/{vendorId}/buildings',
  '/buildings/{buildingId}/vendors',
  '/vendors/{vendorId}/buildings/{buildingId}',
  '/vendors/{vendorId}/capabilities',
  '/vendor-capabilities/{id}',
  '/vendors/{vendorId}/workforce',
  '/workforce/{workforceId}/vendor-bindings',
  '/vendors/{vendorId}/workforce/{workforceId}',
  '/vendors/{vendorId}/compliance-documents',
  '/vendor-compliance-documents/{id}',
  '/vendors/{vendorId}/licenses-certifications',
  '/vendors/{vendorId}/licenses-certifications/current',
  '/vendors/{vendorId}/licenses-certifications/{id}',
  '/clients/{clientId}/asset-categories',
  '/asset-categories/{id}',
  '/asset-categories/{categoryId}/types',
  '/asset-types/{id}',
  '/clients/{clientId}/utility-type-configurations',
  '/utility/type-configurations/{id}',
  '/utility/type-configurations/{id}/status',
  '/utility/type-configurations/{id}/uoms',
  '/utility/type-configurations/{id}/uoms/{uomId}',
  '/form-templates/{templateId}/versions',
  '/form-template-versions/{id}',
  '/form-template-versions/{id}/publish',
  '/form-template-versions/{id}/retire',
  '/clients/{clientId}/finding-classifications',
  '/finding-classifications/{id}',
  '/clients/{clientId}/finding-severities',
  '/finding-severities/{id}',
];

/** operationIds that PART 01 published and this part must not disturb. */
const PART_01_OPERATION_IDS: Array<[string, string, string]> = [
  ['listWorkforceReporting', '/workforce/reporting', 'get'],
  ['getWorkforceReporting', '/workforce/reporting/{id}', 'get'],
  ['getWorkforceCurrentSupervisor', '/workforce/{workforceId}/supervisor', 'get'],
  ['assignWorkforceSupervisor', '/workforce/{workforceId}/supervisor', 'post'],
  ['updateWorkforceReportingLine', '/workforce/{workforceId}/supervisor', 'patch'],
];

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

type RegisteredRoute = {
  method: string;
  /** Express path, e.g. `/vendors/:vendorId/pics`. */
  expressPath: string;
  /** OpenAPI path key, e.g. `/vendors/{vendorId}/pics`. */
  openapiPath: string;
  permission: string;
  buildingScoped: boolean;
  file: string;
};

function toOpenApiPath(expressPath: string): string {
  return expressPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

/**
 * Extracts the routes registered by the domain routers.
 *
 * The route files use two styles — multi-line `router.post(` calls and the
 * minified `r.post('...',a,m,handler)` form — and three permission styles:
 * inline `requirePermission('x')`, and local `const`/chained aliases such as
 * `manage` or `m`. Aliases are resolved from the file they are declared in.
 */
function extractRegisteredRoutes(): RegisteredRoute[] {
  const out: RegisteredRoute[] = [];

  for (const relative of DOMAIN_ROUTE_FILES) {
    const source = readFileSync(resolve(__dirname, '..', relative), 'utf8');

    const aliases = new Map<string, string>();
    for (const match of source.matchAll(
      /([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*requirePermission\(\s*'([^']+)'\s*\)/g,
    )) {
      aliases.set(match[1], match[2]);
    }

    const starts = [
      ...source.matchAll(/\b(?:router|r)\.(get|post|put|patch|delete)\(\s*'([^']+)'/g),
    ];

    starts.forEach((head, index) => {
      const chunk = source.slice(
        head.index,
        index + 1 < starts.length ? starts[index + 1].index : source.length,
      );

      const inline = /requirePermission\(\s*'([^']+)'\s*\)/.exec(chunk);
      let permission = inline?.[1];
      if (!permission) {
        for (const [alias, code] of aliases) {
          if (new RegExp(`[,(\\s]${alias}[,)\\s]`).test(chunk)) {
            permission = code;
            break;
          }
        }
      }

      assert.ok(
        permission,
        `every route in ${relative} must declare requirePermission(): ${head[2]}`,
      );

      out.push({
        method: head[1],
        expressPath: head[2],
        openapiPath: toOpenApiPath(head[2]),
        permission,
        buildingScoped: /requireBuildingAccess\(/.test(chunk),
        file: relative,
      });
    });
  }

  return out;
}

const registered = extractRegisteredRoutes();

function publishedOperation(path: string, method: string): any {
  return spec.paths?.[path]?.[method];
}

describe('CR-BE-CONFIG-OPENAPI-01 PART 02 — remaining configuration master contract', () => {
  it('registers the five reconciled configuration domains (60 operations)', () => {
    assert.ok(
      registered.length >= 60,
      `expected at least 60 registered routes, extracted ${registered.length}`,
    );

    // The vendor master surface alone accounts for 32 of them; a broken
    // extractor would show up as a much smaller number.
    const byFile = new Map<string, number>();
    for (const route of registered) {
      byFile.set(route.file, (byFile.get(route.file) ?? 0) + 1);
    }
    assert.equal(byFile.size, DOMAIN_ROUTE_FILES.length, 'every domain file must yield routes');
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

  it('marks exactly one operation as Building-scoped', () => {
    const scoped: string[] = [];
    for (const path of PUBLISHED_PATH_KEYS) {
      for (const [method, op] of Object.entries<any>(spec.paths[path])) {
        if (!HTTP_METHODS.includes(method)) continue;
        if (op['x-building-scoped'] === true) scoped.push(`${method.toUpperCase()} ${path}`);
      }
    }
    assert.deepEqual(scoped, ['GET /buildings/{buildingId}/vendors']);
  });

  it('publishes nothing that is not registered (reverse)', () => {
    const runtime = new Set(
      registered.map((route) => `${route.method} ${route.openapiPath}`),
    );

    let published = 0;
    for (const path of PUBLISHED_PATH_KEYS) {
      const item = spec.paths?.[path];
      assert.ok(item, `path key ${path} must be published`);

      for (const [method, op] of Object.entries<any>(item)) {
        if (!HTTP_METHODS.includes(method)) continue;
        published += 1;
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

    assert.equal(published, 60, 'this part publishes exactly 60 operations');
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

    // The Workforce-side binding read intentionally reuses `workforce.read`.
    const expected = new Set([
      'vendor.read',
      'vendor.manage',
      'asset_category.read',
      'asset_category.manage',
      'asset_type.read',
      'asset_type.manage',
      'utility_meter.read',
      'utility_meter.manage',
      'form_template.read',
      'form_template.manage',
      'finding.read',
      'finding.manage',
      'workforce.read',
    ]);

    for (const route of registered) {
      assert.ok(
        expected.has(route.permission),
        `${route.file} uses unexpected permission ${route.permission}`,
      );
      assert.ok(
        seeded.has(route.permission),
        `${route.permission} must be registered in the foundation access seed`,
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
    // The BE-18A utility type enum is reused rather than re-declared.
    assert.deepEqual(spec.components.schemas.UtilityType.enum, [
      'ELECTRICITY',
      'WATER',
      'GAS',
    ]);

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

  it('documents 201 for creates and 200 for every other operation', () => {
    for (const route of registered) {
      const op = publishedOperation(route.openapiPath, route.method);
      const expected = route.method === 'post' && !/\/publish$|\/retire$/.test(route.expressPath)
        ? '201'
        : '200';
      assert.ok(
        op.responses[expected],
        `${route.method.toUpperCase()} ${route.openapiPath} must document ${expected}`,
      );
    }
  });

  it('keeps every PART 01 operation unpublish-changed', () => {
    for (const [operationId, path, method] of PART_01_OPERATION_IDS) {
      const op = spec.paths?.[path]?.[method];
      assert.ok(op, `${method.toUpperCase()} ${path} must still be published (PART 01)`);
      assert.equal(
        op.operationId,
        operationId,
        `${method.toUpperCase()} ${path} must keep operationId ${operationId}`,
      );
    }

    // PART 01 path keys must all still resolve.
    for (const path of [
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
      '/workforce-profiles/{id}',
    ]) {
      assert.ok(spec.paths[path], `PART 01 path key ${path} must still be published`);
    }
  });

  it('declares the eight new configuration tags', () => {
    const names = new Set((spec.tags ?? []).map((tag: any) => tag.name));
    for (const tag of [
      'Vendor Master',
      'Vendor Compliance',
      'Asset Category',
      'Asset Type',
      'Utility Type Configuration',
      'Form Template Version',
      'Finding Classification',
      'Finding Severity',
    ]) {
      assert.ok(names.has(tag), `tag ${tag} must be declared`);
    }

    for (const path of PUBLISHED_PATH_KEYS) {
      for (const [method, op] of Object.entries<any>(spec.paths[path])) {
        if (!HTTP_METHODS.includes(method)) continue;
        assert.ok(
          Array.isArray(op.tags) && op.tags.length === 1 && names.has(op.tags[0]),
          `${method.toUpperCase()} ${path} must carry exactly one declared tag`,
        );
      }
    }
  });

  it('has no broken local $ref left by the splice', () => {
    const refs: string[] = [];
    const walk = (node: any): void => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      for (const [key, value] of Object.entries<any>(node)) {
        if (key === '$ref' && typeof value === 'string' && value.startsWith('#/')) {
          refs.push(value);
        } else {
          walk(value);
        }
      }
    };
    walk(spec);

    const broken = [...new Set(refs)].filter((ref) => {
      const parts = ref
        .slice(2)
        .split('/')
        .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
      let current: any = spec;
      for (const part of parts) {
        if (current && typeof current === 'object' && part in current) {
          current = current[part];
        } else {
          return true;
        }
      }
      return false;
    });

    assert.deepEqual(broken, [], `broken local refs: ${broken.join(', ')}`);
  });
});
