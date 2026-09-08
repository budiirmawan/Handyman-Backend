import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import {
  PRICE_CATALOG_CURRENCIES,
  PRICE_CATALOG_ENTRY_KINDS,
  PRICE_CATALOG_LOOKUP_RESOLUTIONS,
  PRICE_CATALOG_SCOPE_TIERS,
  PRICE_CATALOG_SOURCE_MODES,
  PRICE_CATALOG_STATUSES,
} from '../src/modules/price-catalog-entries';
import {
  PO_PRICE_DEVIATION_POSITIONS,
  PO_PRICE_DEVIATION_RESOLUTIONS,
} from '../src/modules/purchase-orders';

/**
 * CR-BE-PRICE-01 PART 06 — OpenAPI closure for the Price Authority surface.
 *
 * Pins that docs/api/openapi.yaml documents every CR-BE-PRICE-01 route
 * introduced through PART 01–06 with the runtime's real permission boundary,
 * request/response vocabulary and enums (compared against the TypeScript
 * source of truth), including PART 05's /correct (Idempotency-Key + mandatory
 * reason), the PART 04 conjunctive comparison `reference` extension, and the
 * PART 06 PO advisory deviation projection. Route-file cross-checks mirror
 * the rfq-openapi.test.ts convention. Database-free by design.
 */

const spec = parse(
  readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8'),
) as any;
const routes = [
  'src/modules/price-catalog-entries/price-catalog-entry.routes.ts',
  'src/modules/purchase-orders/purchase-order.routes.ts',
]
  .map((file) => readFileSync(resolve(__dirname, '..', file), 'utf8'))
  .join('\n');

describe('CR-BE-PRICE-01 PART 06 — OpenAPI path + permission completeness', () => {
  it('documents the complete PART 01–06 price-catalog surface with its permission boundary', () => {
    const expectations: [string, string, string][] = [
      ['/price-catalog/lookup', 'get', 'price_catalog.read'],
      ['/price-catalog/entries', 'post', 'price_catalog.manage'],
      ['/price-catalog/entries', 'get', 'price_catalog.read'],
      ['/price-catalog/entries/{id}', 'get', 'price_catalog.read'],
      ['/price-catalog/entries/{id}', 'patch', 'price_catalog.manage'],
      ['/price-catalog/entries/{id}/activate', 'post', 'price_catalog.manage'],
      ['/price-catalog/entries/{id}/replace', 'post', 'price_catalog.manage'],
      ['/price-catalog/entries/{id}/correct', 'post', 'price_catalog.override'],
      ['/price-catalog/entries/{id}/deactivate', 'post', 'price_catalog.manage'],
      [
        '/purchase-orders/{id}/price-deviation',
        'get',
        'purchase_order.read + price_catalog.read',
      ],
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
    }
    // Writes + the /correct lifecycle surface document their full error
    // vocabulary (validation, reference misses, conflicts).
    for (const path of [
      '/price-catalog/entries',
      '/price-catalog/entries/{id}',
      '/price-catalog/entries/{id}/activate',
      '/price-catalog/entries/{id}/replace',
      '/price-catalog/entries/{id}/correct',
      '/price-catalog/entries/{id}/deactivate',
    ]) {
      const method = path.endsWith('entries/{id}') ? 'patch' : 'post';
      assert.ok(spec.paths[path][method].responses['409'], `${path} 409`);
    }
    assert.ok(spec.paths['/price-catalog/lookup'].get.responses['409']);
    assert.ok(
      spec.paths['/purchase-orders/{id}/price-deviation'].get.responses['404'],
    );

    // Runtime cross-check: the routes really enforce these fences.
    assert.match(routes, /requirePermission\('price_catalog\.read'\)/);
    assert.match(routes, /requirePermission\('price_catalog\.manage'\)/);
    assert.match(routes, /requirePermission\('price_catalog\.override'\)/);
    assert.match(routes, /requirePermission\('purchase_order\.read'\)/);
    assert.match(routes, /\/price-catalog\/entries\/:id\/correct/);
    assert.match(routes, /\/purchase-orders\/:id\/price-deviation/);
  });

  it('pins the /correct contract: request schema, Idempotency-Key, mandatory reason', () => {
    const op = spec.paths['/price-catalog/entries/{id}/correct'].post;

    // Idempotency-Key is a documented, required header for this command.
    const idempotencyParam = op.parameters.find(
      (p: any) => p.$ref === '#/components/parameters/IdempotencyKeyHeader',
    );
    assert.ok(idempotencyParam, 'Idempotency-Key parameter missing on /correct');
    const header = spec.components.parameters.IdempotencyKeyHeader;
    assert.equal(header.name, 'Idempotency-Key');
    assert.equal(header.in, 'header');
    assert.equal(header.required, true);

    // Mandatory reason + successor facts; provenance fields are options.
    const bodyRef =
      op.requestBody.content['application/json'].schema.$ref as string;
    assert.equal(bodyRef, '#/components/schemas/CorrectPriceCatalogEntryRequest');
    const body = spec.components.schemas.CorrectPriceCatalogEntryRequest;
    assert.deepEqual(
      [...body.required].sort(),
      ['effectiveFrom', 'reason', 'unitPrice'],
    );
    for (const optional of [
      'effectiveTo',
      'sourceReference',
      'notes',
      'approvedByUserId',
    ]) {
      assert.ok(body.properties[optional], `optional ${optional}`);
      assert.ok(!body.required.includes(optional));
    }
    assert.equal(body.properties.reason.minLength, 1);
    assert.equal(body.properties.reason.maxLength, 1000);

    // The copy binds the override permission + the mandatory reason + the
    // lifecycle/error posture explicitly.
    assert.match(op.description, /price_catalog\.override/);
    assert.match(op.description, /reason/i);
    assert.match(op.description, /PRICE_CATALOG_ENTRY_OVERRIDE_CORRECTED/);
    assert.match(op.description, /PRICE_CATALOG_NOT_ACTIVE/);
    assert.match(op.description, /PRICE_CATALOG_WINDOW_OVERLAP/);

    // 201 returns the new governed authority state.
    const created = op.responses['201'].content['application/json'].schema;
    assert.equal(created.allOf.length, 2);
    assert.equal(
      created.allOf[1].properties.data.$ref,
      '#/components/schemas/PriceCatalogEntry',
    );
  });
});

