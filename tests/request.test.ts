import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveRequestId } from '../src/middleware/request-id';
import { api } from './helpers/http';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('request ID', () => {
  it('generates a valid UUID and returns it as X-Request-ID', async () => {
    const response = await api().get('/api/v1/health');
    const requestId = response.headers['x-request-id'];

    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.match(String(requestId), UUID_PATTERN);
  });

  it('does not allow a caller-supplied X-Request-ID to replace the server ID', async () => {
    const callerSuppliedId = 'caller-selected-request-id';
    const response = await api()
      .get('/api/v1/health')
      .set('X-Request-ID', callerSuppliedId);

    assert.equal(response.status, 200);
    assert.match(String(response.headers['x-request-id']), UUID_PATTERN);
    assert.notEqual(response.headers['x-request-id'], callerSuppliedId);
    assert.notEqual(resolveRequestId(callerSuppliedId), callerSuppliedId);
  });

  it('generates a fresh UUID for every resolution, including malformed input', () => {
    const first = resolveRequestId('not a valid id');
    const second = resolveRequestId('a'.repeat(200));

    assert.match(first, UUID_PATTERN);
    assert.match(second, UUID_PATTERN);
    assert.notEqual(first, second);
  });

  it('keeps the 404 contract and correlates the error body with X-Request-ID', async () => {
    const response = await api().get('/api/v1/unknown');

    assert.equal(response.status, 404);
    assert.equal(response.body.success, false);
    assert.equal(response.body.error.code, 'NOT_FOUND');
    assert.equal(response.body.error.requestId, response.headers['x-request-id']);
    assert.match(String(response.headers['x-request-id']), UUID_PATTERN);
  });
});
