import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import type { Express } from 'express';

// Enable WhatsApp callback router in environment before createApp() so full runtime is mounted
process.env.WHATSAPP_WEBHOOK_ENABLED = 'true';
process.env.WHATSAPP_META_APP_SECRET = 'test-secret';
process.env.WHATSAPP_META_WEBHOOK_VERIFY_TOKEN = 'test-token';

import { createApp } from '../src/app';

/**
 * INT-LC-19-BE PART 07 — Dynamic Forms OpenAPI Closure.
 *
 * Scope:
 *   - source-forms (4 routes)
 *   - form-templates (4 routes)
 *   - form-sections (6 routes)
 *   - form-conditions (4 routes)
 *   - form-instances (8 routes)
 * Total undocumented routes: exact 26.
 *
 * Required proofs:
 *  1. 26/26 documented
 *  2. Scoped gap 0
 *  3. No speculative routes
 *  4. Unique operationIds
 *  5. Broken refs 0
 *  6. Permission/scope/schema parity
 *  7. Canonical 401 where authenticated
 *  8. /platform/* untouched (69/69)
 */

const SPEC_PATH = resolve(__dirname, '../docs/api/openapi.yaml');
const SPEC = parse(readFileSync(SPEC_PATH, 'utf8')) as Record<string, any>;

function normalizePath(p: string): string {
  return (
    p
      .replace(/:([a-zA-Z0-9_]+)/g, '{$1}')
      .replace(/\{([a-zA-Z0-9_]+)\}/g, '{p}')
      .replace(/\/+/g, '/')
      .replace(/\/$/, '') || '/'
  );
}

function walkRouter(
  stack: unknown,
  prefix = '',
): Array<{ method: string; path: string }> {
  const out: Array<{ method: string; path: string }> = [];
  const s = stack as Array<{
    route?: { path?: string; methods?: Record<string, unknown> };
    handle?: { stack?: unknown[]; regexp?: { source?: string } };
    matchers?: Array<(input: string) => boolean | object>;
  }>;
  for (const layer of s ?? []) {
    if (layer.route?.path) {
      const full = prefix + layer.route.path || '/';
      for (const m of Object.keys(layer.route.methods ?? {})) {
        if (m === '_all') continue;
        out.push({ method: m.toUpperCase(), path: full });
      }
    } else if (layer.handle?.stack) {
      let layerPrefix = prefix;
      if (layer.matchers?.[0]?.('/webhooks/notifications/whatsapp')) {
        layerPrefix = '/webhooks/notifications/whatsapp';
      }
      out.push(...walkRouter(layer.handle.stack, layerPrefix));
    }
  }
  return out;
}

const SCOPED_OPERATIONS: Record<
  string,
  {
    module: string;
    operationId: string;
    permission: string;
    summary: string;
  }
