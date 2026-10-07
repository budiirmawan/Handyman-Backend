import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';

const spec = parse(readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8')) as any;
const routes = [
  'src/modules/rfqs/rfq.routes.ts',
  'src/modules/rfq-vendor-invitations/rfq-vendor-invitation.routes.ts',
  'src/modules/vendor-quotations/vendor-quotation.routes.ts',
  'src/modules/rfq-comparisons/rfq-comparison.routes.ts',
  'src/modules/rfq-recommendations/rfq-recommendation.routes.ts',
  'src/modules/rfq-po-conversions/rfq-po-conversion.routes.ts',
].map((file) => readFileSync(resolve(__dirname, '..', file), 'utf8')).join('\n');

describe('CR-BE-PRO-02 PART 06 — RFQ OpenAPI closure', () => {
  it('parses and documents the complete PART 01–06 RFQ surface', () => {
    const required = [
      '/rfqs',
      '/rfqs/{rfqId}',
      '/rfqs/{rfqId}/lines',
      '/rfqs/{rfqId}/invitations',
      '/vendor-rfq-access/exchange',
      '/vendor-rfq-access/quotations/{quotationId}/revisions',
      '/vendor-rfq-access/quotation-revisions/{revisionId}/attachments',
      '/rfqs/{rfqId}/quotations',
      '/rfqs/{rfqId}/comparisons',
      '/rfq-comparisons/{comparisonId}/evaluations',
      '/rfqs/{rfqId}/recommendations',
      '/rfq-recommendations/{recommendationId}/award',
      '/rfq-awards/{awardId}/convert-to-po',
      '/rfq-po-conversions/{conversionId}',
      '/purchase-orders/{purchaseOrderId}/rfq-provenance',
    ];
    for (const path of required) assert.ok(spec.paths[path], `missing OpenAPI path ${path}`);
    assert.equal(spec.components.securitySchemes.vendorRfqSession.type, 'http');
    assert.ok(spec.components.schemas.Rfq);
    assert.ok(spec.components.schemas.VendorQuotationRevision);
    assert.ok(spec.components.schemas.RfqComparison);
    assert.ok(spec.components.schemas.RfqRecommendation);
    assert.ok(spec.components.schemas.RfqAward);
    assert.ok(spec.components.schemas.RfqPoConversion);
  });

  it('makes external sessions, sensitive award permission, and financial boundary explicit', () => {
    assert.deepEqual(spec.paths['/vendor-rfq-access/me'].get.security, [{ vendorRfqSession: [] }]);
    assert.equal(spec.paths['/rfq-recommendations/{recommendationId}/award'].post['x-required-permission'], 'rfq.award');
    assert.equal(spec.paths['/rfq-awards/{awardId}/convert-to-po'].post['x-required-permission'], 'rfq.award');
    assert.match(spec.paths['/rfq-awards/{awardId}/convert-to-po'].post.description, /no commitment/i);
    assert.match(spec.paths['/vendor-rfq-access/rfqs/{rfqId}'].get.description, /no peer quotation/i);
    assert.match(routes, /rfqVendorSessionMiddleware/);
    assert.match(routes, /requirePermission\('rfq\.award'\)/);
  });
});
