import assert from 'node:assert/strict';
import { it } from 'node:test';
import express from 'express';
import request from 'supertest';
import { parseConfig } from '../src/config';
import { createCorsMiddleware } from '../src/middleware/cors';

it('allows exact HTTPS Vercel origin and Stage 1 bearer/multipart preflight headers', async () => {
  const origin = 'https://care-example.vercel.app';
  const config = parseConfig({ NODE_ENV: 'production', CORS_ORIGINS: origin });
  const app = express();
  app.use(createCorsMiddleware(config.security.corsOrigins));
  const result = await request(app).options('/api/v1/auth/login')
    .set('Origin', origin).set('Access-Control-Request-Method', 'POST')
    .set('Access-Control-Request-Headers', 'authorization,content-type,x-request-id');
  assert.equal(result.status, 204);
  assert.equal(result.headers['access-control-allow-origin'], origin);
  assert.match(result.headers['access-control-allow-headers'], /Authorization/);
  assert.match(result.headers['access-control-allow-headers'], /Content-Type/);
  assert.match(result.headers['access-control-allow-headers'], /X-Request-ID/);
  assert.equal(result.headers['access-control-allow-credentials'], undefined);
});

it('does not allow sibling preview origins or wildcard credentials', async () => {
  const app = express();
  app.use(createCorsMiddleware(['https://care-example.vercel.app']));
  app.get('/', (_req, res) => { res.sendStatus(200); });
  const result = await request(app).get('/').set('Origin', 'https://care-other.vercel.app');
  assert.equal(result.headers['access-control-allow-origin'], undefined);
  assert.throws(() => parseConfig({ CORS_ORIGINS: '*' }), /CORS_ORIGINS/);
});
