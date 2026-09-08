import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { api } from './helpers/http';

describe('HTTP security foundation', () => {
  it('sets baseline security headers on GET /api/v1/health', async () => {
    const response = await api().get('/api/v1/health');

    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.ok(response.headers['x-request-id']);
  });

  it('allows a configured local frontend origin', async () => {
    const response = await api()
      .get('/api/v1/health')
      .set('Origin', 'http://localhost:5173');

    assert.equal(response.status, 200);
    assert.equal(
      response.headers['access-control-allow-origin'],
      'http://localhost:5173',
    );
    assert.equal(response.headers['access-control-expose-headers'], 'X-Request-ID');
  });

  it('does not grant CORS permission to an unknown origin', async () => {
    const response = await api()
      .get('/api/v1/health')
      .set('Origin', 'http://evil.example');

    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.notEqual(
      response.headers['access-control-allow-origin'],
      'http://evil.example',
    );
  });

  it('rejects malformed JSON with the shared error contract', async () => {
    const response = await api()
      .post('/api/v1/health')
      .set('content-type', 'application/json')
      .send('{"broken"');

    assert.equal(response.status, 400);
    assert.match(String(response.headers['content-type']), /json/);
    assert.equal(response.body.success, false);
    assert.equal(response.body.error.code, 'BAD_REQUEST');
  });

  it('rejects an oversized JSON payload with a JSON error', async () => {
    const response = await api()
      .post('/api/v1/health')
      .set('content-type', 'application/json')
      .send({ pad: 'x'.repeat(2 * 1024 * 1024) });

    assert.equal(response.status, 413);
    assert.match(String(response.headers['content-type']), /json/);
    assert.equal(response.body.success, false);
    assert.equal(response.body.error.code, 'BAD_REQUEST');
    assert.match(response.body.error.message, /too large/i);
  });
});
