import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parse } from 'yaml';

/**
 * CR-BE-FX-01 PART 06 — structural OpenAPI integrity for the FX contract.
 *
 * Follows the repository's `yaml`-based OpenAPI test convention (see
 * `tests/attendance-contract.test.ts`), so it exercises a real YAML parse rather
 * than text extraction. It covers what the dependency-free
 * `fx06-part06-closure.test.ts` cannot: whole-document parse validity and
 * `$ref` resolution across the entire contract.
 */

const SPEC_PATH = 'docs/api/openapi.yaml';
const spec = parse(readFileSync(SPEC_PATH, 'utf8')) as {
  openapi: string;
  paths: Record<string, Record<string, { 'x-required-permission'?: string }>>;
  components: Record<string, Record<string, unknown>>;
};

const FX_PATHS = Object.keys(spec.paths).filter((p) => p.includes('fx-rates') || p.includes('fx-policy'));

describe('CR-BE-FX-01 PART 06 — OpenAPI parses and resolves', () => {
  it('is a valid OpenAPI 3 document', () => {
    assert.equal(spec.openapi, '3.0.3');
    assert.ok(Object.keys(spec.paths).length > 600, 'the full contract must parse');
  });

  it('resolves every $ref in the contract', () => {
    const raw = readFileSync(SPEC_PATH, 'utf8');
    const refs = [...raw.matchAll(/["']#\/components\/([A-Za-z]+)\/([A-Za-z0-9_]+)["']/g)]
      .map((m) => ({ section: m[1]!, name: m[2]! }));
    assert.ok(refs.length > 500, 'expected a large number of refs to check');
    const missing = refs.filter((r) => !(spec.components[r.section]?.[r.name] !== undefined));
    assert.deepEqual(
      [...new Set(missing.map((m) => `${m.section}/${m.name}`))],
      [],
      'every $ref must resolve',
    );
  });
});

describe('CR-BE-FX-01 PART 06 — FX contract structure', () => {
  it('documents exactly the eight FX paths and ten operations', () => {
    assert.deepEqual(FX_PATHS.sort(), [
      '/clients/{clientId}/fx-policy',
      '/fx-rates',
      '/fx-rates/{rateId}',
      '/fx-rates/{rateId}/approve',
      '/fx-rates/{rateId}/deactivate',
      '/fx-rates/{rateId}/events',
      '/fx-rates/{rateId}/reject',
      '/fx-rates/{rateId}/supersede',
    ]);
    const operations = FX_PATHS.flatMap((p) =>
      Object.keys(spec.paths[p]!).filter((m) => ['get', 'post', 'put', 'patch', 'delete'].includes(m)),
    );
    assert.equal(operations.length, 10);
  });

  it('declares the required permission on every FX operation', () => {
    for (const path of FX_PATHS) {
      for (const [method, op] of Object.entries(spec.paths[path]!)) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
        const permission = op['x-required-permission'];
        assert.ok(permission, `${method.toUpperCase()} ${path} must declare x-required-permission`);
        assert.match(
          permission!,
          /^(fx_rate|client_fx_policy)\.(read|manage|approve)$/,
          `${method.toUpperCase()} ${path} has an unexpected permission ${permission}`,
        );
      }
    }
  });

  it('exposes no conversion, quote, resolve, ingest or provider surface', () => {
    for (const path of Object.keys(spec.paths)) {
      assert.doesNotMatch(path, /^\/fx\/(convert|quote)/);
      assert.doesNotMatch(path, /^\/fx-rates\/(convert|quote|resolve|ingest)/);
    }
  });

  it('keeps the FX schemas, responses and parameters in components', () => {
    for (const schema of [
      'FxRate', 'FxRateStatus', 'FxRateType', 'FxRateSource', 'FxRateEventType', 'FxRateEvent',
      'CreateFxRateRequest', 'SupersedeFxRateRequest', 'FxRateReasonRequest',
      'FxRateSupersessionResult', 'ClientFxPolicy', 'SetClientFxPolicyRequest', 'ClientFxPolicyReadModel',
    ]) {
      assert.ok(spec.components.schemas?.[schema], `schema ${schema} must exist`);
    }
    for (const response of [
      'FxRateSuccess', 'FxRateListSuccess', 'FxRateEventListSuccess',
      'FxRateSupersessionSuccess', 'ClientFxPolicyReadSuccess', 'ClientFxPolicySuccess',
    ]) {
      assert.ok(spec.components.responses?.[response], `response ${response} must exist`);
    }
    for (const parameter of ['FxRateIdPath', 'FxClientIdPath']) {
      assert.ok(spec.components.parameters?.[parameter], `parameter ${parameter} must exist`);
    }
  });

  it('types the rate as a string so NUMERIC(24,12) never becomes a float', () => {
    const rate = (spec.components.schemas!.FxRate as { properties: Record<string, { type: string }> })
      .properties.rate;
    assert.equal(rate.type, 'string');
    const createRate = (
      spec.components.schemas!.CreateFxRateRequest as { properties: Record<string, { type: string }> }
    ).properties.rate;
    assert.equal(createRate.type, 'string');
  });

  it('declares the FX tag with the canonical convention and no conversion', () => {
    const raw = readFileSync(SPEC_PATH, 'utf8');
    assert.match(raw, /- name: FX\n/);
    assert.match(raw, /1 BASE = RATE x QUOTE/);
    const tagBlock = raw.slice(raw.indexOf('- name: FX'), raw.indexOf('- name: FX') + 2000);
    assert.match(tagBlock, /PENDING_APPROVAL/);
    assert.match(tagBlock, /SUPERSEDED/);
    assert.match(tagBlock, /no conversion/i);
  });
});
