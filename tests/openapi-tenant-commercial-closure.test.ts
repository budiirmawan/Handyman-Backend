import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import type { Express } from 'express';

process.env.WHATSAPP_WEBHOOK_ENABLED = 'true';
process.env.WHATSAPP_META_APP_SECRET = 'test-secret';
process.env.WHATSAPP_META_WEBHOOK_VERIFY_TOKEN = 'test-token';

import { createApp } from '../src/app';

/**
 * INT-LC-19-BE PART 11 — Tenant Management & Commercial Billing OpenAPI Closure.
 *
 * Scope:
 *   - tenant-companies (4)
 *   - tenant-building-contexts (5)
 *   - tenant-spaces (5)
 *   - tenant-pics (4)
 *   - tenant-contractors (6)
 *   - tenant-documents (4)
 *   - tenant-charges (5)
 *   - tenant-invoices (7)
 *   - invoice-payment-status (4)
 *   - payment-receipts (4)
 *   - service-charge-readiness (4)
 *   - subscriptions (6)
 *   - licenses (5)
 *   - modules (4)
 * Total undocumented routes: exact 67.
 *
 * None of these routes implement Idempotency-Key or optimistic concurrency.
 */

const SPEC_PATH = resolve(__dirname, '../docs/api/openapi.yaml');
const SPEC = parse(readFileSync(SPEC_PATH, 'utf8')) as Record<string, any>;

