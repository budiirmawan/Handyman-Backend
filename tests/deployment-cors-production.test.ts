import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import express from 'express';
import request from 'supertest';
import { parseConfig, resetAppConfigCache } from '../src/config';
import {
  CORS_ALLOWED_REQUEST_HEADERS,
  createCorsMiddleware,
  toExactCorsOrigin,
} from '../src/middleware/cors';
import { migrations } from '../src/database/migrations';
import { api } from './helpers/http';

/**
 * CR-HM-BE-CORS-PRODUCTION-01 — focused production CORS verification.
 *
 * The Vercel frontend (`https://handyman-frontend-alpha.vercel.app`) calls the
 * Railway API (`https://handyman-backend-production-8b01.up.railway.app`) from
 * a browser, so the API must answer the browser preflight for that exact
 * origin — including the `Idempotency-Key` request header used by the
 * duplicate-risky command routes — while refusing every other origin.
 *
 * These checks are deliberately narrow: no database, no deployment, no
 * migration and no live Railway/Vercel call.
 */

const PRODUCTION_ORIGIN = 'https://handyman-frontend-alpha.vercel.app';
const SIBLING_PREVIEW_ORIGIN = 'https://handyman-frontend-alpha-1a2b3c.vercel.app';
const UNAPPROVED_ORIGIN = 'https://evil.example';

function allowedHeaderList(response: request.Response): string[] {
  const header = response.headers['access-control-allow-headers'];
  assert.ok(header, 'Access-Control-Allow-Headers must be present');
  return String(header)
    .split(',')
    .map((value) => value.trim().toLowerCase());
}

describe('CR-HM-BE-CORS-PRODUCTION-01 — production CORS allowlist', () => {
  it('parses the exact Railway CORS_ORIGINS value into a one-entry exact allowlist', () => {
    const config = parseConfig({
      NODE_ENV: 'production',
      CORS_ORIGINS: PRODUCTION_ORIGIN,
    });

    assert.deepEqual(config.security.corsOrigins, [PRODUCTION_ORIGIN]);
  });

  it('keeps the allowlist exact — a wildcard or a non-origin value is rejected', () => {
    assert.throws(
      () => parseConfig({ NODE_ENV: 'production', CORS_ORIGINS: '*' }),
      /Invalid configuration: CORS_ORIGINS/,
    );
    assert.throws(
      () =>
        parseConfig({
          NODE_ENV: 'production',
          CORS_ORIGINS: 'https://*.vercel.app',
        }),
      /Invalid configuration: CORS_ORIGINS/,
    );
    assert.throws(
      () => parseConfig({ NODE_ENV: 'production', CORS_ORIGINS: 'not-an-origin' }),
      /Invalid configuration: CORS_ORIGINS/,
    );
  });

  it('normalizes a differently-cased host to the exact origin a browser sends', () => {
    const config = parseConfig({
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://Handyman-Frontend-Alpha.Vercel.App',
    });

    assert.deepEqual(config.security.corsOrigins, [PRODUCTION_ORIGIN]);
  });

  it('never accepts a wildcard or a non-exact origin at the middleware boundary', () => {
    assert.equal(toExactCorsOrigin('*'), null);
    assert.equal(toExactCorsOrigin('https://*.vercel.app'), null);
    assert.equal(toExactCorsOrigin('https://example.com/path'), null);
    assert.equal(toExactCorsOrigin('https://user:pass@example.com'), null);
    assert.equal(toExactCorsOrigin('not-an-origin'), null);
    assert.equal(toExactCorsOrigin(''), null);
    assert.equal(toExactCorsOrigin(PRODUCTION_ORIGIN), PRODUCTION_ORIGIN);
    assert.equal(
      toExactCorsOrigin(`${PRODUCTION_ORIGIN}/`),
      PRODUCTION_ORIGIN,
    );
  });

  it('does not grant a wildcard origin even if one reaches the middleware', async () => {
    const app = express();
    app.use(createCorsMiddleware(['*']));
    app.get('/probe', (_req, res) => {
      res.sendStatus(200);
    });

    const response = await request(app)
      .get('/probe')
      .set('Origin', PRODUCTION_ORIGIN);

    assert.equal(response.status, 200);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  });
});

