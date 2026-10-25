import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { parseCreateCareHandymanServiceRequestBody } from '../src/modules/handyman-api/handyman-api.validation';
import { parseCreateBuildingCareRequestBody } from '../src/modules/handyman-care-standalone-discovery/handyman-care-tenant-request-gateway.validation';

const serviceCatalogId = randomUUID();
const parsers = [
  { parse: parseCreateCareHandymanServiceRequestBody, base: { exchangeToken: 'test-only-opaque-exchange', serviceCatalogId } },
  { parse: parseCreateBuildingCareRequestBody, base: { tenantCompanyId: randomUUID(), serviceCatalogId } },
];

test('both existing Care DTOs retain no-date clients and normalize the same optional requested-date pair', () => {
  for (const { parse, base } of parsers) {
    const legacy = parse(base);
    assert.equal('preferredWindowStart' in legacy, false);
    assert.equal('preferredWindowEnd' in legacy, false);
    const dated = parse({ ...base, preferredWindowStart: '2031-12-10T10:00:00+07:00', preferredWindowEnd: '2031-12-10T12:00:00+07:00' });
    assert.equal(dated.preferredWindowStart, '2031-12-10T03:00:00.000Z');
    assert.equal(dated.preferredWindowEnd, '2031-12-10T05:00:00.000Z');
  }
});

test('both Care DTOs reject partial/invalid dates and caller timezone or recording identity', () => {
  for (const { parse, base } of parsers) {
    for (const dates of [
      { preferredWindowStart: '2031-12-10T10:00:00Z' },
      { preferredWindowEnd: '2031-12-10T12:00:00Z' },
      { preferredWindowStart: null, preferredWindowEnd: null },
      { preferredWindowStart: '2031-12-10T10:00:00', preferredWindowEnd: '2031-12-10T12:00:00' },
      { preferredWindowStart: '2031-02-30T10:00:00Z', preferredWindowEnd: '2031-03-01T12:00:00Z' },
      { preferredWindowStart: '2031-12-10T24:00:00Z', preferredWindowEnd: '2031-12-11T12:00:00Z' },
      { preferredWindowStart: '2031-12-10T10:00:00+99:00', preferredWindowEnd: '2031-12-10T12:00:00Z' },
      { preferredWindowStart: '2031-12-10T12:00:00Z', preferredWindowEnd: '2031-12-10T10:00:00Z' },
    ]) assert.throws(() => parse({ ...base, ...dates }));
    for (const field of ['timezone', 'clientId', 'createdByUserId', 'careActorId', 'assignmentId', 'confirmed']) {
      assert.throws(() => parse({ ...base, [field]: randomUUID() }), field);
    }
  }
});

test('OpenAPI documents both optional pairs, the safe creation projection and nullable Care provenance without changing generic intake', () => {
  const spec = parseYaml(readFileSync(new URL('../docs/api/openapi.yaml', import.meta.url), 'utf8'));
  const schemas = spec.components.schemas;
  for (const name of ['CreateCareHandymanServiceRequest', 'HandymanCareRequestCreateBody']) {
    const schema = schemas[name];
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties.preferredWindowStart.format, 'date-time');
    assert.equal(schema.properties.preferredWindowEnd.format, 'date-time');
    assert.ok(!schema.required.includes('preferredWindowStart'));
    assert.deepEqual(schema.oneOf[0].required, ['preferredWindowStart', 'preferredWindowEnd']);
  }
  const safe = schemas.HandymanCareSchedulingPreference;
  assert.equal(safe.additionalProperties, false);
  assert.deepEqual(Object.keys(safe.properties).sort(), ['id', 'timezone', 'preferredWindowStart', 'preferredWindowEnd', 'status', 'supersedesReadinessId'].sort());
  assert.equal(schemas.HandymanSchedulingReadinessRecord.properties.createdByUserId.nullable, true);
  assert.equal(schemas.CreateHandymanServiceRequest.properties.preferredWindowStart, undefined);
  for (const name of ['HandymanServiceRequest', 'HandymanCareStandaloneRequest']) {
    assert.equal(schemas[name].properties.schedulingReadiness.$ref, '#/components/schemas/HandymanCareSchedulingPreference');
    assert.ok(!schemas[name].required.includes('schedulingReadiness'));
  }
});
