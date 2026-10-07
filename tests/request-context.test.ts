import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Request } from 'express';
import { sendSuccess } from '../src/shared/api-response';
import {
  getRequestContext,
  getRequestId,
  runWithRequestContext,
} from '../src/shared/request-context';
import { api } from './helpers/http';

function contextApi() {
  return api({
    configure(application) {
      application.get(
        '/api/v1/__test/request-context',
        async (req: Request, res, next) => {
          try {
            const before = getRequestContext();
            const delayMs = Number(req.query.delay ?? 0);
            await new Promise<void>((resolve) => {
              setTimeout(resolve, Number.isFinite(delayMs) ? delayMs : 0);
            });
            const after = getRequestContext();

            sendSuccess(res, {
              before,
              after,
              requestId: getRequestId(),
            });
          } catch (error) {
            next(error);
          }
        },
      );
    },
  });
}

describe('request context', () => {
  it('retains the same request ID across an async operation', async () => {
    const response = await contextApi().get(
      '/api/v1/__test/request-context?delay=5',
    );

    assert.equal(response.status, 200);
    const headerRequestId = response.headers['x-request-id'];
    assert.equal(response.body.data.requestId, headerRequestId);
    assert.equal(response.body.data.before.requestId, headerRequestId);
    assert.equal(response.body.data.after.requestId, headerRequestId);
    assert.equal(response.body.data.before.source, 'HTTP');
    assert.equal(response.body.data.after.source, 'HTTP');
  });

  it('isolates concurrent requests and gives each a different ID', async () => {
    const client = contextApi();
    const [first, second] = await Promise.all([
      client.get('/api/v1/__test/request-context?delay=25'),
      client.get('/api/v1/__test/request-context?delay=1'),
    ]);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);

    const firstId = first.headers['x-request-id'];
    const secondId = second.headers['x-request-id'];
    assert.notEqual(firstId, secondId);
    assert.equal(first.body.data.requestId, firstId);
    assert.equal(second.body.data.requestId, secondId);
    assert.equal(first.body.data.after.requestId, firstId);
    assert.equal(second.body.data.after.requestId, secondId);
  });

  it('is safe outside an HTTP context and restores the empty context after a run', () => {
    assert.equal(getRequestContext(), undefined);
    assert.equal(getRequestId(), undefined);

    const requestId = randomUUID();
    const inside = runWithRequestContext(
      { requestId, source: 'HTTP' },
      () => getRequestContext(),
    );

    assert.deepEqual(inside, { requestId, source: 'HTTP' });
    assert.equal(getRequestContext(), undefined);
    assert.equal(getRequestId(), undefined);
  });
});