> = {
  // source-forms (4)
  'POST /clients/{clientId}/source-forms': {
    module: 'source-forms',
    operationId: 'createSourceForm',
    permission: 'source_form.manage',
    summary: 'Create a Source Form for a Client',
  },
  'GET /clients/{clientId}/source-forms': {
    module: 'source-forms',
    operationId: 'listSourceForms',
    permission: 'source_form.read',
    summary: 'List Source Forms for a Client',
  },
  'GET /source-forms/{id}': {
    module: 'source-forms',
    operationId: 'getSourceForm',
    permission: 'source_form.read',
    summary: 'Get a Source Form by ID',
  },
  'PATCH /source-forms/{id}': {
    module: 'source-forms',
    operationId: 'updateSourceForm',
    permission: 'source_form.manage',
    summary: 'Update a Source Form',
  },

  // form-templates (4)
  'POST /source-forms/{sourceFormId}/templates': {
    module: 'form-templates',
    operationId: 'createFormTemplate',
    permission: 'form_template.manage',
    summary: 'Create a Form Template under a Source Form',
  },
  'GET /source-forms/{sourceFormId}/templates': {
    module: 'form-templates',
    operationId: 'listFormTemplates',
    permission: 'form_template.read',
    summary: 'List Form Templates under a Source Form',
  },
  'GET /form-templates/{id}': {
    module: 'form-templates',
    operationId: 'getFormTemplate',
    permission: 'form_template.read',
    summary: 'Get a Form Template by ID',
  },
  'PATCH /form-templates/{id}': {
    module: 'form-templates',
    operationId: 'updateFormTemplate',
    permission: 'form_template.manage',
    summary: 'Update a Form Template',
  },

  // form-sections (6)
  'POST /form-templates/{templateId}/sections': {
    module: 'form-sections',
    operationId: 'createFormSection',
    permission: 'form_template.manage',
    summary: 'Create a Form Section in a Template',
  },
  'GET /form-templates/{templateId}/sections': {
    module: 'form-sections',
    operationId: 'listFormSections',
    permission: 'form_template.read',
    summary: 'List Form Sections in a Template',
  },
  'PATCH /form-sections/{id}': {
    module: 'form-sections',
    operationId: 'updateFormSection',
    permission: 'form_template.manage',
    summary: 'Update a Form Section',
  },
  'POST /form-sections/{sectionId}/fields': {
    module: 'form-sections',
    operationId: 'createFormField',
    permission: 'form_template.manage',
    summary: 'Create a Form Field in a Section',
  },
  'GET /form-sections/{sectionId}/fields': {
    module: 'form-sections',
    operationId: 'listFormFields',
    permission: 'form_template.read',
    summary: 'List Form Fields in a Section',
  },
  'PATCH /form-fields/{id}': {
    module: 'form-sections',
    operationId: 'updateFormField',
    permission: 'form_template.manage',
    summary: 'Update a Form Field',
  },

  // form-conditions (4)
  'POST /form-template-versions/{versionId}/conditional-rules': {
    module: 'form-conditions',
    operationId: 'createFormConditionalRule',
    permission: 'form_template.manage',
    summary: 'Create a conditional rule in a template version',
  },
  'GET /form-template-versions/{versionId}/conditional-rules': {
    module: 'form-conditions',
    operationId: 'listFormConditionalRules',
    permission: 'form_template.read',
    summary: 'List conditional rules of a template version',
  },
  'POST /form-template-versions/{versionId}/sections/{sectionId}/repeatable': {
    module: 'form-conditions',
    operationId: 'createFormRepeatableGroup',
    permission: 'form_template.manage',
    summary: 'Configure repeatable group for a section in a template version',
  },
  'POST /form-instances/{id}/sections/{sectionId}/occurrences/{groupId}': {
    module: 'form-conditions',
    operationId: 'createFormInstanceOccurrence',
    permission: 'form_template.manage',
    summary: 'Add a section occurrence to a form instance',
  },

  // form-instances (8)
  'POST /form-template-versions/{versionId}/instances': {
    module: 'form-instances',
    operationId: 'createFormInstance',
    permission: 'form_template.manage',
    summary: 'Create a Form Instance from a published Template Version',
  },
  'GET /form-instances/{id}': {
    module: 'form-instances',
    operationId: 'getFormInstance',
    permission: 'form_template.read',
    summary: 'Get a Form Instance by ID',
  },
  'GET /form-instances': {
    module: 'form-instances',
    operationId: 'listFormInstances',
    permission: 'form_template.read',
    summary: 'List Form Instances',
  },
  'POST /form-instances/{id}/start': {
    module: 'form-instances',
    operationId: 'startFormInstance',
    permission: 'form_template.manage',
    summary: 'Start a Form Instance',
  },
  'GET /form-instances/{id}/responses': {
    module: 'form-instances',
    operationId: 'listFormResponses',
    permission: 'form_template.read',
    summary: 'List recorded responses of a Form Instance',
  },
  'PUT /form-instances/{id}/responses': {
    module: 'form-instances',
    operationId: 'saveFormResponses',
    permission: 'form_template.manage',
    summary: 'Save responses for a Form Instance',
  },
  'POST /form-instances/{id}/complete': {
    module: 'form-instances',
    operationId: 'completeFormInstance',
    permission: 'form_template.manage',
    summary: 'Complete a Form Instance',
  },
  'POST /form-instances/{id}/cancel': {
    module: 'form-instances',
    operationId: 'cancelFormInstance',
    permission: 'form_template.manage',
    summary: 'Cancel a Form Instance',
  },
};

