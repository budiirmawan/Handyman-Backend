/**
 * W03 PART 03G — OpenAPI ↔ runtime contract reconciliation (CR-HM-06/A01 §9,
 * ADD-A C21/C22, 03B–03F records). Focused, database-free, no runtime change.
 *
 * It pins the reconciled contract to the code that actually ships:
 *   - route census: every Tenant PIC route and every staff approval-binding
 *     route in source is documented, and nothing is documented that does not
 *     exist (both directions);
 *   - the binding revoke verb stays POST (B2-D2 is OPEN for the owner; no
 *     DELETE alias may appear silently);
 *   - decision actor vocabulary in the contract equals the stored vocabulary
 *     (`USER`, `TENANT_PIC`); `SYSTEM` is not documented anywhere;
 *   - response envelopes match `sendSuccess` (`{success,data,meta}`);
 *   - S1 soft-close of the staff decide POST (403 + Deprecation, no Sunset);
 *   - PIC operations are authenticated only by `picWorkspaceSession` (or the
 *     admission HMAC), never by the staff `bearerAuth` scheme;
 *   - every $ref introduced or touched by 03G resolves.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parse as parseYaml } from 'yaml';

type Json = Record<string, any>;

const ROOT = process.cwd();
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), 'utf8');

const spec = parseYaml(read('docs', 'api', 'openapi.yaml')) as Json;
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

const toOpenApiPath = (p: string) => p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

/** All `METHOD /path` pairs a router file registers via literal path strings. */
function runtimeRoutes(file: string, prefix: RegExp): Set<string> {
  const src = read(file);
  const out = new Set<string>();
  const re = /router\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g;
  for (const m of src.matchAll(re)) {
    if (prefix.test(m[2]!)) out.add(`${m[1]!.toUpperCase()} ${toOpenApiPath(m[2]!)}`);
  }
  return out;
}

function documentedOperations(prefix: RegExp): Set<string> {
  const out = new Set<string>();
  for (const [p, item] of Object.entries(spec.paths as Json)) {
    if (!prefix.test(p)) continue;
    for (const m of HTTP_METHODS) if ((item as Json)[m]) out.add(`${m.toUpperCase()} ${p}`);
  }
  return out;
}

