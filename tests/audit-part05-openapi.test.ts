import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parse } from 'yaml';

const openapi = parse(readFileSync('docs/api/openapi.yaml', 'utf8')) as any;
const requestIdMiddleware = readFileSync('src/middleware/request-id.ts', 'utf8');
const errorHandler = readFileSync('src/middleware/error-handler.ts', 'utf8');
const requestContext = readFileSync('src/shared/request-context.ts', 'utf8');
const operationalEvents = readFileSync('src/modules/operational-events/index.ts', 'utf8');
const operationalRoutes = readFileSync(
  'src/modules/operational-events/operational-event.routes.ts',
  'utf8',
);
const dispatcher = readFileSync(
  'src/modules/due-job-dispatcher/due-job-dispatcher.service.ts',
  'utf8',
);
const outbox = readFileSync(
  'src/modules/integration-outbox/integration-outbox.enqueue.ts',
  'utf8',
);

/**
 * CR-BE-AUDIT-01 PART 05 — OpenAPI and cross-module alignment.
 *
 * This is a contract/documentation test only. It does not add runtime
 * capability, touch the scheduler, or exercise the broad regression suite.
 */

describe('CR-BE-AUDIT-01 PART 05 — correlation OpenAPI contract', () => {
  it('publishes the reusable request header and error requestId contract', () => {
    const header = openapi.components?.headers?.RequestId;
    assert.ok(header, 'components.headers.RequestId is required');
    assert.equal(header.required, true);
    assert.equal(header.schema.type, 'string');
    assert.equal(header.schema.format, 'uuid');
    assert.match(header.description, /server-generated UUID/i);

    const errorRequestId =
      openapi.components.schemas.ErrorEnvelope.properties.error.properties.requestId;
    assert.equal(errorRequestId.type, 'string');
    assert.equal(errorRequestId.format, 'uuid');
    assert.match(errorRequestId.description, /X-Request-ID/);

    for (const responseName of [
      'BadRequest',
      'Unauthorized',
      'InvalidCredentials',
      'Forbidden',
      'NotFound',
      'Conflict',
      'UnprocessableEntity',
      'RateLimited',
      'InternalServerError',
      'DatabaseUnavailable',
    ]) {
      assert.deepEqual(
        openapi.components.responses[responseName].headers['X-Request-ID'],
        { $ref: '#/components/headers/RequestId' },
        `${responseName} must document X-Request-ID`,
      );
    }
  });

  it('documents the operational audit list/detail routes and all runtime filters', () => {
    const list = openapi.paths['/operational-events']?.get;
    const detail = openapi.paths['/operational-events/{eventId}']?.get;
    assert.ok(list);
    assert.ok(detail);
    assert.equal(list.operationId, 'listOperationalEvents');
    assert.equal(detail.operationId, 'getOperationalEvent');
    assert.equal(list['x-required-permission'], 'operational_event.read');
    assert.equal(detail['x-required-permission'], 'operational_event.read');
    assert.equal(list['x-building-scoped'], true);
    assert.equal(detail['x-building-scoped'], true);

    const parameterNames = new Set(
      list.parameters
        .filter((parameter: any) => parameter.in === 'query')
        .map((parameter: any) => parameter.name),
    );
    assert.deepEqual(
      [...parameterNames].sort(),
      [
        'actorUserId',
        'buildingId',
        'clientId',
        'entityId',
        'entityType',
        'eventType',
        'from',
        'page',
        'pageSize',
        'requestId',
        'source',
        'to',
      ].sort(),
    );

    const page = list.parameters.find((parameter: any) => parameter.name === 'page');
    const pageSize = list.parameters.find(
      (parameter: any) => parameter.name === 'pageSize',
    );
    assert.equal(page.schema.minimum, 1);
    assert.equal(page.schema.default, 1);
    assert.equal(pageSize.schema.minimum, 1);
    assert.equal(pageSize.schema.maximum, 200);
    assert.equal(pageSize.schema.default, 50);

    assert.deepEqual(list.responses['200'].headers['X-Request-ID'], {
      $ref: '#/components/headers/RequestId',
    });
    assert.deepEqual(detail.responses['200'].headers['X-Request-ID'], {
      $ref: '#/components/headers/RequestId',
    });
    assert.equal(list.responses['200'].content['application/json'].schema.allOf[1].properties.meta.$ref,
      '#/components/schemas/MobilePaginationMeta');
    assert.equal(detail.responses['200'].content['application/json'].schema.allOf[1].properties.data.$ref,
      '#/components/schemas/OperationalEvent');

    for (const method of ['post', 'put', 'patch', 'delete']) {
      assert.equal(list[method], undefined, `list must not expose ${method}`);
      assert.equal(detail[method], undefined, `detail must not expose ${method}`);
    }
  });

  it('documents the additive event fields and governed source vocabulary', () => {
    const source = openapi.components.schemas.OperationalEventSource;
    const event = openapi.components.schemas.OperationalEvent;
    assert.deepEqual(source.enum, ['HTTP', 'SCHEDULER', 'SYSTEM']);
    assert.ok(event.required.includes('requestId'));
    assert.ok(event.required.includes('source'));
    assert.equal(event.properties.requestId.allOf[0].$ref, '#/components/schemas/Uuid');
    assert.equal(event.properties.requestId.nullable, true);
    assert.equal(event.properties.source.allOf[0].$ref, '#/components/schemas/OperationalEventSource');
    assert.equal(event.properties.source.nullable, true);
    assert.match(event.description, /historical rows may return null/i);
  });
});

describe('CR-BE-AUDIT-01 PART 05 — cross-module alignment', () => {
  it('keeps HTTP, persistence, scheduler, read, and outbox authorities aligned', () => {
    assert.match(requestIdMiddleware, /randomUUID\(\)/);
    assert.match(requestIdMiddleware, /setHeader\(REQUEST_ID_HEADER, requestId\)/);
    assert.match(requestIdMiddleware, /runWithRequestContext/);
    assert.match(errorHandler, /sendAppError\(res, error, \{ requestId: req\.requestId \}\)/);
    assert.match(requestContext, /AsyncLocalStorage<RequestContext>/);
    assert.match(requestContext, /SCHEDULER_CONTEXT_SOURCE = 'SCHEDULER'/);
    assert.match(requestContext, /SYSTEM_CONTEXT_SOURCE = 'SYSTEM'/);

    assert.match(operationalEvents, /getRequestContext\(\)/);
    assert.match(operationalEvents, /request_id, source/);
    assert.match(operationalRoutes, /requestId: row\.request_id/);
    assert.match(operationalRoutes, /source: row\.source/);
    assert.match(operationalRoutes, /ORDER BY occurred_at DESC, id DESC/);
    assert.match(operationalRoutes, /operational_event\.read/);
    assert.match(dispatcher, /runWithSchedulerContext/);
    assert.match(dispatcher, /processDueOperationalJobsInContext/);

    // CR-BE-INTEG-01 remains the event → outbox authority and receives the
    // authoritative event row on the existing executor; PART 05 documents it
    // but does not create a second integration correlation path.
    assert.match(operationalEvents, /maybeEnqueueIntegrationOutboxEvent\(record, executor\)/);
    assert.match(outbox, /createOnConflictReturn/);
    assert.match(outbox, /executor/);
  });
});
