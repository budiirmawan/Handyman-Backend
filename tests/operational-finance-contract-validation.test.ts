import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { api } from './helpers/http';

const API_PREFIX = '/api/v1';
const ID = '00000000-0000-4000-8000-000000000001';

const CONTRACT_OPERATIONS = [
  ['post', '/buildings/{buildingId}/operational-budgets'],
  ['get', '/buildings/{buildingId}/operational-budgets'],
  ['get', '/operational-budgets'],
  ['get', '/operational-budgets/{id}'],
  ['patch', '/operational-budgets/{id}'],
  ['post', '/operational-budgets/{id}/activate'],
  ['post', '/operational-budgets/{id}/close'],
  ['post', '/operational-budgets/{id}/cancel'],
  ['post', '/operational-budgets/{budgetId}/categories'],
  ['get', '/operational-budgets/{budgetId}/categories'],
  ['get', '/operational-budget-categories/{id}'],
  ['patch', '/operational-budget-categories/{id}'],
  ['delete', '/operational-budget-categories/{id}'],
  ['post', '/operational-budgets/{budgetId}/source-bindings'],
  ['get', '/operational-budgets/{budgetId}/source-bindings'],
  ['get', '/operational-budget-source-bindings/{id}'],
  ['post', '/operational-budget-source-bindings/{id}/remove'],
  ['get', '/operational-budgets/{budgetId}/aggregation'],
  ['get', '/operational-budgets/{budgetId}/summary'],
  ['get', '/management/operational-finance/budgets/{budgetId}/summary'],
  ['get', '/management/operational-finance/budgets/{budgetId}/categories'],
  ['get', '/management/buildings/{buildingId}/operational-finance-summary'],
] as const;

function spec(): Record<string, any> {
  return parse(
    readFileSync(resolve(__dirname, '../docs/api/openapi.yaml'), 'utf8'),
  ) as Record<string, any>;
}

function resolveLocalRef(document: Record<string, any>, reference: string): unknown {
  assert.match(reference, /^#\//);
  return reference
    .slice(2)
    .split('/')
    .reduce((value, part) => value?.[part.replace(/~1/g, '/').replace(/~0/g, '~')], document);
}

describe('CR-BE-FIN-01 PART 07 — Contract and Integration Validation', () => {
  it('documents every CR-BE-FIN-01 PART 01–06 runtime operation', () => {
    const document = spec();
    for (const [method, path] of CONTRACT_OPERATIONS) {
      const operation = document.paths?.[path]?.[method];
      assert.ok(operation, `${method.toUpperCase()} ${path} must be documented`);
      assert.deepEqual(operation.security, [{ bearerAuth: [] }]);
      assert.equal(
        operation['x-required-permission'],
        path.startsWith('/management/')
          ? 'management_read_model.read'
          : 'operational_budget.' + (method === 'get' ? 'read' : 'manage'),
      );
      assert.equal(operation['x-building-scoped'], true);
      assert.ok(operation.responses?.['401'], `${method.toUpperCase()} ${path} must document 401`);
      assert.ok(operation.responses?.['403'], `${method.toUpperCase()} ${path} must document 403`);
    }
  });

  it('matches required parameters and documented response references', () => {
    const document = spec();
    const buildingSummary = document.paths[
      '/management/buildings/{buildingId}/operational-finance-summary'
    ].get;
    const parameters = buildingSummary.parameters as Array<Record<string, any>>;
    assert.deepEqual(
      parameters.filter((parameter) => parameter.in === 'query').map((parameter) => parameter.name),
      ['periodStart', 'periodEnd'],
    );
    assert.ok(parameters.every((parameter) => parameter.required === true));

    const budgetCreate = document.paths['/buildings/{buildingId}/operational-budgets'].post;
    assert.deepEqual(
      budgetCreate.requestBody.content['application/json'].schema,
      { $ref: '#/components/schemas/CreateOperationalBudgetRequest' },
    );
    assert.equal(
      budgetCreate.responses['201'].$ref,
      '#/components/responses/OperationalBudgetSuccess',
    );

    const schemaNames = [
      'OperationalBudget',
      'OperationalBudgetCategory',
      'OperationalBudgetSourceBinding',
      'OperationalBudgetAggregation',
      'ManagementOperationalBudgetSummary',
      'ManagementOperationalBudgetCategories',
      'ManagementBuildingOperationalFinance',
    ];
    for (const name of schemaNames) {
      assert.ok(document.components?.schemas?.[name], `${name} must exist`);
    }
  });

  it('resolves all local OpenAPI references and does not document unimplemented finance sources', () => {
    const document = spec();
    const references: string[] = [];
    const walk = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      if ('$ref' in value && typeof (value as { $ref?: unknown }).$ref === 'string') {
        references.push((value as { $ref: string }).$ref);
      }
      for (const child of Object.values(value)) walk(child);
    };
    walk(document);
    for (const reference of references) {
      assert.notEqual(resolveLocalRef(document, reference), undefined, reference);
    }

    const bindingSchema = document.components.schemas.OperationalBudgetSourceBinding;
    const requestSchema = document.components.schemas.CreateOperationalBudgetSourceBindingRequest;
    assert.equal(bindingSchema.properties.utilityBillId, undefined);
    assert.equal(requestSchema.properties.utilityBillId, undefined);
    assert.equal(document.paths['/management/financial-summary'].get.operationId, 'getManagementFinancialSummary');
  });

  it('confirms every documented CR operation is registered and protected', async () => {
    const request = api();
    for (const [method, path] of CONTRACT_OPERATIONS) {
      const runtimePath = `${API_PREFIX}${path.replace('{buildingId}', ID).replace('{budgetId}', ID).replace('{id}', ID)}`;
      const response = method === 'get'
        ? await request.get(runtimePath)
        : method === 'post'
          ? await request.post(runtimePath).send({})
          : method === 'patch'
            ? await request.patch(runtimePath).send({})
            : await request.delete(runtimePath);
      assert.equal(response.status, 401, `${method.toUpperCase()} ${path} must require authentication`);
      assert.equal(response.body.error.code, 'AUTHENTICATION_REQUIRED');
    }
  });
});
