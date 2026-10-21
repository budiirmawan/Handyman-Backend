import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { api } from './helpers/http';

/**
 * CR-BE-API-01 PART 01 — lightweight OpenAPI contract validation.
 *
 * Validates that docs/api/openapi.yaml (the authoritative Web/Mobile API
 * contract) is a well-formed OpenAPI document with the required foundation
 * (envelope, pagination, security, identifiers) and that every endpoint it
 * documents actually exists in the backend router — the spec must never
 * invent an endpoint (probes run without a database; protected routes are
 * rejected by the authentication middleware before any DB access).
 */

const SPEC_PATH = resolve(__dirname, '../docs/api/openapi.yaml');
const API_PREFIX = '/api/v1';

function loadSpec(): Record<string, unknown> {
  const doc = parse(readFileSync(SPEC_PATH, 'utf8'));
  assert.ok(doc && typeof doc === 'object', 'openapi.yaml must parse as YAML');
  return doc as Record<string, unknown>;
}

describe('OpenAPI contract foundation (docs/api/openapi.yaml)', () => {
  const spec = loadSpec();

  it('declares OpenAPI 3.x metadata and the versioned base path', () => {
    assert.equal(spec.openapi, '3.0.3');
    const info = spec.info as Record<string, unknown>;
    assert.ok(info.title, 'info.title required');
    assert.ok(info.version, 'info.version required');
    const servers = spec.servers as { url?: string }[];
    assert.ok(
      servers.some((server) => server.url === API_PREFIX),
      'server base path must be /api/v1',
    );
  });

  it('defines the bearer authentication security scheme', () => {
    const components = spec.components as {
      securitySchemes?: Record<string, unknown>;
    };
    const scheme = components.securitySchemes?.bearerAuth as
      | Record<string, string>
      | undefined;
    assert.ok(scheme, 'components.securitySchemes.bearerAuth required');
    assert.equal(scheme.type, 'http');
    assert.equal(scheme.scheme, 'bearer');
  });

  it('defines the standard success/error envelope schemas', () => {
    const schemas = (spec.components as {
      schemas?: Record<string, unknown>;
    }).schemas as Record<string, { required?: string[] }>;
    for (const name of ['SuccessEnvelope', 'ErrorEnvelope']) {
      assert.ok(schemas[name], `schema ${name} required`);
      assert.ok(
        (schemas[name].required ?? []).includes('success'),
        `${name} must require success`,
      );
    }
  });

  it('defines the pagination metadata schema and reusable responses', () => {
    const components = spec.components as {
      schemas?: Record<string, unknown>;
      responses?: Record<string, unknown>;
    };
    assert.ok(components.schemas?.PaginationMeta, 'PaginationMeta schema required');
    for (const name of [
      'BadRequest',
      'Unauthorized',
      'Forbidden',
      'NotFound',
      'InternalServerError',
    ]) {
      assert.ok(
        components.responses?.[name],
        `reusable response ${name} required`,
      );
    }
  });

  it('documents only endpoints that exist in the backend router', async () => {
    const paths = (spec.paths as Record<string, Record<string, unknown>>) ?? {};
    const documented = Object.entries(paths).flatMap(([path, item]) =>
      Object.entries(item)
        .filter(([method]) => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
        .map(([method]) => ({ method, path })),
    );
    assert.ok(documented.length > 0, 'at least one path must be documented');

    // The WhatsApp provider webhook is the one documented surface mounted
    // OUTSIDE the versioned API prefix (src/app.ts mounts it at
    // `/webhooks/notifications/whatsapp`, before the JSON parser) and only
    // when WHATSAPP_WEBHOOK_ENABLED=true with its secrets. Enable it with
    // test-only secrets so this probe verifies its real mount instead of
    // probing a non-existent `/api/v1/webhooks/...` URL.
    const savedWebhookEnv = {
      enabled: process.env.WHATSAPP_WEBHOOK_ENABLED,
      secret: process.env.WHATSAPP_META_APP_SECRET,
      token: process.env.WHATSAPP_META_WEBHOOK_VERIFY_TOKEN,
    };
    process.env.WHATSAPP_WEBHOOK_ENABLED = 'true';
    process.env.WHATSAPP_META_APP_SECRET = 'openapi-contract-test-secret';
    process.env.WHATSAPP_META_WEBHOOK_VERIFY_TOKEN =
      'openapi-contract-test-verify-token';

    const request = api();

    for (const { method, path } of documented) {
      const url = path.startsWith('/webhooks/')
        ? path
        : `${API_PREFIX}${path}`;
      let response: Awaited<ReturnType<typeof request.get>>;

      if (method === 'get') {
        response = await request.get(url);
      } else if (method === 'post') {
        response = await request.post(url).send({});
      } else if (method === 'put') {
        response = await request.put(url).send({});
      } else if (method === 'patch') {
        response = await request.patch(url).send({});
      } else {
        response = await request.delete(url);
      }

      // The endpoint is registered when the router handles it. Unknown
      // routes always fall through to the 404 NOT_FOUND handler.
      assert.notEqual(
        response.status,
        404,
        `${method.toUpperCase()} ${path} is documented but not registered (got 404)`,
      );
    }

    if (savedWebhookEnv.enabled === undefined)
      delete process.env.WHATSAPP_WEBHOOK_ENABLED;
    else process.env.WHATSAPP_WEBHOOK_ENABLED = savedWebhookEnv.enabled;
    if (savedWebhookEnv.secret === undefined)
      delete process.env.WHATSAPP_META_APP_SECRET;
    else process.env.WHATSAPP_META_APP_SECRET = savedWebhookEnv.secret;
    if (savedWebhookEnv.token === undefined)
      delete process.env.WHATSAPP_META_WEBHOOK_VERIFY_TOKEN;
    else process.env.WHATSAPP_META_WEBHOOK_VERIFY_TOKEN = savedWebhookEnv.token;
  });

  it('documents the governed IAM invitation, role, Building, lifecycle and audit contract', () => {
    const paths = spec.paths as Record<string, Record<string, Record<string, unknown>>>;
    const schemas = (spec.components as { schemas: Record<string, Record<string, unknown>> }).schemas;

    assert.equal(paths['/invitations'].post['x-required-permission'], 'user.manage');
    assert.equal(paths['/invitations'].get['x-required-permission'], 'user.manage');
    assert.equal(paths['/invitations/{id}'].get['x-required-permission'], 'user.manage');
    assert.deepEqual(paths['/invitations/validate'].post.security, []);
    assert.deepEqual(paths['/invitations/accept'].post.security, []);
    assert.equal(paths['/invitations/accept'].post['x-required-permission'], undefined);

    const invitationCreated = schemas.InvitationCreated.properties as Record<string, unknown>;
    assert.ok(invitationCreated.invitationToken, 'create response discloses the token once');
    assert.ok(invitationCreated.delivery, 'delivery availability is explicit');
    const publicInvitation = schemas.PublicInvitation.properties as Record<string, unknown>;
    assert.equal(publicInvitation.invitationToken, undefined);
    assert.equal(publicInvitation.tokenHash, undefined);
    assert.deepEqual(
      (publicInvitation.status as { enum: string[] }).enum,
      ['PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED'],
    );

    assert.equal(paths['/users/{userId}/roles'].post['x-required-permission'], 'role.manage');
    assert.equal(paths['/users/{userId}/roles/{roleId}'].delete['x-required-permission'], 'role.manage');
    assert.equal(paths['/users/{userId}/buildings'].post['x-required-permission'], 'building.manage');
    assert.equal(paths['/users/{userId}/buildings'].get['x-required-permission'], 'building.read');
    assert.equal(paths['/users/{userId}/buildings/{buildingId}'].delete['x-required-permission'], 'building.manage');
    assert.equal(paths['/users/{userId}/suspend'].post['x-required-permission'], 'user.manage');
    assert.equal(paths['/users/{userId}/reactivate'].post['x-required-permission'], 'user.manage');
    assert.equal(paths['/auth/audit-events'].get['x-required-permission'], 'auth.audit.read');

    const auditEvents = schemas.AuditEvent.properties as Record<string, { enum?: string[] }>;
    assert.ok(auditEvents.eventType.enum?.includes('ROLE_ASSIGNED'));
    assert.ok(auditEvents.eventType.enum?.includes('BUILDING_REVOKED'));
  });

  it('matches the real protected/public behavior of documented endpoints', async () => {
    const request = api();

    // Public: health is alive without authentication.
    const health = await request.get(`${API_PREFIX}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.body.success, true);

    // Public: database readiness is registered (200 when connected, 503 when
    // the test environment has no database — never 404).
    const database = await request.get(`${API_PREFIX}/health/database`);
    assert.ok(
      [200, 503].includes(database.status),
      'GET /health/database must be handled (200 or 503)',
    );

    // Public: login with an empty body is rejected by validation before any
    // database access.
    const login = await request.post(`${API_PREFIX}/auth/login`).send({});
    assert.equal(login.status, 400);
    assert.equal(login.body.error.code, 'VALIDATION_ERROR');

    // Protected: no bearer token → 401 AUTHENTICATION_REQUIRED (no DB access).
    const protectedGets = ['/auth/me', '/auth/audit-events', '/auth/me/buildings'];
    for (const path of protectedGets) {
      const response = await request.get(`${API_PREFIX}${path}`);
      assert.equal(response.status, 401, `${path} must require authentication`);
      assert.equal(response.body.error.code, 'AUTHENTICATION_REQUIRED');
    }
    const logout = await request.post(`${API_PREFIX}/auth/logout`).send({});
    assert.equal(logout.status, 401, '/auth/logout must require authentication');
    assert.equal(logout.body.error.code, 'AUTHENTICATION_REQUIRED');
  });
});
