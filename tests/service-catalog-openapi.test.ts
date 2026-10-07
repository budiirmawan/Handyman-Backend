import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';

/**
 * CR-BE-SVC-01 PART 06 — OpenAPI closure for the Service Catalog surface.
 *
 * Pins that docs/api/openapi.yaml documents the governed Service Catalog API
 * (PART 01) with the runtime permission boundary and request/response
 * vocabulary, and that the routes are really registered. Database-free.
 */

const spec = parse(
  readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8'),
) as any;
const routes = readFileSync(
  resolve(__dirname, '../src/modules/service-catalog/service-catalog.routes.ts'),
  'utf8',
);

describe('CR-BE-SVC-01 PART 06 — Service Catalog OpenAPI completeness', () => {
  it('documents the complete service-catalog surface with its permission boundary', () => {
    const expectations: [string, string, string][] = [
      ['/service-catalog/entries', 'post', 'service_catalog.manage'],
      ['/service-catalog/entries', 'get', 'service_catalog.read'],
      ['/service-catalog/entries/{id}', 'get', 'service_catalog.read'],
      ['/service-catalog/entries/{id}', 'patch', 'service_catalog.manage'],
      ['/service-catalog/entries/{id}/deactivate', 'post', 'service_catalog.manage'],
    ];
    for (const [path, method, permission] of expectations) {
      const op = spec.paths[path]?.[method];
      assert.ok(op, `missing OpenAPI operation ${method.toUpperCase()} ${path}`);
      assert.equal(op['x-required-permission'], permission, `${path} permission`);
      assert.equal(op['x-building-scoped'], true, `${path} Building scope flag`);
      assert.deepEqual(op.security, [{ bearerAuth: [] }], `${path} security`);
      for (const status of ['400', '401', '403']) {
        assert.ok(op.responses[status], `${path} ${status} response`);
      }
      assert.equal(op.tags[0], 'Service Catalog', `${path} tag`);
    }
    // Conflict outcomes for create (code collision) and deactivate (terminal).
    assert.ok(spec.paths['/service-catalog/entries'].post.responses['409']);
    assert.ok(
      spec.paths['/service-catalog/entries/{id}/deactivate'].post.responses['409'],
    );

    // Runtime cross-check: the routes really enforce these fences.
    assert.match(routes, /requirePermission\('service_catalog\.read'\)/);
    assert.match(routes, /requirePermission\('service_catalog\.manage'\)/);
    assert.match(routes, /\/service-catalog\/entries\/:id\/deactivate/);
  });

  it('documents the governed Service Catalog identity vocabulary', () => {
    const schemas = spec.components.schemas;
    assert.deepEqual(schemas.ServiceCatalogStatus.enum, ['ACTIVE', 'INACTIVE']);

    const entry = schemas.ServiceCatalogEntry;
    for (const key of [
      'id',
      'clientId',
      'code',
      'name',
      'category',
      'status',
      'createdByUserId',
    ]) {
      assert.ok(entry.properties[key], `entry ${key}`);
      assert.ok(entry.required.includes(key), `entry ${key} required`);
    }
    // The governed SERVICE subject (PART 05) references this master.
    assert.equal(
      schemas.PriceCatalogEntry.properties.serviceId.$ref,
      undefined,
    );
    assert.ok(
      schemas.PriceCatalogEntry.properties.serviceId.allOf?.[0]?.$ref,
      'PriceCatalogEntry.serviceId must be a Uuid ref',
    );

    // CreateRequest carries the immutable code + classification.
    const create = schemas.CreateServiceCatalogEntryRequest;
    assert.deepEqual([...create.required].sort(), [
      'category',
      'clientId',
      'code',
      'name',
    ]);
    assert.ok(create.properties.code);
    assert.ok(create.properties.category);
  });
});