function resolvePointer(ref: string): unknown {
  let cur: unknown = spec;
  for (const part of ref.replace(/^#\//, '').split('/')) {
    if (cur === null || typeof cur !== 'object' || !(part in (cur as Json))) return undefined;
    cur = (cur as Json)[part];
  }
  return cur;
}

const BINDING = '/handyman/quotations/{quotationId}/approval-binding';
const BINDING_REVOKE = `${BINDING}/revoke`;
const ENVELOPE_REF = '#/components/schemas/SuccessEnvelope';

describe('W03 PART 03G — staff approval-binding contract', () => {
  it('documents exactly the three shipped binding operations, each with its runtime operationId', () => {
    const routes = read(
      'src',
      'modules',
      'handyman-quotations-api',
      'handyman-quotations-api.routes.ts',
    );
    // The router mounts the binding paths through the `bindingPath` constant.
    assert.match(routes, /const bindingPath = '\/handyman\/quotations\/:quotationId\/approval-binding';/);
    assert.match(routes, /router\.post\(\s*bindingPath,/);
    assert.match(routes, /router\.post\(\s*`\$\{bindingPath\}\/revoke`,/);
    assert.match(routes, /router\.get\(\s*bindingPath,/);

    assert.equal((spec.paths[BINDING] as Json).post.operationId, 'bindHandymanQuotationApprovalBinding');
    assert.equal((spec.paths[BINDING] as Json).get.operationId, 'getHandymanQuotationApprovalBinding');
    assert.equal(
      (spec.paths[BINDING_REVOKE] as Json).post.operationId,
      'revokeHandymanQuotationApprovalBinding',
    );
    assert.deepEqual(Object.keys(spec.paths[BINDING] as Json).filter((k) => HTTP_METHODS.includes(k as never)).sort(), ['get', 'post']);
    assert.deepEqual(Object.keys(spec.paths[BINDING_REVOKE] as Json).filter((k) => HTTP_METHODS.includes(k as never)), ['post']);
  });

  it('keeps the revoke verb POST and publishes NO DELETE alias (B2-D2 is open for the owner)', () => {
    assert.equal((spec.paths[BINDING] as Json).delete, undefined);
    assert.equal((spec.paths[BINDING_REVOKE] as Json).delete, undefined);
    const revokeDescription = String((spec.paths[BINDING_REVOKE] as Json).post.description);
    assert.match(revokeDescription, /B2-D2/);
    assert.match(revokeDescription, /owner ratification required/);
  });

  it('requires the Idempotency-Key header on both writes and uses the staff bearer scheme', () => {
    for (const op of [(spec.paths[BINDING] as Json).post, (spec.paths[BINDING_REVOKE] as Json).post]) {
      assert.deepEqual(op.security, [{ bearerAuth: [] }]);
      assert.ok(
        op.parameters.some((p: Json) => p.$ref === '#/components/parameters/IdempotencyKeyHeader'),
        `${op.operationId} must declare Idempotency-Key`,
      );
    }
    assert.deepEqual((spec.paths[BINDING] as Json).get.security, [{ bearerAuth: [] }]);
  });

  it('documents the shipped status codes: bind 201, revoke 200, read 200, with the uniform 404', () => {
    const bind = (spec.paths[BINDING] as Json).post.responses;
    const revoke = (spec.paths[BINDING_REVOKE] as Json).post.responses;
    const read200 = (spec.paths[BINDING] as Json).get.responses;
    assert.ok(bind['201'] && bind['400'] && bind['401'] && bind['403'] && bind['404'] && bind['409']);
    assert.ok(revoke['200'] && revoke['400'] && revoke['401'] && revoke['403'] && revoke['404'] && revoke['409']);
    assert.ok(read200['200'] && read200['404']);
    // the write envelopes mirror `sendSuccess` (success/data/meta)
    for (const r of [bind['201'], revoke['200'], read200['200']]) {
      const schema = r.content['application/json'].schema;
      assert.ok(JSON.stringify(schema).includes(ENVELOPE_REF), 'success body must use SuccessEnvelope');
    }
  });

  it('exposes only the fields the public projections really carry (binding, status)', () => {
    const types = read('src', 'modules', 'handyman-quotation-approval-bindings', 'handyman-quotation-approval-binding.types.ts');
    const fieldsOf = (typeName: string): string[] => {
      const start = types.indexOf(`export type ${typeName} = {`);
      assert.ok(start >= 0, `${typeName} present in runtime types`);
      const body = types.slice(start, types.indexOf('\n};', start));
      return [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]!).sort();
    };
    const schemaFields = (name: string) =>
      Object.keys((spec.components.schemas[name] as Json).properties).sort();
    assert.deepEqual(schemaFields('HandymanQuotationApprovalBinding'), fieldsOf('PublicHandymanQuotationApprovalBinding'));
    assert.deepEqual(schemaFields('HandymanQuotationApprovalStatus'), fieldsOf('PublicHandymanQuotationApprovalStatus'));
    assert.deepEqual(
      schemaFields('HandymanQuotationApprovalBindingHistoryEntry'),
      fieldsOf('PublicHandymanQuotationApprovalBindingHistoryEntry'),
    );
  });

  it('every $ref under the binding operations and the 03G schemas resolves', () => {
    const scope = [
      spec.paths[BINDING],
      spec.paths[BINDING_REVOKE],
      ...Object.entries(spec.components.schemas as Json)
        .filter(([k]) => k.startsWith('HandymanQuotationApproval'))
        .map(([, v]) => v),
    ];
    const missing: string[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node as Json)) {
          if (k === '$ref' && typeof v === 'string' && v.startsWith('#/') && resolvePointer(v) === undefined) missing.push(v);
          else walk(v);
        }
      }
    };
    scope.forEach(walk);
    assert.deepEqual(missing, []);
  });
});