function normalizePath(p: string): string {
  return (
    p
      .replace(/:([a-zA-Z0-9_]+)/g, '{$1}')
      .replace(/\{([a-zA-Z0-9_]+)\}/g, '{p}')
      .replace(/\/+/g, '/')
      .replace(/\/$/, '') || '/'
  );
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
      const full = prefix + layer.route.path || '/';
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

const SCOPED_OPERATIONS: Record<
  string,
  { module: string; operationId: string; permission: string }
> = {
  'POST /clients/{clientId}/tenant-companies': {
    module: 'tenant-companies',
    operationId: 'createTenantCompany',
    permission: 'tenant_company.manage',
  },
  'GET /clients/{clientId}/tenant-companies': {
    module: 'tenant-companies',
    operationId: 'listClientTenantCompanies',
    permission: 'tenant_company.read',
  },
  'GET /tenant-companies/{id}': {
    module: 'tenant-companies',
    operationId: 'getTenantCompany',
    permission: 'tenant_company.read',
  },
  'PATCH /tenant-companies/{id}': {
    module: 'tenant-companies',
    operationId: 'updateTenantCompany',
    permission: 'tenant_company.manage',
  },
  'POST /tenant-companies/{tenantCompanyId}/building-contexts': {
    module: 'tenant-building-contexts',
    operationId: 'createTenantBuildingContext',
    permission: 'tenant_company.manage',
  },
  'GET /tenant-companies/{tenantCompanyId}/building-contexts': {
    module: 'tenant-building-contexts',
    operationId: 'listTenantBuildingContexts',
    permission: 'tenant_company.read',
  },
  'GET /buildings/{buildingId}/tenant-contexts': {
    module: 'tenant-building-contexts',
    operationId: 'listBuildingTenantContexts',
    permission: 'tenant_company.read',
  },
  'GET /tenant-building-contexts/{id}': {
    module: 'tenant-building-contexts',
    operationId: 'getTenantBuildingContext',
    permission: 'tenant_company.read',
  },
  'PATCH /tenant-building-contexts/{id}': {
    module: 'tenant-building-contexts',
    operationId: 'updateTenantBuildingContext',
    permission: 'tenant_company.manage',
  },
  'POST /tenant-companies/{tenantCompanyId}/spaces': {
    module: 'tenant-spaces',
    operationId: 'assignTenantSpace',
    permission: 'tenant_company.manage',
  },
  'GET /tenant-companies/{tenantCompanyId}/spaces': {
    module: 'tenant-spaces',
    operationId: 'listTenantSpaces',
    permission: 'tenant_company.read',
  },
  'GET /buildings/{buildingId}/tenant-spaces': {
    module: 'tenant-spaces',
    operationId: 'listBuildingTenantSpaces',
    permission: 'tenant_company.read',
  },
  'GET /tenant-space-relationships/{id}': {
    module: 'tenant-spaces',
    operationId: 'getTenantSpaceRelationship',
    permission: 'tenant_company.read',
  },
  'PATCH /tenant-space-relationships/{id}': {
    module: 'tenant-spaces',
    operationId: 'updateTenantSpaceRelationship',
    permission: 'tenant_company.manage',
  },
  'POST /tenant-companies/{tenantCompanyId}/pics': {
    module: 'tenant-pics',
    operationId: 'createTenantPic',
    permission: 'tenant_company.manage',
  },
  'GET /tenant-companies/{tenantCompanyId}/pics': {
    module: 'tenant-pics',
    operationId: 'listTenantPics',
    permission: 'tenant_company.read',
  },
  'GET /tenant-pics/{id}': {
    module: 'tenant-pics',
    operationId: 'getTenantPic',
    permission: 'tenant_company.read',
  },
  'PATCH /tenant-pics/{id}': {
    module: 'tenant-pics',
    operationId: 'updateTenantPic',
    permission: 'tenant_company.manage',
  },
  'POST /tenant-companies/{tenantCompanyId}/contractor-relationships': {
    module: 'tenant-contractors',
    operationId: 'createTenantContractorRelationship',
    permission: 'tenant_company.manage',
  },
  'GET /tenant-companies/{tenantCompanyId}/contractor-relationships': {
    module: 'tenant-contractors',
    operationId: 'listTenantContractorRelationships',
    permission: 'tenant_company.read',
  },
  'GET /buildings/{buildingId}/tenant-contractor-relationships': {
    module: 'tenant-contractors',
    operationId: 'listBuildingTenantContractorRelationships',
    permission: 'tenant_company.read',
  },
  'GET /vendors/{vendorId}/tenant-relationships': {
    module: 'tenant-contractors',
    operationId: 'listVendorTenantRelationships',
    permission: 'tenant_company.read',
  },
  'GET /tenant-contractor-relationships/{id}': {
    module: 'tenant-contractors',
    operationId: 'getTenantContractorRelationship',
    permission: 'tenant_company.read',
  },
  'PATCH /tenant-contractor-relationships/{id}': {
    module: 'tenant-contractors',
    operationId: 'updateTenantContractorRelationship',
    permission: 'tenant_company.manage',
  },
  'POST /tenant-companies/{tenantCompanyId}/documents': {
    module: 'tenant-documents',
    operationId: 'createTenantDocument',
    permission: 'tenant_company.manage',
  },
  'GET /tenant-companies/{tenantCompanyId}/documents': {
    module: 'tenant-documents',
    operationId: 'listTenantDocuments',
    permission: 'tenant_company.read',
  },
  'GET /tenant-documents/{id}': {
    module: 'tenant-documents',
    operationId: 'getTenantDocument',
    permission: 'tenant_company.read',
  },
  'PATCH /tenant-documents/{id}': {
    module: 'tenant-documents',
    operationId: 'updateTenantDocument',
    permission: 'tenant_company.manage',
  },
  'POST /tenant-companies/{tenantCompanyId}/charges': {
    module: 'tenant-charges',
    operationId: 'createTenantCharge',
    permission: 'tenant_charge.manage',
  },
  'GET /tenant-charges': {
    module: 'tenant-charges',
    operationId: 'listTenantCharges',
    permission: 'tenant_charge.read',
  },
  'GET /tenant-charges/{id}': {
    module: 'tenant-charges',
    operationId: 'getTenantCharge',
    permission: 'tenant_charge.read',
  },
  'PATCH /tenant-charges/{id}': {
    module: 'tenant-charges',
    operationId: 'updateTenantCharge',
    permission: 'tenant_charge.manage',
  },
  'POST /tenant-charges/{id}/cancel': {
    module: 'tenant-charges',
    operationId: 'cancelTenantCharge',
    permission: 'tenant_charge.manage',
  },
  'POST /tenant-companies/{tenantCompanyId}/invoices': {
    module: 'tenant-invoices',
    operationId: 'createTenantInvoice',
    permission: 'tenant_invoice.manage',
  },
  'GET /tenant-invoices': {
    module: 'tenant-invoices',
    operationId: 'listTenantInvoices',
    permission: 'tenant_invoice.read',
  },
  'POST /tenant-invoices/{id}/lines': {
    module: 'tenant-invoices',
    operationId: 'addTenantInvoiceLine',
    permission: 'tenant_invoice.manage',
  },
  'POST /tenant-invoices/{id}/finalize': {
    module: 'tenant-invoices',
    operationId: 'finalizeTenantInvoice',
    permission: 'tenant_invoice.manage',
  },
  'POST /tenant-invoices/{id}/cancel': {
    module: 'tenant-invoices',
    operationId: 'cancelTenantInvoice',
    permission: 'tenant_invoice.manage',
  },
  'GET /tenant-invoices/{id}': {
    module: 'tenant-invoices',
    operationId: 'getTenantInvoice',
    permission: 'tenant_invoice.read',
  },
  'PATCH /tenant-invoices/{id}': {
    module: 'tenant-invoices',
    operationId: 'updateTenantInvoice',
    permission: 'tenant_invoice.manage',
  },
  'POST /tenant-invoices/{invoiceId}/payment-status': {
    module: 'invoice-payment-status',
    operationId: 'recordInvoicePaymentStatus',
    permission: 'invoice_payment_status.manage',
  },
  'GET /tenant-invoices/{invoiceId}/payment-status': {
    module: 'invoice-payment-status',
    operationId: 'getInvoicePaymentStatus',
    permission: 'invoice_payment_status.read',
  },
  'GET /invoice-payment-statuses': {
    module: 'invoice-payment-status',
    operationId: 'listInvoicePaymentStatuses',
    permission: 'invoice_payment_status.read',
  },
  'PATCH /invoice-payment-statuses/{id}': {
    module: 'invoice-payment-status',
    operationId: 'updateInvoicePaymentStatus',
    permission: 'invoice_payment_status.manage',
  },
  'POST /tenant-invoices/{invoiceId}/receipts': {
    module: 'payment-receipts',
    operationId: 'issuePaymentReceipt',
    permission: 'payment_receipt.manage',
  },
  'GET /payment-receipts': {
    module: 'payment-receipts',
    operationId: 'listPaymentReceipts',
    permission: 'payment_receipt.read',
  },
  'POST /payment-receipts/{id}/void': {
    module: 'payment-receipts',
    operationId: 'voidPaymentReceipt',
    permission: 'payment_receipt.manage',
  },
  'GET /payment-receipts/{id}': {
    module: 'payment-receipts',
    operationId: 'getPaymentReceipt',
    permission: 'payment_receipt.read',
  },
  'POST /tenant-companies/{tenantCompanyId}/service-charge-readiness': {
    module: 'service-charge-readiness',
    operationId: 'createServiceChargeReadiness',
    permission: 'service_charge_readiness.manage',
  },
  'GET /service-charge-readiness': {
    module: 'service-charge-readiness',
    operationId: 'listServiceChargeReadiness',
    permission: 'service_charge_readiness.read',
  },
  'GET /service-charge-readiness/{id}': {
    module: 'service-charge-readiness',
    operationId: 'getServiceChargeReadiness',
    permission: 'service_charge_readiness.read',
  },
  'PATCH /service-charge-readiness/{id}': {
    module: 'service-charge-readiness',
    operationId: 'updateServiceChargeReadiness',
    permission: 'service_charge_readiness.manage',
  },
  'POST /subscriptions': {
    module: 'subscriptions',
    operationId: 'createSubscription',
    permission: 'subscription.manage',
  },
  'GET /subscriptions': {
    module: 'subscriptions',
    operationId: 'listSubscriptions',
    permission: 'subscription.read',
  },
  'GET /subscriptions/{id}': {
    module: 'subscriptions',
    operationId: 'getSubscription',
    permission: 'subscription.read',
  },
  'GET /subscriptions/{id}/effective': {
    module: 'subscriptions',
    operationId: 'getSubscriptionEffectiveState',
    permission: 'subscription.read',
  },
  'PATCH /subscriptions/{id}/status': {
    module: 'subscriptions',
    operationId: 'updateSubscriptionStatus',
    permission: 'subscription.manage',
  },
  'GET /clients/{clientId}/subscriptions': {
    module: 'subscriptions',
    operationId: 'listClientSubscriptions',
    permission: 'subscription.read',
  },
  'POST /subscriptions/{subscriptionId}/licenses': {
    module: 'licenses',
    operationId: 'createLicense',
    permission: 'license.manage',
  },
  'GET /subscriptions/{subscriptionId}/licenses': {
    module: 'licenses',
    operationId: 'listSubscriptionLicenses',
    permission: 'license.read',
  },
  'GET /licenses/{id}': {
    module: 'licenses',
    operationId: 'getLicense',
    permission: 'license.read',
  },
  'GET /licenses/{id}/effective': {
    module: 'licenses',
    operationId: 'getLicenseEffectiveState',
    permission: 'license.read',
  },
  'PATCH /licenses/{id}/status': {
    module: 'licenses',
    operationId: 'updateLicenseStatus',
    permission: 'license.manage',
  },
  'POST /modules': {
    module: 'modules',
    operationId: 'createModule',
    permission: 'module.manage',
  },
  'GET /modules': {
    module: 'modules',
    operationId: 'listModules',
    permission: 'module.read',
  },
  'GET /modules/{id}': {
    module: 'modules',
    operationId: 'getModule',
    permission: 'module.read',
  },
  'PATCH /modules/{id}/status': {
    module: 'modules',
    operationId: 'updateModuleStatus',
    permission: 'module.manage',
  },
};

const SCOPED_PATTERNS = [
  /^\/clients\/[^/]+\/tenant-companies$/,
  /^\/tenant-companies\/[^/]+$/,
  /^\/tenant-companies\/[^/]+\/building-contexts$/,
  /^\/buildings\/[^/]+\/tenant-contexts$/,
  /^\/tenant-building-contexts\/[^/]+$/,
  /^\/tenant-companies\/[^/]+\/spaces$/,
  /^\/buildings\/[^/]+\/tenant-spaces$/,
  /^\/tenant-space-relationships\/[^/]+$/,
  /^\/tenant-companies\/[^/]+\/pics$/,
  /^\/tenant-pics\/[^/]+$/,
  /^\/tenant-companies\/[^/]+\/contractor-relationships$/,
  /^\/buildings\/[^/]+\/tenant-contractor-relationships$/,
  /^\/vendors\/[^/]+\/tenant-relationships$/,
  /^\/tenant-contractor-relationships\/[^/]+$/,
  /^\/tenant-companies\/[^/]+\/documents$/,
  /^\/tenant-documents\/[^/]+$/,
  /^\/tenant-companies\/[^/]+\/charges$/,
  /^\/tenant-charges$/,
  /^\/tenant-charges\/[^/]+$/,
  /^\/tenant-charges\/[^/]+\/cancel$/,
  /^\/tenant-companies\/[^/]+\/invoices$/,
  /^\/tenant-invoices$/,
  /^\/tenant-invoices\/[^/]+\/lines$/,
  /^\/tenant-invoices\/[^/]+\/finalize$/,
  /^\/tenant-invoices\/[^/]+\/cancel$/,
  /^\/tenant-invoices\/[^/]+$/,
  /^\/tenant-invoices\/[^/]+\/payment-status$/,
  /^\/invoice-payment-statuses$/,
  /^\/invoice-payment-statuses\/[^/]+$/,
  /^\/tenant-invoices\/[^/]+\/receipts$/,
  /^\/payment-receipts$/,
  /^\/payment-receipts\/[^/]+\/void$/,
  /^\/payment-receipts\/[^/]+$/,
  /^\/tenant-companies\/[^/]+\/service-charge-readiness$/,
  /^\/service-charge-readiness$/,
  /^\/service-charge-readiness\/[^/]+$/,
  /^\/subscriptions$/,
  /^\/subscriptions\/[^/]+$/,
  /^\/subscriptions\/[^/]+\/effective$/,
  /^\/subscriptions\/[^/]+\/status$/,
  /^\/clients\/[^/]+\/subscriptions$/,
  /^\/subscriptions\/[^/]+\/licenses$/,
  /^\/licenses\/[^/]+$/,
  /^\/licenses\/[^/]+\/effective$/,
  /^\/licenses\/[^/]+\/status$/,
  /^\/modules$/,
  /^\/modules\/[^/]+$/,
  /^\/modules\/[^/]+\/status$/,
];

describe('INT-LC-19-BE PART 11 — Tenant Management & Commercial Billing OpenAPI Closure', () => {
  const app = createApp() as Express;
  const runtime = walkRouter((app as any).router?.stack).map((r) => ({
    ...r,
    canon: normalizePath(r.path),
  }));

  const openapi: Array<{
    method: string;
    path: string;
    canon: string;
    operationId?: string;
    permission?: string;
    responses?: Record<string, any>;
    parameters?: any[];
    errorCodes?: string[];
  }> = [];

  for (const [p, methods] of Object.entries(SPEC.paths ?? {})) {
    for (const [m, op] of Object.entries(methods as Record<string, any>)) {
      if (['get', 'post', 'put', 'patch', 'delete', 'options', 'head'].includes(m)) {
        openapi.push({
          method: m.toUpperCase(),
          path: p,
          canon: normalizePath(p),
          operationId: op.operationId,
          permission: op['x-required-permission'],
          responses: op.responses,
          parameters: op.parameters,
          errorCodes: op['x-error-codes'],
        });
      }
    }
  }

  it('1. exact 67 operations in scoped test table', () => {
    assert.equal(Object.keys(SCOPED_OPERATIONS).length, 67);
  });

  it('2. 67/67 scoped operations documented in OpenAPI', () => {
    const openapiByMethodPath = new Map(openapi.map((op) => [`${op.method} ${op.path}`, op]));
    const missing: string[] = [];
    for (const [key, expected] of Object.entries(SCOPED_OPERATIONS)) {
      const op = openapiByMethodPath.get(key);
      if (!op) missing.push(key);
      else {
        assert.equal(op.operationId, expected.operationId, key);
      }
    }
    assert.deepEqual(missing, []);
  });

  it('3. scoped runtime gap is 0', () => {
    const scopedRuntime = runtime.filter((r) => SCOPED_PATTERNS.some((pattern) => pattern.test(r.path)));
    assert.equal(scopedRuntime.length, 67, 'Scoped runtime census must be exactly 67');
    const openapiByMethodCanon = new Set(openapi.map((o) => `${o.method} ${o.canon}`));
    const unmappedScoped = scopedRuntime.filter(
      (r) => !openapiByMethodCanon.has(`${r.method} ${r.canon}`),
    );
    assert.deepEqual(unmappedScoped, []);
  });

  it('4. no speculative routes in OpenAPI for scoped modules', () => {
    const runtimeByMethodCanon = new Set(runtime.map((r) => `${r.method} ${r.canon}`));
    for (const key of Object.keys(SCOPED_OPERATIONS)) {
      const [method, path] = key.split(' ');
      assert.ok(
        runtimeByMethodCanon.has(`${method} ${normalizePath(path)}`),
        `OpenAPI route ${key} must exist in runtime`,
      );
    }
  });

  it('5. unique operationIds across the entire OpenAPI document', () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const op of openapi) {
      if (!op.operationId) continue;
      const here = `${op.method} ${op.path}`;
      if (seen.has(op.operationId)) {
        duplicates.push(`${op.operationId} (${here} and ${seen.get(op.operationId)})`);
      } else {
        seen.set(op.operationId, here);
      }
    }
    assert.deepEqual(duplicates, []);
  });

  it('6. zero broken $refs in openapi.yaml', () => {
    const buckets: Record<string, Set<string>> = {};
    for (const [k, v] of Object.entries(SPEC.components ?? {})) {
      buckets[k] = new Set(Object.keys((v as Record<string, unknown>) ?? {}));
    }
    const broken: string[] = [];
    function walk(node: unknown): void {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      const o = node as Record<string, unknown>;
      if (typeof o.$ref === 'string' && o.$ref.startsWith('#/components/')) {
        const parts = o.$ref.slice(2).split('/');
        const bucket = parts[1];
        const tail = decodeURIComponent(parts.slice(2).join('/'));
        if (!buckets[bucket]?.has(tail)) broken.push(o.$ref);
      }
      for (const v of Object.values(o)) walk(v);
    }
    walk(SPEC);
    assert.deepEqual(broken, []);
  });

  it('7. permission parity exact', () => {
    const openapiByMethodPath = new Map(openapi.map((op) => [`${op.method} ${op.path}`, op]));
    for (const [key, expected] of Object.entries(SCOPED_OPERATIONS)) {
      const op = openapiByMethodPath.get(key);
      assert.ok(op, key);
      assert.equal(op.permission, expected.permission, key);
    }
  });

  it('8. canonical 401 present where authenticated and no idempotency or OCC', () => {
    const openapiByMethodPath = new Map(openapi.map((op) => [`${op.method} ${op.path}`, op]));
    for (const key of Object.keys(SCOPED_OPERATIONS)) {
      const op = openapiByMethodPath.get(key);
      assert.ok(op, key);
      assert.ok(op.responses?.['401'], `${key} must expose canonical 401`);
      assert.ok(
        op.errorCodes?.includes('AUTHENTICATION_REQUIRED'),
        `${key} must document AUTHENTICATION_REQUIRED`,
      );
      assert.ok(
        op.errorCodes?.includes('PERMISSION_DENIED'),
        `${key} must document PERMISSION_DENIED`,
      );
      const paramNames = (op.parameters ?? []).map((parameter) => {
        if (parameter && typeof parameter === 'object' && '$ref' in parameter) return String(parameter.$ref);
        return String(parameter?.name ?? '');
      });
      assert.equal(
        paramNames.some((name) => /idempotency|if-match|expectedupdatedat|expected-version/i.test(name)),
        false,
        `${key} must not invent idempotency or OCC parameters`,
      );
    }
  });

  it('9. request/response schema parity', () => {
    const schemas = SPEC.components.schemas;
    const requiredSchemas = [
      'TenantCompanyStatus',
      'PublicTenantCompany',
      'CreateTenantCompanyRequest',
      'UpdateTenantCompanyRequest',
      'PublicTenantBuildingContext',
      'CreateTenantBuildingContextRequest',
      'PublicTenantSpaceRelationship',
      'AssignTenantSpaceRequest',
      'PublicTenantPic',
      'CreateTenantPicRequest',
      'PublicTenantContractorRelationship',
      'CreateTenantContractorRelationshipRequest',
      'PublicTenantDocument',
      'CreateTenantDocumentRequest',
      'TenantChargeStatus',
      'PublicTenantCharge',
      'CreateTenantChargeRequest',
      'UpdateTenantChargeRequest',
      'CancelTenantChargeRequest',
      'TenantInvoiceStatus',
      'TenantInvoiceSourceType',
      'PublicTenantInvoice',
      'PublicTenantInvoiceLine',
      'CreateTenantInvoiceRequest',
      'AddTenantInvoiceLineRequest',
      'UpdateTenantInvoiceRequest',
      'InvoicePaymentStatusCode',
      'PublicInvoicePaymentStatus',
      'RecordInvoicePaymentStatusRequest',
      'UpdateInvoicePaymentStatusRequest',
      'PaymentReceiptStatus',
      'PublicPaymentReceipt',
      'IssuePaymentReceiptRequest',
      'ServiceChargeReadinessStatus',
      'PublicServiceChargeReadiness',
      'CreateServiceChargeReadinessRequest',
      'UpdateServiceChargeReadinessRequest',
      'SubscriptionStatus',
      'PublicSubscription',
      'CreateSubscriptionRequest',
      'UpdateSubscriptionStatusRequest',
      'SubscriptionEffectiveState',
      'LicenseStatus',
      'PublicLicense',
      'CreateLicenseRequest',
      'UpdateLicenseStatusRequest',
      'LicenseEffectiveState',
      'ModuleStatus',
      'PublicModule',
      'CreateModuleRequest',
      'UpdateModuleStatusRequest',
    ];
    for (const name of requiredSchemas) {
      assert.ok(schemas[name], `${name} schema must exist`);
    }
    assert.deepEqual(schemas.TenantCompanyStatus.enum, ['ACTIVE', 'INACTIVE']);
    assert.deepEqual(schemas.TenantInvoiceStatus.enum, ['DRAFT', 'FINALIZED', 'CANCELLED']);
    assert.deepEqual(schemas.TenantInvoiceSourceType.enum, ['TENANT_CHARGE', 'UTILITY_BILL']);
    assert.deepEqual(schemas.InvoicePaymentStatusCode.enum, [
      'UNPAID',
      'PARTIALLY_PAID',
      'PAID',
      'OVERDUE',
      'CANCELLED',
    ]);
    assert.deepEqual(schemas.PaymentReceiptStatus.enum, ['ISSUED', 'VOID']);
    assert.deepEqual(schemas.ServiceChargeReadinessStatus.enum, ['READY', 'NOT_READY', 'INCOMPLETE']);
    assert.deepEqual(schemas.SubscriptionStatus.enum, [
      'PENDING',
      'ACTIVE',
      'SUSPENDED',
      'EXPIRED',
      'CANCELLED',
    ]);
    assert.deepEqual(schemas.LicenseStatus.enum, ['ACTIVE', 'SUSPENDED', 'EXPIRED', 'REVOKED']);
    assert.deepEqual(schemas.ModuleStatus.enum, ['ACTIVE', 'INACTIVE']);
    assert.equal(schemas.PublicSubscription.properties.packageId, undefined);
    assert.equal(schemas.PublicInvoicePaymentStatus.properties.invoiceTotal, undefined);
    assert.ok(schemas.PublicTenantInvoice.properties.lines);
    assert.ok(schemas.CreateTenantChargeRequest.required.includes('currencyCode'));
    assert.ok(schemas.CreateTenantInvoiceRequest.required.includes('currencyCode'));
  });

  it('10. /platform/* untouched (69/69 parity)', () => {
    const platformRuntime = runtime.filter(
      (r) => r.path.startsWith('/platform') || r.path === '/platform',
    );
    const platformOpenApi = openapi.filter((o) => o.path.startsWith('/platform'));
    assert.equal(platformRuntime.length, 69);
    assert.equal(platformOpenApi.length, 69);
  });

  it('Census validation after PART 11', () => {
    const platformOpenApi = openapi.filter((o) => o.path.startsWith('/platform'));
    const operationalOpenApi = openapi.filter((o) => !o.path.startsWith('/platform'));
    assert.equal(openapi.length, 1598, 'Total OpenAPI count must be 1,598 (1531 + 67)');
    assert.equal(platformOpenApi.length, 69);
    assert.equal(operationalOpenApi.length, 1529, 'Operational OpenAPI count must be 1,529 (1462 + 67)');
    const inScopeOperational = runtime.filter(
      (r) => !r.path.startsWith('/platform') && r.path !== '/',
    );
    assert.equal(inScopeOperational.length, 1617);
    assert.equal(inScopeOperational.length - operationalOpenApi.length, 88);
    const documentedCanon = new Set(operationalOpenApi.map((o) => `${o.method} ${o.canon}`));
    const unmappedDistinct = inScopeOperational.filter(
      (r) => !documentedCanon.has(`${r.method} ${r.canon}`),
    );
    assert.equal(unmappedDistinct.length, 87);
  });
});
