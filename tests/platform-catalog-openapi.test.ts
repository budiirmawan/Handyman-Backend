import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parse } from 'yaml';

/**
 * CR-BE-SAAS-01 PART 02 — OpenAPI/runtime parity for the SaaS catalog &
 * pricebook surface. Contract/documentation test: no runtime capability is
 * exercised beyond parsing the document and the route sources.
 */

const openapi = parse(readFileSync('docs/api/openapi.yaml', 'utf8')) as any;
const productRoutes = readFileSync(
  'src/modules/platform-products/platform-product.routes.ts',
  'utf8',
);
const pricebookRoutes = readFileSync(
  'src/modules/platform-pricebooks/platform-pricebook.routes.ts',
  'utf8',
);
const routesIndex = readFileSync('src/routes/index.ts', 'utf8');

describe('CR-BE-SAAS-01 PART 02 — catalog & pricebook OpenAPI contract', () => {
  it('documents exactly the frozen PART 01+02+03+04+06 platform paths (no later-PART surface)', () => {
    const platformPaths = Object.keys(openapi.paths).filter((path) =>
      String(path).startsWith('/platform'),
    );
    assert.deepEqual(platformPaths.sort(), [
      '/platform/audit',
      '/platform/billing-accounts',
      '/platform/billing-accounts/{id}',
      '/platform/customers',
      '/platform/customers/{customerId}',
      '/platform/invoices',
      '/platform/invoices/{id}',
      '/platform/invoices/{id}/issue',
      '/platform/invoices/{id}/void',
      '/platform/packages',
      '/platform/packages/{packageId}',
      '/platform/pricebook-versions/{versionId}/publish',
      '/platform/pricebooks',
      '/platform/pricebooks/{pricebookId}',
      '/platform/products',
      '/platform/products/{productId}',
      '/platform/subscriptions',
      '/platform/subscriptions/{subscriptionId}',
      '/platform/subscriptions/{subscriptionId}/activate',
      '/platform/subscriptions/{subscriptionId}/cancel',
      '/platform/subscriptions/{subscriptionId}/convert',
      '/platform/subscriptions/{subscriptionId}/entitlements',
      '/platform/subscriptions/{subscriptionId}/renew',
      '/platform/subscriptions/{subscriptionId}/terminate',
    ]);
    // No speculative add-on/reactivate/payment/reconciliation surface
    // (PART 05 / PART 07+); the ENTITLEMENTS path is the single
    // frozen §22 entitlement route (PART 04).
    for (const path of platformPaths) {
      assert.ok(!path.includes('add-on'), `no add-on paths: ${path}`);
      assert.ok(
        path !== '/platform/subscriptions/{subscriptionId}/entitlements'
          ? !path.includes('entitlement')
          : true,
        `no speculative entitlement paths: ${path}`,
      );
      assert.ok(!path.includes('reactivate'), `no reactivate paths: ${path}`);
      assert.ok(!path.includes('payment'), `no payment paths: ${path}`);
      assert.ok(!path.includes('reconcile'), `no reconciliation paths: ${path}`);
    }
    assert.equal(
      platformPaths.filter((path) => path.includes('entitlement')).length,
      1,
      'exactly one entitlement path (frozen §22)',
    );
    // PART 06 surface frozen (six new paths): no more, no less.
    assert.equal(
      platformPaths.filter((path) => path.includes('billing')).length,
      2,
      'exactly two billing-account paths',
    );
    assert.equal(
      platformPaths.filter((path) => path.includes('invoices')).length,
      4,
      'exactly four invoice paths (collection / detail / issue / void)',
    );
  });

  it('documents the frozen permissions per operation', () => {
    const expected: Record<string, Record<string, string>> = {
      '/platform/products': { get: 'platform.product.read', post: 'platform.product.manage' },
      '/platform/products/{productId}': { get: 'platform.product.read', patch: 'platform.product.manage' },
      '/platform/packages': { get: 'platform.product.read', post: 'platform.product.manage' },
      '/platform/packages/{packageId}': { get: 'platform.product.read', patch: 'platform.product.manage' },
      '/platform/pricebooks': { get: 'platform.pricebook.read', post: 'platform.pricebook.manage' },
      '/platform/pricebooks/{pricebookId}': { get: 'platform.pricebook.read', post: 'platform.pricebook.manage' },
      '/platform/pricebook-versions/{versionId}/publish': { post: 'platform.pricebook.manage' },
      '/platform/subscriptions': { get: 'platform.subscription.read', post: 'platform.subscription.manage' },
      '/platform/subscriptions/{subscriptionId}': { get: 'platform.subscription.read', patch: 'platform.subscription.manage' },
      '/platform/subscriptions/{subscriptionId}/activate': { post: 'platform.subscription.manage' },
      '/platform/subscriptions/{subscriptionId}/convert': { post: 'platform.subscription.manage' },
      '/platform/subscriptions/{subscriptionId}/renew': { post: 'platform.subscription.manage' },
      '/platform/subscriptions/{subscriptionId}/cancel': { post: 'platform.subscription.manage' },
      '/platform/subscriptions/{subscriptionId}/terminate': { post: 'platform.subscription.manage' },
    };
    for (const [path, operations] of Object.entries(expected)) {
      const docOps = openapi.paths[path];
      assert.ok(docOps, `path ${path} documented`);
      for (const [method, permission] of Object.entries(operations)) {
        assert.equal(
          docOps[method]['x-required-permission'],
          permission,
          `${method} ${path}`,
        );
      }
    }
  });

  it('requires Idempotency-Key ONLY on the publish command (PART 02 surface)', () => {
    const publish = openapi.paths['/platform/pricebook-versions/{versionId}/publish'].post;
    assert.ok(
      publish.parameters.some(
        (param: any) => param.$ref === '#/components/parameters/IdempotencyKey',
      ),
      'publish must require Idempotency-Key',
    );

    // PART 02 surface only (PART 01 customer create carries its own frozen
    // Idempotency-Key requirement).
    const part02Paths = [
      '/platform/products',
      '/platform/products/{productId}',
      '/platform/packages',
      '/platform/packages/{packageId}',
      '/platform/pricebooks',
      '/platform/pricebooks/{pricebookId}',
      '/platform/pricebook-versions/{versionId}/publish',
    ];
    const allOthers = Object.entries<any>(openapi.paths)
      .filter(([path]) => part02Paths.includes(String(path)))
      .flatMap(([path, operations]) =>
        Object.entries(operations).flatMap(([method, op]) =>
          op.parameters?.map((param: any) => ({ path, method, param })) ?? [],
        ),
      );
    for (const { path, method, param } of allOthers) {
      if (path === '/platform/pricebook-versions/{versionId}/publish' && method === 'post') continue;
      assert.ok(
        param.$ref !== '#/components/parameters/IdempotencyKey',
        `${method} ${path} must not require Idempotency-Key`,
      );
    }
  });

  it('freezes the pricebook lifecycle, billing cycles, and limit vocabulary', () => {
    assert.deepEqual(
      openapi.components.schemas.SaasPricebookVersionStatus.enum,
      ['DRAFT', 'PUBLISHED', 'SUPERSEDED'],
    );
    assert.deepEqual(
      openapi.components.schemas.BillingCycle.enum,
      ['MONTHLY', 'ANNUAL', 'CUSTOM'],
    );
    assert.deepEqual(
      [...openapi.components.schemas.PackageLimitKey.enum].sort(),
      [
        'active.asset.count',
        'ai.usage',
        'api.requests',
        'building.count',
        'integration.count',
        'monthly.wo.count',
        'storage.bytes',
        'user.count',
      ],
    );
    assert.deepEqual(
      openapi.components.schemas.SaasCatalogStatus.enum,
      ['ACTIVE', 'INACTIVE'],
    );
  });

  it('documents immutability semantics (no code/status on updates; required effectiveFrom + items)', () => {
    const updateProduct = openapi.components.schemas.UpdateSaasProductRequest;
    assert.equal('code' in updateProduct.properties, false, 'code is immutable');
    assert.equal('status' in updateProduct.properties, true, 'status is updatable catalog state');

    const updatePackage = openapi.components.schemas.UpdateSaasPackageRequest;
    assert.equal('code' in updatePackage.properties, false, 'package code is immutable');
    assert.equal('productId' in updatePackage.properties, false, 'product binding is immutable');

    const versionRequest = openapi.components.schemas.CreateSaasPricebookVersionRequest;
    assert.ok(versionRequest.required.includes('effectiveFrom'));
    assert.ok(versionRequest.required.includes('items'));
    assert.equal(versionRequest.properties.items.minItems, 1);
  });

  it('documents the price item shape (nullable package, defaults)', () => {
    const item = openapi.components.schemas.SaasPriceItem.properties;
    assert.equal(item.packageId.nullable, true, 'packageId is nullable (platform-wide items)');
    assert.equal(item.includedBuildingCount.default, 0);
    assert.equal(item.additionalBuildingPrice.default, 0);
    assert.equal(item.basePrice.minimum, 0);
  });

  it('documents the PART 03 subscription OpenAPI contract (frozen §22 subset)', () => {
    // Idempotency-Key exactly on create/activate/convert.
    const idemPaths = [
      ['/platform/subscriptions', 'post'],
      ['/platform/subscriptions/{subscriptionId}/activate', 'post'],
      ['/platform/subscriptions/{subscriptionId}/convert', 'post'],
    ] as const;
    for (const [path, method] of idemPaths) {
      const op = openapi.paths[path][method];
      assert.ok(
        op.parameters.some((param: any) => param.$ref === '#/components/parameters/IdempotencyKey'),
        `${method} ${path} must require Idempotency-Key`,
      );
    }
    // ...and nowhere else on the PART 03 surface.
    for (const [path, operations] of Object.entries<any>(openapi.paths)) {
      if (!String(path).startsWith('/platform/subscriptions')) continue;
      for (const [method, op] of Object.entries(operations)) {
        const isIdem = idemPaths.some(([p, m]) => p === path && m === method);
        if (isIdem) continue;
        for (const param of op.parameters ?? []) {
          assert.ok(
            param.$ref !== '#/components/parameters/IdempotencyKey',
            `${method} ${path} must not require Idempotency-Key`,
          );
        }
      }
    }
    // expectedVersion REQUIRED in the body of the four ver commands.
    const verRequests = [
      'UpdateSaasSubscriptionRequest',
      'RenewSaasSubscriptionRequest',
      'CancelSaasSubscriptionRequest',
      'TerminateSaasSubscriptionRequest',
    ];
    for (const schemaName of verRequests) {
      const schema = openapi.components.schemas[schemaName];
      assert.ok(schema, `${schemaName} documented`);
      assert.ok(schema.required.includes('expectedVersion'), `${schemaName} requires expectedVersion`);
      assert.equal('status' in (schema.properties ?? {}), false, `${schemaName} has no status field`);
    }
    // No generic status setter: the PATCH request must not carry status.
    const detail = openapi.paths['/platform/subscriptions/{subscriptionId}'];
    assert.ok(detail.get && detail.patch, 'subscription detail supports GET + PATCH only');
    // Lifecycle vocabulary + canonical statuses.
    assert.deepEqual(
      openapi.components.schemas.SaasSubscriptionStatus.enum,
      ['DRAFT', 'TRIAL', 'ACTIVE', 'PAST_DUE', 'GRACE', 'SUSPENDED', 'CANCELLED', 'TERMINATED', 'PENDING', 'EXPIRED'],
    );
  });

  it('keeps runtime routes and OpenAPI in lockstep', () => {
    const productPaths = [
      "'/platform/products'",
      "'/platform/products/:id'",
      "'/platform/packages'",
      "'/platform/packages/:id'",
    ];
    for (const path of productPaths) {
      assert.ok(productRoutes.includes(path), `runtime route ${path} missing`);
    }
    const pricebookPaths = [
      "'/platform/pricebooks'",
      "'/platform/pricebooks/:id'",
      "'/platform/pricebooks/:id/versions'",
      "'/platform/pricebook-versions/:id/publish'",
    ];
    for (const path of pricebookPaths) {
      assert.ok(pricebookRoutes.includes(path), `runtime route ${path} missing`);
    }
    assert.ok(routesIndex.includes('createPlatformProductRouter'));
    assert.ok(routesIndex.includes('createPlatformPricebookRouter'));
    assert.ok(routesIndex.includes('createPlatformSubscriptionRouter'));

    const subscriptionRoutes = readFileSync(
      'src/modules/platform-subscriptions/platform-subscription.routes.ts',
      'utf8',
    );
    const subscriptionPathList = [
      "'/platform/subscriptions'",
      "'/platform/subscriptions/:id'",
      "'/platform/subscriptions/:id/activate'",
      "'/platform/subscriptions/:id/convert'",
      "'/platform/subscriptions/:id/renew'",
      "'/platform/subscriptions/:id/cancel'",
      "'/platform/subscriptions/:id/terminate'",
    ];
    for (const path of subscriptionPathList) {
      assert.ok(subscriptionRoutes.includes(path), `runtime route ${path} missing`);
    }
    assert.ok(
      subscriptionRoutes.includes("requirePlatformPermission('platform.subscription.read')"),
    );
    assert.ok(
      subscriptionRoutes.includes("requirePlatformPermission('platform.subscription.manage')"),
    );

    assert.ok(
      productRoutes.includes("requirePlatformPermission('platform.product.read')"),
    );
    assert.ok(
      productRoutes.includes("requirePlatformPermission('platform.product.manage')"),
    );
    assert.ok(
      pricebookRoutes.includes("requirePlatformPermission('platform.pricebook.read')"),
    );
    assert.ok(
      pricebookRoutes.includes("requirePlatformPermission('platform.pricebook.manage')"),
    );
  });
});