describe('W03 PART 03G — Tenant PIC contract census and authority', () => {
  it('documents exactly the Tenant PIC operations the runtime registers (both directions)', () => {
    const runtime = new Set<string>([
      ...runtimeRoutes(join('src', 'modules', 'handyman-pic-session', 'pic-workspace-session.routes.ts'), /^\/handyman\/pic\//),
      ...runtimeRoutes(join('src', 'modules', 'handyman-pic-portal', 'pic-portal.routes.ts'), /^\/handyman\/pic\//),
    ]);
    const documented = documentedOperations(/^\/handyman\/pic\//);
    assert.deepEqual([...runtime].sort(), [...documented].sort());
    assert.equal(runtime.size, 7);
  });

  it('never lets a mutation other than the admission, revoke and decision routes exist on /pic', () => {
    const mutations = [...documentedOperations(/^\/handyman\/pic\//)].filter((o) => /^(POST|PUT|PATCH|DELETE) /.test(o));
    assert.deepEqual(mutations.sort(), [
      'DELETE /handyman/pic/session',
      'POST /handyman/pic/quotation-versions/{quotationVersionId}/decision',
      'POST /handyman/pic/session',
    ]);
  });

  it('authenticates PIC reads and decisions only with picWorkspaceSession, never the staff bearerAuth', () => {
    for (const [p, item] of Object.entries(spec.paths as Json)) {
      if (!p.startsWith('/handyman/pic/')) continue;
      for (const m of HTTP_METHODS) {
        const op = (item as Json)[m];
        if (!op) continue;
        const names = (op.security ?? []).flatMap((s: Json) => Object.keys(s));
        assert.ok(!names.includes('bearerAuth'), `${m} ${p} must not use staff bearerAuth`);
        if (p === '/handyman/pic/session' && m === 'post') {
          assert.deepEqual(names, ['handoffAssertionSignature']);
        } else {
          assert.deepEqual(names, ['picWorkspaceSession'], `${m} ${p}`);
        }
      }
    }
    const scheme = spec.components.securitySchemes.picWorkspaceSession as Json;
    assert.equal(scheme.type, 'http');
    assert.equal(scheme.scheme, 'bearer');
    assert.notDeepEqual(scheme, spec.components.securitySchemes.bearerAuth);
  });

  it('documents the PIC decision POST with the required Idempotency-Key and the 201/400/401/404/409 set', () => {
    const op = (spec.paths['/handyman/pic/quotation-versions/{quotationVersionId}/decision'] as Json).post;
    assert.equal(op.operationId, 'submitPicQuotationDecision');
    assert.ok(op.parameters.some((p: Json) => p.$ref === '#/components/parameters/IdempotencyKeyHeader' || p.name === 'Idempotency-Key'));
    assert.deepEqual(Object.keys(op.responses).sort(), ['201', '400', '401', '404', '409']);
  });
});

describe('W03 PART 03G — decision actor vocabulary, envelopes and S1 soft-close', () => {
  it('every decisionActorType enum equals the stored vocabulary and never contains SYSTEM', () => {
    const types = read('src', 'modules', 'handyman-quotations', 'handyman-quotation-decision.types.ts');
    const block = /HANDYMAN_QUOTATION_DECISION_ACTOR_TYPES = \[([\s\S]*?)\] as const/.exec(types);
    assert.ok(block, 'runtime actor vocabulary found');
    const runtimeVocabulary = [...block[1]!.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]!).sort();
    assert.deepEqual(runtimeVocabulary, ['TENANT_PIC', 'USER']);

    const seen: string[][] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node as Json)) {
          if (k === 'decisionActorType' && v && Array.isArray((v as Json).enum)) seen.push([...(v as Json).enum].sort());
          walk(v);
        }
      }
    };
    walk(spec.components.schemas);
    walk(spec.paths);
    assert.ok(seen.length >= 2, 'decision actor enums are documented');
    for (const e of seen) assert.deepEqual(e, runtimeVocabulary);
  });

  it('wraps the staff decision POST and GET in the runtime success envelope', () => {
    const item = spec.paths['/handyman/quotation-versions/{quotationVersionId}/decision'] as Json;
    for (const [m, code] of [['post', '201'], ['get', '200']] as const) {
      const schema = item[m].responses[code].content['application/json'].schema;
      assert.ok(JSON.stringify(schema).includes(ENVELOPE_REF), `${m} ${code} must use SuccessEnvelope`);
    }
  });

  it('keeps the staff decide POST soft-closed: 403 with Deprecation and successor Link, and no Sunset', () => {
    const op = (spec.paths['/handyman/quotation-versions/{quotationVersionId}/decision'] as Json).post;
    assert.equal(op.deprecated, true);
    const forbidden = op.responses['403'];
    assert.ok(forbidden.headers.Deprecation, 'Deprecation header documented');
    assert.ok(forbidden.headers.Link, 'successor Link documented');
    // No Sunset header is documented or sent: the removal date is an owner decision (BLK-10).
    assert.deepEqual(Object.keys(forbidden.headers).filter((h) => /^sunset$/i.test(h)), []);
  });

  it('documents exactly one staff operation whose id names a decide action: the soft-closed route', () => {
    const decideOps = Object.entries(spec.paths as Json)
      .filter(([p]) => p.startsWith('/handyman/') && !p.startsWith('/handyman/pic/'))
      .flatMap(([p, item]) =>
        HTTP_METHODS.filter((m) => (item as Json)[m]?.operationId?.toLowerCase().includes('decide')).map((m) => `${m} ${p}`),
      );
    assert.deepEqual(decideOps, ['post /handyman/quotation-versions/{quotationVersionId}/decision']);
  });
});
