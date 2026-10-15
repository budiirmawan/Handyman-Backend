import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';

const spec = parse(readFileSync(
  resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8',
)) as {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any> };
};

function resolveLocalRef(ref: string): unknown {
  assert.ok(ref.startsWith('#/'), `expected local OpenAPI ref: ${ref}`);
  return ref.slice(2).split('/').reduce<unknown>((value, part) => {
    if (!value || typeof value !== 'object') return undefined;
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    return (value as Record<string, unknown>)[key];
  }, spec);
}

describe('CR-HM-BAST-WORKER-READ-01 OpenAPI contract', () => {
  const path = '/handyman/field/execution-scopes/{executionScopeId}/bast';
  const operation = spec.paths[path]?.get;

  it('documents the authorized, read-only worker GET and success envelope', () => {
    assert.ok(operation, `GET ${path} must be documented`);
    assert.equal(operation.operationId, 'getHandymanWorkerExecutionScopeBast');
    assert.equal(operation['x-required-permission'], 'handyman.bast.manage');
    assert.equal(operation['x-building-scoped'], true);
    assert.equal(operation['x-current-assignment-role'], 'CREW_LEAD');
    assert.ok(operation.description.includes('read-only'));
    assert.ok(operation.parameters.some((parameter: any) =>
      parameter.$ref === '#/components/parameters/ExecutionScopeIdPath'));
    assert.equal(
      operation.responses['200'].content['application/json'].schema
        .allOf[1].properties.data.$ref,
      '#/components/schemas/HandymanBastWorkerReadView',
    );
    for (const status of ['400', '401', '403', '404']) {
      assert.ok(operation.responses[status], `missing ${status} response`);
    }
  });

  it('defines only the bounded worker projection and permits only worker event types', () => {
    const view = spec.components.schemas.HandymanBastWorkerReadView;
    assert.deepEqual(view.required, [
      'executionScopeId', 'scopeStatus', 'bast', 'acceptance',
      'eligibility', 'lifecycleActions', 'events',
    ]);
    assert.deepEqual(
      view.properties.lifecycleActions.items.$ref,
      '#/components/schemas/HandymanBastWorkerLifecycleAction',
    );
    assert.deepEqual(
      spec.components.schemas.HandymanBastWorkerLifecycleAction.enum,
      ['PREPARE', 'ISSUE', 'VOID'],
    );
    assert.deepEqual(
      spec.components.schemas.HandymanBastWorkerReadEvent
        .properties.eventType.enum,
      ['PREPARE', 'ISSUE', 'VOID'],
    );

    const acceptance = spec.components.schemas.HandymanBastWorkerAcceptance;
    for (const forbidden of [
      'clientId', 'buildingId', 'tenantCompanyId', 'approvedSignOff',
      'signatureDigest', 'evidenceRecordId', 'signOffComplete',
    ]) {
      assert.equal(acceptance.properties[forbidden], undefined,
        `${forbidden} must not be part of the worker acceptance projection`);
    }
    assert.equal(view.properties.signOffs, undefined,
      'Customer Care sign-off rows are not part of the worker view');
  });

  it('resolves every local reference on the new path and its worker schemas', () => {
    const roots = [
      operation,
      spec.components.schemas.HandymanBastWorkerReadView,
      spec.components.schemas.HandymanBastWorkerAcceptance,
      spec.components.schemas.HandymanBastWorkerReadEvent,
      spec.components.schemas.HandymanBastWorkerLifecycleAction,
      spec.components.schemas.HandymanBastWorkerDocument,
      spec.components.schemas.HandymanBastWorkerAction,
    ];
    const refs = new Set<string>();
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      if (typeof (value as { $ref?: unknown }).$ref === 'string') {
        refs.add((value as { $ref: string }).$ref);
      }
      for (const child of Object.values(value)) visit(child);
    };
    roots.forEach(visit);
    for (const ref of refs) {
      assert.notEqual(resolveLocalRef(ref), undefined, `unresolved ${ref}`);
    }
  });
});
