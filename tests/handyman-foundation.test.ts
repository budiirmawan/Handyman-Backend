import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import express from 'express';
import request from 'supertest';
import {
  HANDYMAN_API_NAMESPACE,
  HANDYMAN_CONTEXT_NAME,
  createHandymanRouter,
} from '../src/modules/handyman-foundation';

type RouterLayer = {
  match?(path: string): boolean;
  handle?: { stack?: unknown };
};

describe('handyman-foundation (HC-00 PART 01)', () => {
  it('exposes the permanent bounded-context identity', () => {
    assert.equal(HANDYMAN_CONTEXT_NAME, 'handyman');
    assert.equal(HANDYMAN_API_NAMESPACE, '/handyman');
    assert.equal(typeof createHandymanRouter, 'function');
  });

  it('provides a mountable namespace gateway router', () => {
    const router = createHandymanRouter();
    const stack = (router as unknown as { stack: unknown }).stack;

    assert.equal(typeof router, 'function');
    assert.equal(Array.isArray(stack), true);
  });

  it('reserves the namespace: mounted router falls through on unmapped paths', async () => {
    const app = express();
    app.use(HANDYMAN_API_NAMESPACE, createHandymanRouter());

    const response = await request(app).get('/handyman/__unmapped__');
    assert.equal(response.status, 404);

    const layers = (app as unknown as { router: { stack: RouterLayer[] } })
      .router.stack;
    const mounted = layers.some(
      (layer) =>
        layer.match?.('/handyman/__probe__') === true &&
        layer.match?.('/elsewhere/__probe__') === false &&
        layer.handle?.stack !== undefined,
    );
    assert.equal(mounted, true);
  });

  // CR-BASELINE-01 FINAL VALIDATION — baseline repaired; the full-app
  // registration tests are active.
  it('mounts the /handyman namespace on the central API router', async () => {
    const { createApiRouter } = await import('../src/routes');
    const stack = (createApiRouter() as unknown as { stack: RouterLayer[] })
      .stack;
    const mounted = stack.some(
      (layer) =>
        layer.match?.('/handyman/__probe__') === true &&
        layer.match?.('/elsewhere/__probe__') === false &&
        layer.handle?.stack !== undefined,
    );
    assert.equal(mounted, true);
  });

  it('reserves the namespace on the full app: unmapped /handyman paths fall through to the standard 404 envelope', async () => {
    const { getAppConfig } = await import('../src/config');
    const { api } = await import('./helpers/http');
    const response = await api().get(
      `${getAppConfig().apiPrefix}/handyman/__unmapped__`,
    );

    assert.equal(response.status, 404);
    assert.equal(response.body.success, false);
    assert.equal(typeof response.body.error?.code, 'string');
    assert.equal(typeof response.body.error?.message, 'string');
    assert.match(String(response.headers['content-type']), /json/);
  });
});
