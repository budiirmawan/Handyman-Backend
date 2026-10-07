import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { api } from './helpers/http';
const spec = parse(readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8')) as any;
const operations = [
  'GET /utility/exceptions', 'POST /utility/exceptions',
  'GET /utility/exceptions/{id}', 'POST /utility/exceptions/{id}/start-review',
  'POST /utility/exceptions/{id}/resolve', 'POST /utility/exceptions/{id}/cancel',
];
describe('CR-BE-UTL-01 PART 15 OpenAPI', () => {
  it('publishes only registered protected exception routes', async () => {
    for (const entry of operations) {
      const [method, path] = entry.split(' ');
      const operation = spec.paths[path]?.[method.toLowerCase()];
      assert.ok(operation, entry);
      assert.equal(operation['x-building-scoped'], true);
      assert.ok(operation['x-required-permission']);
      const request = api();
      const response = method === 'GET'
        ? await request.get(`/api/v1${path}`)
        : await request.post(`/api/v1${path}`).send({});
      assert.equal(response.status, 401, entry);
    }
  });
  it('documents references, lifecycle, severity and stable errors', () => {
    assert.deepEqual(spec.components.schemas.UtilityExceptionStatus.enum,
      ['OPEN', 'UNDER_REVIEW', 'RESOLVED', 'CANCELLED']);
    assert.deepEqual(spec.components.schemas.UtilityExceptionSeverity.enum,
      ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
    for (const field of ['meterId', 'meterReadingId', 'readingDueId',
      'consumptionId', 'abnormalConsumptionId', 'ocrCandidateId', 'reconciliationId']) {
      assert.ok(spec.components.schemas.UtilityOperationalException.properties[field]);
    }
    const errors = new Set(spec.components.schemas.UtilityErrorCode.enum);
    for (const code of ['UTILITY_EXCEPTION_NOT_FOUND',
      'UTILITY_EXCEPTION_REFERENCE_INVALID', 'UTILITY_EXCEPTION_ALREADY_OPEN',
      'UTILITY_EXCEPTION_TRANSITION_INVALID']) assert.ok(errors.has(code));
  });
  it('parses with unique operation IDs', () => {
    const ids: string[] = [];
    for (const item of Object.values(spec.paths) as any[]) {
      for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
        if (item[method]) ids.push(item[method].operationId);
      }
    }
    assert.equal(new Set(ids).size, ids.length);
  });
});