describe('INT-LC-19-BE PART 07 — Dynamic Forms OpenAPI Closure', () => {
  const app = createApp() as Express;
  const runtime = walkRouter(app.router?.stack).map((r) => ({
    ...r,
    canon: normalizePath(r.path),
  }));

  const openapi: Array<{
    method: string;
    path: string;
    canon: string;
    operationId?: string;
    permission?: string;
    responses?: Record<string, any>;
  }> = [];

  for (const [p, methods] of Object.entries(SPEC.paths ?? {})) {
    for (const [m, op] of Object.entries(methods as Record<string, any>)) {
      if (['get', 'post', 'put', 'patch', 'delete', 'options', 'head'].includes(m)) {
        openapi.push({
          method: m.toUpperCase(),
          path: p,
          canon: normalizePath(p),
          operationId: op.operationId,
          permission: op['x-required-permission'],
          responses: op.responses,
        });
      }
    }
  }

  // 1. Exactly 26 scoped operations defined in test table
  it('1. exact 26 operations in scoped test table', () => {
    assert.equal(
      Object.keys(SCOPED_OPERATIONS).length,
      26,
      'Scoped operations table must have exactly 26 operations',
    );
  });

  // 2. All 26 scoped operations documented in OpenAPI
  it('2. 26/26 scoped operations documented in OpenAPI', () => {
    const openapiByMethodPath = new Map<string, (typeof openapi)[number]>();
    for (const op of openapi) {
      openapiByMethodPath.set(`${op.method} ${op.path}`, op);
    }

    const missing: string[] = [];
    for (const [key, expected] of Object.entries(SCOPED_OPERATIONS)) {
      const op = openapiByMethodPath.get(key);
      if (!op) {
        missing.push(key);
      } else {
        assert.equal(
          op.operationId,
          expected.operationId,
          `OperationId mismatch on ${key}: expected ${expected.operationId}, got ${op.operationId}`,
        );
      }
    }

    assert.deepEqual(missing, [], `Missing operations in OpenAPI: ${missing.join(', ')}`);
  });

  // 3. Scoped runtime routes match OpenAPI routes (scoped gap 0)
  it('3. scoped runtime gap is 0', () => {
    const scopedRuntimePatterns = [
      /^\/clients\/[^/]+\/source-forms/,
      /^\/source-forms\//,
      /^\/form-templates\/[^/]+\/sections/,
      /^\/form-templates\/[^/]+$/,
      /^\/form-sections\//,
      /^\/form-fields\//,
      /^\/form-template-versions\/[^/]+\/conditional-rules/,
      /^\/form-template-versions\/[^/]+\/sections\/[^/]+\/repeatable/,
      /^\/form-template-versions\/[^/]+\/instances/,
      /^\/form-instances/,
    ];

    const scopedRuntime = runtime.filter((r) =>
      scopedRuntimePatterns.some((pattern) => pattern.test(r.path)),
    );

    // Filter out form-template-versions own routes (e.g. /form-templates/:templateId/versions, /form-template-versions/:id, /publish, /retire)
    const formsScopedRuntime = scopedRuntime.filter(
      (r) =>
        !r.path.includes('/versions') &&
        !r.path.endsWith('/publish') &&
        !r.path.endsWith('/retire'),
    );

    const openapiByMethodCanon = new Set(openapi.map((o) => `${o.method} ${o.canon}`));
    const unmappedScoped = formsScopedRuntime.filter(
      (r) => !openapiByMethodCanon.has(`${r.method} ${r.canon}`),
    );

    assert.deepEqual(
      unmappedScoped,
      [],
      `All scoped runtime routes must be documented: ${JSON.stringify(unmappedScoped)}`,
    );
  });

  // 4. No speculative routes in scoped modules
  it('4. no speculative routes in OpenAPI for scoped modules', () => {
    const runtimeByMethodCanon = new Set(runtime.map((r) => `${r.method} ${r.canon}`));

    for (const [key] of Object.entries(SCOPED_OPERATIONS)) {
      const [method, path] = key.split(' ');
      const canon = normalizePath(path);
      assert.ok(
        runtimeByMethodCanon.has(`${method} ${canon}`),
        `OpenAPI route ${key} must exist in runtime (no speculative routes)`,
      );
    }
  });

  // 5. Unique operationIds across entire OpenAPI spec
  it('5. unique operationIds across the entire OpenAPI document', () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];

    for (const op of openapi) {
      if (!op.operationId) continue;
      if (seen.has(op.operationId)) {
        duplicates.push(
          `${op.operationId} (at ${op.method} ${op.path} and ${seen.get(op.operationId)})`,
        );
      } else {
        seen.set(op.operationId, `${op.method} ${op.path}`);
      }
    }

    assert.deepEqual(duplicates, [], `Duplicate operationIds found: ${duplicates.join(', ')}`);
  });

  // 6. Zero broken $refs in openapi.yaml
  it('6. zero broken $refs in openapi.yaml', () => {
    const buckets: Record<string, Set<string>> = {};
    for (const [k, v] of Object.entries(SPEC.components ?? {})) {
      buckets[k] = new Set(Object.keys((v as Record<string, unknown>) ?? {}));
    }

    const broken: string[] = [];
    function walk(node: unknown): void {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      const o = node as Record<string, unknown>;
      if (typeof o['$ref'] === 'string') {
        const ref = o['$ref'];
        if (ref.startsWith('#/components/')) {
          const parts = ref.slice(2).split('/');
          const bucket = parts[1];
          const tail = parts.slice(2).join('/');
          if (!buckets[bucket]?.has(tail)) broken.push(ref);
        }
      }
      for (const v of Object.values(o)) walk(v);
    }
    walk(SPEC);
    assert.deepEqual(broken, [], 'Zero broken $refs allowed');
  });

  // 7. Permission parity exact
  it('7. permission parity exact', () => {
    const openapiByMethodPath = new Map<string, (typeof openapi)[number]>();
    for (const op of openapi) {
      openapiByMethodPath.set(`${op.method} ${op.path}`, op);
    }

    for (const [key, expected] of Object.entries(SCOPED_OPERATIONS)) {
      const op = openapiByMethodPath.get(key);
      assert.ok(op, `Must locate ${key}`);
      assert.equal(
        op.permission,
        expected.permission,
        `Permission mismatch on ${key}: expected ${expected.permission}, got ${op.permission}`,
      );
    }
  });

  // 8. Canonical 401 where authenticated
  it('8. canonical 401 present where authenticated', () => {
    const openapiByMethodPath = new Map<string, (typeof openapi)[number]>();
    for (const op of openapi) {
      openapiByMethodPath.set(`${op.method} ${op.path}`, op);
    }

    for (const key of Object.keys(SCOPED_OPERATIONS)) {
      const op = openapiByMethodPath.get(key);
      assert.ok(op, `Must locate ${key}`);
      assert.ok(op.responses?.['401'], `Operation ${key} must expose canonical 401 response`);
    }
  });

  // 9. Request and response schema parity
  it('9. request/response schema parity', () => {
    const schemas = SPEC.components.schemas;

    assert.ok(schemas.SourceFormStatus, 'SourceFormStatus schema must exist');
    assert.ok(schemas.SourceFormType, 'SourceFormType schema must exist');
    assert.ok(schemas.PublicSourceForm, 'PublicSourceForm schema must exist');
    assert.ok(schemas.CreateSourceFormRequest, 'CreateSourceFormRequest schema must exist');
    assert.ok(schemas.UpdateSourceFormRequest, 'UpdateSourceFormRequest schema must exist');
    assert.ok(schemas.FormTemplateStatus, 'FormTemplateStatus schema must exist');
    assert.ok(schemas.PublicFormTemplate, 'PublicFormTemplate schema must exist');
    assert.ok(schemas.CreateFormTemplateRequest, 'CreateFormTemplateRequest schema must exist');
    assert.ok(schemas.UpdateFormTemplateRequest, 'UpdateFormTemplateRequest schema must exist');
    assert.ok(schemas.FormSectionRecord, 'FormSectionRecord schema must exist');
    assert.ok(schemas.CreateFormSectionRequest, 'CreateFormSectionRequest schema must exist');
    assert.ok(schemas.UpdateFormSectionRequest, 'UpdateFormSectionRequest schema must exist');
    assert.ok(schemas.FormFieldRecord, 'FormFieldRecord schema must exist');
    assert.ok(schemas.CreateFormFieldRequest, 'CreateFormFieldRequest schema must exist');
    assert.ok(schemas.UpdateFormFieldRequest, 'UpdateFormFieldRequest schema must exist');
    assert.ok(schemas.FormConditionalRule, 'FormConditionalRule schema must exist');
    assert.ok(schemas.CreateFormConditionalRuleRequest, 'CreateFormConditionalRuleRequest schema must exist');
    assert.ok(schemas.FormRepeatableGroup, 'FormRepeatableGroup schema must exist');
    assert.ok(schemas.CreateFormRepeatableGroupRequest, 'CreateFormRepeatableGroupRequest schema must exist');
    assert.ok(schemas.FormInstanceOccurrence, 'FormInstanceOccurrence schema must exist');
    assert.ok(schemas.PublicFormInstance, 'PublicFormInstance schema must exist');
    assert.ok(schemas.FormResponseRecord, 'FormResponseRecord schema must exist');

    assert.ok(SPEC.components.parameters.SourceFormIdPath, 'SourceFormIdPath parameter must exist');
    assert.ok(SPEC.components.parameters.SourceFormIdPathParam, 'SourceFormIdPathParam parameter must exist');
    assert.ok(SPEC.components.parameters.FormSectionIdPathParam, 'FormSectionIdPathParam parameter must exist');
    assert.ok(SPEC.components.parameters.FormVersionIdPathParam, 'FormVersionIdPathParam parameter must exist');
    assert.ok(SPEC.components.parameters.FormInstanceIdPathParam, 'FormInstanceIdPathParam parameter must exist');
  });

  // 10. /platform/* untouched (69/69)
  it('10. /platform/* untouched (69/69 parity)', () => {
    const platformRuntime = runtime.filter(
      (r) => r.path.startsWith('/platform') || r.path === '/platform',
    );
    assert.equal(platformRuntime.length, 69, 'SaaS platform runtime count must remain 69');
  });

  // Census validation after PART 07
  it('Census validation after PART 07', () => {
    const platformOpenApi = openapi.filter((o) => o.path.startsWith('/platform'));
    const operationalOpenApi = openapi.filter((o) => !o.path.startsWith('/platform'));

    assert.equal(openapi.length, 1463, 'Total OpenAPI count must be 1,463 (1437 + 26)');
    assert.equal(platformOpenApi.length, 69, 'Platform OpenAPI count must be 69');
    assert.equal(operationalOpenApi.length, 1394, 'Operational OpenAPI count must be 1,394 (1368 + 26)');

    const inScopeOperational = runtime.filter(
      (r) => !r.path.startsWith('/platform') && r.path !== '/',
    );
    assert.equal(inScopeOperational.length, 1617, 'IN_SCOPE_OPERATIONAL_RUNTIME must be 1,617');

    const arithmeticGap = inScopeOperational.length - operationalOpenApi.length;
    assert.equal(arithmeticGap, 223, 'Arithmetic runtime gap must be 223 (1617 - 1394)');

    const documentedCanon = new Set(operationalOpenApi.map((o) => `${o.method} ${o.canon}`));
    const unmappedDistinct = inScopeOperational.filter(
      (r) => !documentedCanon.has(`${r.method} ${r.canon}`),
    );
    assert.equal(unmappedDistinct.length, 222, 'Distinct unmapped operational endpoints must be 222');
  });
});