describe('CR-BE-PRICE-01 PART 06 — OpenAPI vocabulary vs runtime source of truth', () => {
  it('keeps every price-catalog enum identical to the runtime constants', () => {
    const schemas = spec.components.schemas;
    assert.deepEqual(schemas.PriceCatalogCurrency.enum, [
      ...PRICE_CATALOG_CURRENCIES,
    ]);
    assert.deepEqual(schemas.PriceCatalogEntryStatus.enum, [
      ...PRICE_CATALOG_STATUSES,
    ]);
    assert.deepEqual(schemas.PriceCatalogEntryKind.enum, [
      ...PRICE_CATALOG_ENTRY_KINDS,
    ]);
    assert.deepEqual(schemas.PriceCatalogScopeTier.enum, [
      ...PRICE_CATALOG_SCOPE_TIERS,
    ]);
    assert.deepEqual(schemas.PriceCatalogLookupResolution.enum, [
      ...PRICE_CATALOG_LOOKUP_RESOLUTIONS,
    ]);
    assert.deepEqual(schemas.PurchaseOrderPriceDeviationResolution.enum, [
      ...PO_PRICE_DEVIATION_RESOLUTIONS,
    ]);
    assert.deepEqual(schemas.PriceDeviationPosition.enum, [
      ...PO_PRICE_DEVIATION_POSITIONS,
    ]);
    // CR-BE-SVC-01 PART 06 — sourceMode is now a $ref to the shared enum
    // schema (MATERIAL | SERVICE); the enum is asserted on that schema.
    assert.ok(
      schemas.PriceCatalogEntry.properties.sourceMode.$ref ===
        '#/components/schemas/PriceCatalogSourceMode',
      'PriceCatalogEntry.sourceMode must reference PriceCatalogSourceMode',
    );
    assert.deepEqual(schemas.PriceCatalogSourceMode.enum, [
      ...PRICE_CATALOG_SOURCE_MODES,
    ]);
    assert.deepEqual(schemas.PriceCatalogEntry.properties.sourceType.enum, [
      'MANUAL',
    ]);
  });

  it('documents the resolver probe vocabulary and typed outcomes', () => {
    const op = spec.paths['/price-catalog/lookup'].get;
    // CR-BE-SVC-01 PART 06 — buildingId/currency/asOf stay required; with
    // SERVICE, itemId/uomId are optional (subject comes from sourceMode +
    // serviceId).
    for (const requiredParam of ['buildingId', 'currency', 'asOf']) {
      const parameter = op.parameters.find(
        (p: any) => p.name === requiredParam,
      );
      assert.ok(parameter?.required, `lookup ${requiredParam} must be required`);
    }
    for (const optionalParam of ['itemId', 'uomId', 'serviceId', 'sourceMode']) {
      const parameter = op.parameters.find(
        (p: any) => p.name === optionalParam,
      );
      assert.ok(parameter, `lookup ${optionalParam} must be documented`);
      assert.ok(
        !parameter.required,
        `lookup ${optionalParam} must be optional (mode-dispatched subject)`,
      );
    }
    const vendor = op.parameters.find((p: any) => p.name === 'vendorId');
    assert.ok(vendor && !vendor.required, 'lookup vendorId stays optional');

    const resultRef =
      op.responses['200'].content['application/json'].schema.allOf[1]
        .properties.data.$ref;
    assert.equal(resultRef, '#/components/schemas/PriceCatalogLookupResult');
    const result = spec.components.schemas.PriceCatalogLookupResult;
    assert.deepEqual(result.required, [
      'resolution',
      'clientId',
      'buildingId',
      'vendorId',
      'sourceMode',
      'itemId',
      'uomId',
      'serviceId',
      'currency',
      'asOf',
      'scopeTier',
      'entry',
    ]);
    // The AMBIGUOUS trip is documented as the fail-closed HTTP error.
    assert.match(op.description, /AMBIGUOUS/);
    assert.match(op.description, /409/);
  });

  it('documents the PO deviation projection and the conjunctive masking boundary', () => {
    const op = spec.paths['/purchase-orders/{id}/price-deviation'].get;
    assert.equal(
      op['x-required-permission'],
      'purchase_order.read + price_catalog.read',
    );
    assert.match(op.description, /advisory/i);
    assert.match(op.description, /never\s+(?:a|an|gates)\b|never gate/i);
    assert.match(op.description, /price_catalog\.read/);

    const dataRef =
      op.responses['200'].content['application/json'].schema.allOf[1]
        .properties.data.$ref;
    assert.equal(dataRef, '#/components/schemas/PurchaseOrderPriceDeviation');
    const projection = spec.components.schemas.PurchaseOrderPriceDeviation;
    assert.deepEqual(projection.properties.advisoryOnly.enum, [true]);
    const line = spec.components.schemas.PurchaseOrderPriceDeviationLine;
    const deviation = spec.components.schemas.PriceCatalogLinePriceReference;
    for (const key of [
      'resolution',
      'priceEntryId',
      'scopeTier',
      'unitPrice',
      'currency',
      'uomId',
      'effectiveFrom',
      'referenceTotal',
      'unitVariance',
      'totalVariance',
      'variancePercent',
      'position',
    ]) {
      assert.ok(deviation.properties[key], `deviation fact ${key}`);
      assert.ok(deviation.required.includes(key));
    }
    assert.equal(line.properties.reference.$ref, '#/components/schemas/PriceCatalogLinePriceReference');

    // Masking boundary: no other PO payload grows price-authority keys — the
    // dedicated projection is the only surface carrying them.
    for (const safe of ['PurchaseOrder', 'PurchaseOrderLine']) {
      assert.equal(
        'reference' in spec.components.schemas[safe].properties,
        false,
        `${safe} must not document reference fields`,
      );
      assert.equal(
        'deviation' in spec.components.schemas[safe].properties,
        false,
      );
    }

    // PART 04 conjunctive extension is documented as optional + masked.
    const offer = spec.components.schemas.RfqComparisonLineOffer;
    assert.ok(offer.properties.reference, 'comparison offer reference');
    assert.match(
      offer.properties.reference.description,
      /price_catalog\.read/,
    );
    assert.ok(
      !offer.required?.includes('reference'),
      'comparison reference stays optional/absent for masked callers',
    );
    assert.ok(spec.components.schemas.RfqComparisonLineReference);
  });
});
