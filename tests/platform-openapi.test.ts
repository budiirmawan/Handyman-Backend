import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parse } from 'yaml';

/**
 * CR-BE-SAAS-01 PART 01 — OpenAPI/runtime parity for the control-plane
 * surface only. Contract/documentation test: no runtime capability is
 * exercised here beyond parsing the document and the route sources.
 */

const openapi = parse(
  readFileSync('docs/api/openapi.yaml', 'utf8'),
) as any;
const customerRoutes = readFileSync(
  'src/modules/platform-customers/platform-customer.routes.ts',
  'utf8',
);
const auditRoutes = readFileSync(
  'src/modules/platform-audit/platform-audit.routes.ts',
  'utf8',
);
const routesIndex = readFileSync('src/routes/index.ts', 'utf8');

describe('CR-BE-SAAS-01 PART 01 — platform OpenAPI contract', () => {
  it('documents the PART 01 platform paths intact (PART 02 catalog additive)', () => {
    const platformPaths = Object.keys(openapi.paths).filter((path) =>
      String(path).startsWith('/platform'),
    );
    // PART 01 surface must remain present and untouched (frozen compatibility).
    for (const required of [
      '/platform/audit',
      '/platform/customers',
      '/platform/customers/{customerId}',
    ]) {
      assert.ok(platformPaths.includes(required), `${required} still documented`);
    }
    // PART 04 surface is intact; PART 06 surface is additive. PART 01
    // tests still pass since the PART 04 frozen entitlement path and
    // PART 06 paths are now documented.
    for (const path of platformPaths) {
      // The `/invoices/...` (PART 06) route must not appear under a
      // different route name; the ONLY entitlement path remains the
      // frozen §22 route.
      assert.ok(
        path !== '/platform/subscriptions/{subscriptionId}/entitlements'
          ? !path.includes('entitlement')
          : true,
        `no speculative entitlement paths: ${path}`,
      );
      assert.ok(!path.includes('add-on'), `no add-on paths: ${path}`);
      assert.ok(!path.includes('payment'), `no payment paths: ${path}`);
    }
    assert.equal(
      platformPaths.filter((path) => path.includes('entitlement')).length,
      1,
      'exactly one entitlement path (frozen §22, PART 04)',
    );
  });

  it('documents the exact methods with frozen permissions', () => {
    const customers = openapi.paths['/platform/customers'];
    assert.deepEqual(
      Object.keys(customers).sort(),
      ['get', 'post'],
    );
    assert.equal(customers.post['x-required-permission'], 'platform.customer.manage');
    assert.equal(customers.get['x-required-permission'], 'platform.customer.read');

    const detail = openapi.paths['/platform/customers/{customerId}'];
    assert.deepEqual(Object.keys(detail).sort(), ['get', 'patch']);
    assert.equal(detail.get['x-required-permission'], 'platform.customer.read');
    assert.equal(detail.patch['x-required-permission'], 'platform.customer.manage');

    const audit = openapi.paths['/platform/audit'];
    assert.deepEqual(Object.keys(audit), ['get']);
    assert.equal(audit.get['x-required-permission'], 'platform.audit.read');
  });

  it('requires Idempotency-Key on customer create and documents the version contract on update', () => {
    const create = openapi.paths['/platform/customers'].post;
    const idempotencyParam = create.parameters.find(
      (param: any) => param.$ref === '#/components/parameters/IdempotencyKey',
    );
    assert.ok(idempotencyParam, 'Idempotency-Key header must be required');
    const idempotency = openapi.components.parameters.IdempotencyKey;
    assert.equal(idempotency.in, 'header');
    assert.equal(idempotency.required, true);
    assert.equal(idempotency.schema.maxLength, 200);

    const update = openapi.components.schemas.UpdateSaaSCustomerRequest;
    assert.ok(
      update.required.includes('expectedVersion'),
      'expectedVersion must be required on update',
    );
    assert.equal(
      Object.keys(update.properties).includes('status'),
      false,
      'status must not be an update field',
    );
    assert.equal(
      Object.keys(update.properties).includes('code'),
      false,
      'code must not be an update field',
    );

    const createRequest = openapi.components.schemas.CreateSaaSCustomerRequest;
    assert.equal(
      Object.keys(createRequest.properties).includes('status'),
      false,
      'status must not be a create field (lifecycle is server-authoritative)',
    );
  });

  it('freezes the customer lifecycle vocabulary', () => {
    const status = openapi.components.schemas.SaaSCustomerStatus.enum;
    assert.deepEqual(status.sort(), [
      'ACTIVE',
      'GRACE',
      'INACTIVE',
      'PROSPECT',
      'SUSPENDED',
      'TERMINATED',
      'TRIAL',
    ]);
  });

  it('documents the SaaS customer registry shape (clients extension)', () => {
    const customer = openapi.components.schemas.SaaSCustomer.properties;
    for (const field of [
      'id',
      'code',
      'name',
      'legalName',
      'displayName',
      'taxId',
      'description',
      'status',
      'billingEmail',
      'billingPhone',
      'address',
      'country',
      'currencyCode',
      'timezone',
      'version',
      'createdAt',
      'updatedAt',
    ]) {
      assert.ok(customer[field], `SaaSCustomer.${field} must be documented`);
    }
    assert.equal(customer.version.type, 'integer');

    const detail = openapi.components.schemas.SaaSCustomerDetail;
    assert.ok(detail.allOf, 'detail must extend SaaSCustomer');
    const detailProps = detail.allOf.find(
      (part: any) => part?.properties?.subscriptions,
    );
    assert.ok(detailProps, 'detail must document subscriptions');
  });

  it('documents the canonical audit read (single store, platform scope)', () => {
    const event = openapi.components.schemas.PlatformAuditEvent.properties;
    for (const field of [
      'id',
      'clientId',
      'eventType',
      'entityType',
      'entityId',
      'actorUserId',
      'requestId',
      'source',
      'summary',
      'metadata',
      'occurredAt',
    ]) {
      assert.ok(event[field], `PlatformAuditEvent.${field} must be documented`);
    }
    // clientId nullable = platform-scope events (frozen D1).
    assert.equal(event.clientId.nullable, true);

    const audit = openapi.paths['/platform/audit'].get;
    const paramNames = audit.parameters
      .filter((param: any) => !param.$ref)
      .map((param: any) => param.name);
    for (const expected of [
      'customerId',
      'actorUserId',
      'eventType',
      'entityType',
      'from',
      'to',
      'page',
      'pageSize',
    ]) {
      assert.ok(paramNames.includes(expected), `audit filter ${expected}`);
    }
  });

  it('keeps runtime routes and OpenAPI in lockstep', () => {
    for (const path of [
      "'/platform/customers'",
      "'/platform/customers/:id'",
    ]) {
      assert.ok(customerRoutes.includes(path), `runtime route ${path} missing`);
    }
    assert.ok(auditRoutes.includes("'/platform/audit'"), 'audit route missing');
    assert.ok(
      routesIndex.includes('createPlatformCustomerRouter'),
      'platform customer router must be registered',
    );
    assert.ok(
      routesIndex.includes('createPlatformAuditRouter'),
      'platform audit router must be registered',
    );

    // Every platform route in the sources is gated on the platform.* guard.
    assert.ok(customerRoutes.includes("requirePlatformPermission('platform.customer.read')"));
    assert.ok(customerRoutes.includes("requirePlatformPermission('platform.customer.manage')"));
    assert.ok(auditRoutes.includes("requirePlatformPermission('platform.audit.read')"));
  });

  it('does not expose platform.* on any business-plane path', () => {
    const businessPermissions = new Set<string>();
    for (const [path, operations] of Object.entries<any>(openapi.paths)) {
      if (String(path).startsWith('/platform')) continue;
      for (const operation of Object.values<any>(operations)) {
        const permission = operation['x-required-permission'];
        if (typeof permission === 'string') businessPermissions.add(permission);
      }
    }
    for (const permission of businessPermissions) {
      assert.ok(
        !permission.startsWith('platform.'),
        `business path references platform permission ${permission}`,
      );
    }
  });
});