describe('CR-HM-BE-CORS-PRODUCTION-01 — browser preflight from the Vercel origin', () => {
  it('answers the OPTIONS preflight with the exact origin and 204', async () => {
    const config = parseConfig({
      NODE_ENV: 'production',
      CORS_ORIGINS: PRODUCTION_ORIGIN,
    });
    const app = express();
    app.use(createCorsMiddleware(config.security.corsOrigins));

    const response = await request(app)
      .options('/api/v1/auth/login')
      .set('Origin', PRODUCTION_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set(
        'Access-Control-Request-Headers',
        'authorization,content-type,x-request-id',
      );

    assert.equal(response.status, 204);
    assert.equal(
      response.headers['access-control-allow-origin'],
      PRODUCTION_ORIGIN,
    );
    assert.match(String(response.headers['access-control-allow-methods']), /POST/);
    assert.match(String(response.headers['vary']), /Origin/);
    assert.equal(response.headers['access-control-allow-credentials'], undefined);
    assert.equal(
      response.headers['access-control-expose-headers'],
      'X-Request-ID',
    );
  });

  it('permits Content-Type, Authorization, X-Request-ID and Idempotency-Key', async () => {
    const config = parseConfig({
      NODE_ENV: 'production',
      CORS_ORIGINS: PRODUCTION_ORIGIN,
    });
    const app = express();
    app.use(createCorsMiddleware(config.security.corsOrigins));

    const response = await request(app)
      .options('/api/v1/mobile/assets/00000000-0000-4000-8000-000000000000/unsafe-condition')
      .set('Origin', PRODUCTION_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set(
        'Access-Control-Request-Headers',
        'authorization,content-type,x-request-id,idempotency-key',
      );

    assert.equal(response.status, 204);
    assert.equal(
      response.headers['access-control-allow-origin'],
      PRODUCTION_ORIGIN,
    );

    const allowed = allowedHeaderList(response);
    assert.ok(allowed.includes('content-type'));
    assert.ok(allowed.includes('authorization'));
    assert.ok(allowed.includes('x-request-id'));
    assert.ok(
      allowed.includes('idempotency-key'),
      'Idempotency-Key must pass the browser preflight',
    );
  });

  it('does not allow If-Match, which no registered backend route requires', () => {
    assert.ok(!CORS_ALLOWED_REQUEST_HEADERS.includes('If-Match' as never));
    assert.ok(
      !CORS_ALLOWED_REQUEST_HEADERS.some(
        (header) => header.toLowerCase() === 'if-match',
      ),
    );
  });

  it('keeps the allowed request header set to the verified contract', () => {
    assert.deepEqual(
      [...CORS_ALLOWED_REQUEST_HEADERS].sort(),
      ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Request-ID'],
    );
  });
});

describe('CR-HM-BE-CORS-PRODUCTION-01 — unapproved origins', () => {
  it('does not grant browser CORS access to an unapproved origin', async () => {
    const config = parseConfig({
      NODE_ENV: 'production',
      CORS_ORIGINS: PRODUCTION_ORIGIN,
    });
    const app = express();
    app.use(createCorsMiddleware(config.security.corsOrigins));
    app.get('/probe', (_req, res) => {
      res.sendStatus(200);
    });

    const preflight = await request(app)
      .options('/api/v1/auth/login')
      .set('Origin', UNAPPROVED_ORIGIN)
      .set('Access-Control-Request-Method', 'POST');

    assert.equal(preflight.headers['access-control-allow-origin'], undefined);

    const simple = await request(app)
      .get('/probe')
      .set('Origin', UNAPPROVED_ORIGIN);

    assert.equal(simple.status, 200);
    assert.equal(simple.headers['access-control-allow-origin'], undefined);
  });

  it('does not grant a sibling Vercel preview origin', async () => {
    const config = parseConfig({
      NODE_ENV: 'production',
      CORS_ORIGINS: PRODUCTION_ORIGIN,
    });
    const app = express();
    app.use(createCorsMiddleware(config.security.corsOrigins));
    app.get('/probe', (_req, res) => {
      res.sendStatus(200);
    });

    const response = await request(app)
      .get('/probe')
      .set('Origin', SIBLING_PREVIEW_ORIGIN);

    assert.equal(response.status, 200);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  });
});

describe('CR-HM-BE-CORS-PRODUCTION-01 — application regression', () => {
  const previousCorsOrigins = process.env.CORS_ORIGINS;

  before(() => {
    process.env.CORS_ORIGINS = PRODUCTION_ORIGIN;
    resetAppConfigCache();
  });

  after(() => {
    if (previousCorsOrigins === undefined) {
      delete process.env.CORS_ORIGINS;
    } else {
      process.env.CORS_ORIGINS = previousCorsOrigins;
    }
    resetAppConfigCache();
  });

  it('keeps authenticated endpoints protected for the allowed origin', async () => {
    const response = await api()
      .get('/api/v1/auth/me')
      .set('Origin', PRODUCTION_ORIGIN);

    assert.equal(response.status, 401);
    assert.equal(response.body.success, false);
    assert.equal(response.body.error.code, 'AUTHENTICATION_REQUIRED');
    assert.equal(
      response.headers['access-control-allow-origin'],
      PRODUCTION_ORIGIN,
    );
    // No database connection detail may reach a browser client.
    const serialized = JSON.stringify(response.body).toLowerCase();
    for (const secret of ['password', 'db_password', 'postgres://', 'postgresql://']) {
      assert.ok(!serialized.includes(secret), `response must not expose ${secret}`);
    }
  });

  it('keeps the database readiness endpoint registered and unchanged', async () => {
    const response = await api()
      .get('/api/v1/health/database')
      .set('Origin', PRODUCTION_ORIGIN);

    assert.ok(
      [200, 503].includes(response.status),
      'GET /health/database must stay registered (200 or 503)',
    );
    assert.equal(response.body.success, response.status === 200);
    assert.equal(
      response.headers['access-control-allow-origin'],
      PRODUCTION_ORIGIN,
    );
  });

  it('keeps the live liveness endpoint public', async () => {
    const response = await api()
      .get('/api/v1/health')
      .set('Origin', PRODUCTION_ORIGIN);

    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
  });

  it('does not change the Idempotency-Key request contract', async () => {
    const { parseIdempotencyKeyRequired } = await import(
      '../src/modules/request-idempotency/request-idempotency.validation'
    );

    assert.equal(parseIdempotencyKeyRequired('  key-1  '), 'key-1');
    assert.throws(
      () => parseIdempotencyKeyRequired(undefined),
      /Idempotency-Key is required/,
    );
    assert.throws(
      () => parseIdempotencyKeyRequired('a'.repeat(201)),
      (error: unknown) => {
        const details = (error as { details?: { message: string }[] }).details;
        return (
          Array.isArray(details) &&
          details.some((detail) =>
            detail.message.includes(
              'Idempotency-Key must be at most 200 characters',
            ),
          )
        );
      },
    );
  });

  it('keeps the canonical migration registry append-only', () => {
    // CR-HM-IAM-BOOTSTRAP-01 added the first-owner state,
    // CR-HM-BE-IAM-ADMIN-02 added role/building IAM audit event vocabulary,
    // CR-HM-BE-CLIENT-MASTER-01 appended 0454,
    // CR-HM-CC-TENANT-REQUEST-GATEWAY-01 appended 0455 (Backend Customer
    // Care origin channel), CR-HM-MASTER-IND-01 appended 0456 (Indonesian
    // apartment master data), CR-HM-MASTER-TENANT-BATCH-01 appended 0457
    // (tenant batch import) and CR-HM-E2E-FINANCIAL-RECONCILIATION
    // appended 0458 (DP terms, obligation stage, BAST re-preparation,
    // variation charge composition, Manager FINAL CLOSE). All additive;
    // no existing migration rewritten.
    assert.equal(migrations.length, 457);
    assert.equal(
      migrations[migrations.length - 1].id,
      '0458_handyman_e2e_financial_reconciliation_close',
    );
  });
});
