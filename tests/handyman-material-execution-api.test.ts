import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { credentialService } from '../src/modules/auth';
import { handymanDisciplineRepository }
  from '../src/modules/handyman-disciplines';
import { assignHandymanExecutionScopeCrew }
  from '../src/modules/handyman-scope-assignments';
import { createAdminUser, createPlainSession } from './helpers/access';
import {
  baseFixture,
  crewFixture,
  initHandymanFixtures,
} from './helpers/handyman-fixtures';
import { ensureTestDatabase } from './helpers/postgres';
import { api } from './helpers/http';

/**
 * CR-HM-18 BE12 — field-safe Lead progress, UOM and quantity precision
 * over the existing material-execution HTTP surface. The Customer Care
 * history route remains separate and unchanged. Actor/client context comes
 * from the authenticated request ONLY; bounded auth/error and OpenAPI parity.
 * ZERO price/amount/charge/payment/FM fields in Lead reads.
 */

const V1 = '/api/v1';

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(`TRUNCATE
    handyman_material_execution_events,
    handyman_material_execution_lines,
    handyman_execution_scope_assignments,
    handyman_execution_scopes, handyman_quotation_decisions,
    handyman_quotation_lines, handyman_quotation_versions,
    handyman_quotations,
    handyman_crew_leads, handyman_crew_memberships,
    handyman_work_crews, handyman_worker_contexts,
    handyman_provider_contexts,
    handyman_request_diagnoses, handyman_request_inspections,
    handyman_request_triage_decisions, handyman_service_requests,
    handyman_channel_attributions, handyman_service_variants,
    handyman_discipline_service_associations, service_catalog,
    evidence_submissions, operational_events, tenant_service_requests,
    work_requests, work_orders, vendor_quotations,
    inventory_items,
    tenant_building_contexts, tenant_space_relationships, tenant_pics,
    tenant_companies, spaces, rooms, areas, floors, buildings,
    properties, units_of_measure, users, roles, permissions,
    clients CASCADE`);
  const admin = await createAdminUser();
  adminUserId = admin.userId;
  const d = await handymanDisciplineRepository.findDisciplineByCode(
    undefined,
    'GENERAL_HANDYMAN',
  );
  if (!d) throw new Error('GENERAL_HANDYMAN discipline seed missing');
  initHandymanFixtures({
    adminUserId,
    disciplineId: d.id,
    query: async (text, params = []) => {
      if (!pool) throw new Error('db pool not initialized');
      return pool.query(text, params);
    },
  });
  database = db;
});

after(async () => {
  if (pool) await closePool(pool);
  pool = null;
  database = null;
});

function requireDatabase(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

const q = async (text: string, params: unknown[] = []) => {
  if (!pool) throw new Error('database pool is not initialized');
  return pool.query(text, params);
};

const metErr = (res: { body: { error?: { code?: string } } }) =>
  res.body?.error?.code;

/**
 * HTTP authority bundle: AUTHORIZED scope + ACTIVE crew assignment +
 * ONE MATERIAL quotation line on the CURRENT APPROVED version + the
 * Crew Lead wired with a REAL Bearer session token.
 */
async function leadFixture(quotationQty = 6) {
  const f = await baseFixture();
  const crew = await crewFixture(f.realm);
  await assignHandymanExecutionScopeCrew({
    executionScopeId: f.scope.id,
    providerContextId: crew.providerContext.id,
    crewId: crew.crew.id,
  }, adminUserId);
  const uomRow = await q(
    `SELECT id, code, name, symbol, category
       FROM units_of_measure WHERE client_id = $1 LIMIT 1`,
    [f.scope.clientId]);
  const materialLineId = randomUUID();
  await q(
    `INSERT INTO handyman_quotation_lines (
       id, quotation_version_id, line_type, description, quantity,
       uom_id, final_quoted_unit_amount, line_total, currency,
       source_item_id, created_by_user_id
     ) VALUES ($1::uuid, $2::uuid, 'MATERIAL', 'Sealant cartridge',
               $3::numeric, $4::uuid, 30,
               ROUND($3::numeric * 30, 2), 'IDR', NULL, $5::uuid)`,
    [materialLineId, f.scope.approvedQuotationVersionId, quotationQty,
      uomRow.rows[0].id, adminUserId]);
  const password = `LeadPass${randomUUID().slice(0, 6)}`;
  await credentialService.createInitialCredential({
    userId: crew.leadUser.id,
    password,
  });
  const login = await api().post(`${V1}/auth/login`).send({
    email: crew.leadUser.email,
    password,
  });
  const token = login.body.data.sessionToken as string;
  return {
    ...f,
    crew,
    token,
    leadUserId: crew.leadUser.id,
    quotationLineId: materialLineId,
    uom: {
      id: uomRow.rows[0].id as string,
      code: uomRow.rows[0].code as string,
      name: uomRow.rows[0].name as string,
      symbol: uomRow.rows[0].symbol as string,
      category: uomRow.rows[0].category as string,
    },
  };
}

const matBase = (scopeId: string) =>
  `${V1}/handyman/execution-scopes/${scopeId}/material-lines`;

const authed = (token: string) =>
  (method: 'post' | 'get', url: string) =>
    (api() as {
      [key: string]: (u: string) => { set: (k: string, v: string) => {
        send: (b: unknown) => Promise<{
          status: number;
          body: Record<string, unknown>;
        }>;
      } };
    })[method](url)
      .set('Authorization', `Bearer ${token}`);

const postWith = (token: string) =>
  async (url: string, body: Record<string, unknown>) =>
    authed(token)('post', url).send(body);

const progressViaHttp = (token: string, scopeId: string) =>
  authed(token)('get', `${matBase(scopeId)}/progress`).send({});

async function estimateViaHttp(args: {
  token: string;
  scopeId: string;
  quotationVersionId: string;
  quotationLineId: string;
  estimatedQty?: number;
  idempotencyKey: string;
}) {
  return postWith(args.token)(`${matBase(args.scopeId)}/estimate`, {
    quotationVersionId: args.quotationVersionId,
    quotationLineId: args.quotationLineId,
    estimatedQty: args.estimatedQty ?? 6,
    idempotencyKey: args.idempotencyKey,
  });
}

async function lineViaHttp(
  token: string, scopeId: string, lineId: string, action: string,
  body: Record<string, unknown>,
) {
  return postWith(token)(
    `${matBase(scopeId)}/${lineId}/${action}`, body);
}

/** Drive a line to a chosen head state — HTTP calls ONLY. */
async function lineAt(
  stage: 'APPROVED' | 'ISSUED' | 'SETTLED',
  opts: { issueQty?: number; useQty?: number; returnQty?: number } = {},
) {
  const f = await leadFixture();
  const key = () => `k-${randomUUID()}`;
  const est = await estimateViaHttp({
    token: f.token,
    scopeId: f.scope.id,
    quotationVersionId: f.scope.approvedQuotationVersionId,
    quotationLineId: f.quotationLineId,
    idempotencyKey: key(),
  });
  assert.equal(est.status, 200, JSON.stringify(est.body));
  const lineId = (est.body as {
    data: { line: { id: string } };
  }).data.line.id;
  const approve = await lineViaHttp(
    f.token, f.scope.id, lineId, 'approve', { idempotencyKey: key() });
  assert.equal(approve.status, 200, JSON.stringify(approve.body));
  let line = (approve.body as {
    data: { line: Record<string, unknown> };
  }).data.line;
  if (stage !== 'APPROVED') {
    const issue = await lineViaHttp(
      f.token, f.scope.id, lineId, 'issue', {
        quantity: opts.issueQty ?? 6,
        idempotencyKey: key(),
      });
    assert.equal(issue.status, 200, JSON.stringify(issue.body));
    line = (issue.body as {
      data: { line: Record<string, unknown> };
    }).data.line;
    if (opts.useQty) {
      const use = await lineViaHttp(
        f.token, f.scope.id, lineId, 'use', {
          quantity: opts.useQty,
          idempotencyKey: key(),
        });
      assert.equal(use.status, 200, JSON.stringify(use.body));
      line = (use.body as {
        data: { line: Record<string, unknown> };
      }).data.line;
    }
    if (opts.returnQty) {
      const ret = await lineViaHttp(
        f.token, f.scope.id, lineId, 'return', {
          quantity: opts.returnQty,
          idempotencyKey: key(),
        });
      assert.equal(ret.status, 200, JSON.stringify(ret.body));
      line = (ret.body as {
        data: { line: Record<string, unknown> };
      }).data.line;
    }
    if (stage === 'SETTLED') {
      const settle = await lineViaHttp(
        f.token, f.scope.id, lineId, 'settle', {
          idempotencyKey: key(),
        });
      assert.equal(settle.status, 200, JSON.stringify(settle.body));
      line = (settle.body as {
        data: { line: Record<string, unknown> };
      }).data.line;
    }
  }
  return { ...f, lineId, line, makeKey: key };
}

async function addSettledLineWithDifferentUom(f: {
  scope: { id: string; clientId: string; approvedQuotationVersionId: string };
  token: string;
}, quantities: { issuedQty: number; usedQty: number; returnedQty: number }) {
  const uomId = randomUUID();
  const quoteLineId = randomUUID();
  await q(
    `INSERT INTO units_of_measure
       (id, client_id, code, name, symbol, category)
     VALUES ($1::uuid, $2::uuid, $3, 'Kilogram', 'kg', 'MASS')`,
    [uomId, f.scope.clientId, `KG_${randomUUID().slice(0, 8)}`],
  );
  await q(
    `INSERT INTO handyman_quotation_lines (
       id, quotation_version_id, line_type, description, quantity,
       uom_id, final_quoted_unit_amount, line_total, currency,
       source_item_id, created_by_user_id
     ) VALUES ($1::uuid, $2::uuid, 'MATERIAL', 'Repair compound', 6,
               $3::uuid, 30, 180, 'IDR', NULL, $4::uuid)`,
    [quoteLineId, f.scope.approvedQuotationVersionId, uomId, adminUserId],
  );
  const key = () => `k-${randomUUID()}`;
  const estimate = await estimateViaHttp({
    token: f.token,
    scopeId: f.scope.id,
    quotationVersionId: f.scope.approvedQuotationVersionId,
    quotationLineId: quoteLineId,
    estimatedQty: 6,
    idempotencyKey: key(),
  });
  assert.equal(estimate.status, 200, JSON.stringify(estimate.body));
  const lineId = (estimate.body.data as { line: { id: string } }).line.id;
  for (const [action, body] of [
    ['approve', { idempotencyKey: key() }],
    ['issue', { quantity: quantities.issuedQty, idempotencyKey: key() }],
    ['use', { quantity: quantities.usedQty, idempotencyKey: key() }],
    ['return', { quantity: quantities.returnedQty, idempotencyKey: key() }],
    ['settle', { idempotencyKey: key() }],
  ] as const) {
    const result = await lineViaHttp(
      f.token, f.scope.id, lineId, action, body);
    assert.equal(result.status, 200, JSON.stringify(result.body));
  }
  return { lineId, uomId };
}

describe('CR-HM-18 BE12 — material quantity and Lead read', () => {
  it('1: full ESTIMATE->APPROVE->ISSUE->USE->RETURN->SETTLE ladder with replay', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await leadFixture();
    const key = () => `k-${randomUUID()}`;
    // ESTIMATE: atomic line + event; exact bounded payload fields.
    const estimateKey = key();
    const estimated = await estimateViaHttp({
      token: f.token,
      scopeId: f.scope.id,
      quotationVersionId: f.scope.approvedQuotationVersionId,
      quotationLineId: f.quotationLineId,
      estimatedQty: 6,
      idempotencyKey: estimateKey,
    });
    assert.equal(estimated.status, 200, JSON.stringify(estimated.body));
    const estData = estimated.body.data as {
      line: { id: string; status: string; approvedQty: number;
        estimatedQty: number; executionScopeId: string;
        quotationVersionId: string; createdAt: string };
      event: { id: string; eventType: string; idempotencyKey: string;
        occurredAt: string };
      replayed: boolean;
    };
    assert.equal(estData.line.status, 'ESTIMATED');
    assert.equal(estData.line.approvedQty, 6);
    assert.equal(estData.line.estimatedQty, 6);
    assert.equal(estData.line.executionScopeId, f.scope.id);
    assert.equal(estData.line.quotationVersionId,
      f.scope.approvedQuotationVersionId);
    assert.equal(estData.event.eventType, 'ESTIMATE');
    assert.equal(estData.event.idempotencyKey, estimateKey);
    assert.equal(estData.replayed, false);
    assert.ok(Date.parse(estData.line.createdAt));
    assert.ok(Date.parse(estData.event.occurredAt));
    // Replay: same key returns the SAME rows (no second transition).
    const estReplay = await estimateViaHttp({
      token: f.token,
      scopeId: f.scope.id,
      quotationVersionId: f.scope.approvedQuotationVersionId,
      quotationLineId: f.quotationLineId,
      estimatedQty: 6,
      idempotencyKey: estimateKey,
    });
    assert.equal(estReplay.status, 200);
    const estReplayData = estReplay.body.data as {
      line: { id: string };
      event: { id: string };
      replayed: boolean;
    };
    assert.equal(estReplayData.replayed, true);
    assert.equal(estReplayData.event.id, estData.event.id);
    // Ladder over HTTP, each step bounded 200.
    const lineId = estData.line.id;
    const approve = await lineViaHttp(
      f.token, f.scope.id, lineId, 'approve', { idempotencyKey: key() });
    assert.equal(approve.status, 200, JSON.stringify(approve.body));
    assert.equal((approve.body.data as {
      line: { status: string };
    }).line.status, 'APPROVED');
    const issue = await lineViaHttp(
      f.token, f.scope.id, lineId, 'issue', {
        quantity: 5, idempotencyKey: key(),
      });
    assert.equal(issue.status, 200, JSON.stringify(issue.body));
    const issueLine = (issue.body.data as {
      line: { status: string; acquisitionMode: string | null;
        issuedQty: number };
    }).line;
    assert.equal(issueLine.status, 'ISSUED');
    assert.equal(issueLine.acquisitionMode, 'ISSUED');
    assert.equal(issueLine.issuedQty, 5);
    const use = await lineViaHttp(
      f.token, f.scope.id, lineId, 'use', {
        quantity: 2.5, idempotencyKey: key(),
      });
    assert.equal(use.status, 200, JSON.stringify(use.body));
    assert.equal((use.body.data as {
      line: { status: string; usedQty: number };
    }).line.usedQty, 2.5);
    assert.equal((use.body.data as {
      line: { status: string };
    }).line.status, 'USED');
    const ret = await lineViaHttp(
      f.token, f.scope.id, lineId, 'return', {
        quantity: 1, idempotencyKey: key(),
      });
    assert.equal(ret.status, 200, JSON.stringify(ret.body));
    const retLine = (ret.body.data as {
      line: { returnedQty: number; status: string };
    }).line;
    assert.equal(retLine.returnedQty, 1);
    assert.equal(retLine.status, 'USED'); // not a sticky status
    const settleKey = key();
    const settled = await lineViaHttp(
      f.token, f.scope.id, lineId, 'settle', {
        idempotencyKey: settleKey,
      });
    assert.equal(settled.status, 200, JSON.stringify(settled.body));
    const settledData = settled.body.data as {
      line: { status: string };
      event: { eventType: string; id: string };
    };
    assert.equal(settledData.line.status, 'FINAL_CHARGE_READY');
    assert.equal(settledData.event.eventType, 'FINAL_CHARGE_READY');
    // SETTLE replay: SAME event.
    const settleReplay = await lineViaHttp(
      f.token, f.scope.id, lineId, 'settle', {
        idempotencyKey: settleKey,
      });
    assert.equal(settleReplay.status, 200);
    assert.equal((settleReplay.body.data as {
      replayed: boolean; event: { id: string };
    }).replayed, true);
    assert.equal((settleReplay.body.data as {
      event: { id: string };
    }).event.id, settledData.event.id);
    // Settled final-used is actual consumption; returning unused stock
    // does not net it down. The scope total is grouped by authoritative UOM.
    const projection = await authed(f.token)(
      'get', `${matBase(f.scope.id)}/final-charge-ready`).send({});
    assert.equal(projection.status, 200, JSON.stringify(projection.body));
    const projData = projection.body.data as {
      executionScopeId: string;
      lines: { id: string; status: string; finalUsedQty: number;
        uom: { id: string } }[];
      totalsByUom: { uom: { id: string }; totalFinalUsedQty: number }[];
    };
    assert.equal(projData.executionScopeId, f.scope.id);
    assert.deepEqual(projData.lines.map((l) => l.id), [lineId]);
    assert.equal(projData.lines[0].finalUsedQty, 2.5);
    assert.equal(projData.lines[0].uom.id, f.uom.id);
    assert.deepEqual(projData.totalsByUom, [{
      uom: f.uom,
      totalFinalUsedQty: 2.5,
    }]);
  });

  it('2: authority — unauthenticated 401, non-Lead 403, body can never steer actor', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await leadFixture();
    const key = () => `k-${randomUUID()}`;
    const outsider = await createPlainSession();
    // Unauthenticated (no Bearer) = 401 on every surface.
    for (const [method, url, body] of [
      ['post', `${matBase(f.scope.id)}/estimate`,
        { quotationVersionId: f.scope.approvedQuotationVersionId,
          quotationLineId: f.quotationLineId,
          estimatedQty: 6, idempotencyKey: key() }],
      ['post', `${matBase(f.scope.id)}/${randomUUID()}/approve`,
        { idempotencyKey: key() }],
      ['post', `${matBase(f.scope.id)}/${randomUUID()}/settle`,
        { idempotencyKey: key() }],
      ['post', `${matBase(f.scope.id)}/${randomUUID()}/issue`,
        { quantity: 1, idempotencyKey: key() }],
      ['post', `${matBase(f.scope.id)}/${randomUUID()}/use`,
        { quantity: 1, idempotencyKey: key() }],
      ['get', `${matBase(f.scope.id)}/final-charge-ready`, {}],
      ['get', `${matBase(f.scope.id)}/progress`, {}],
    ] as const) {
      const res = await (api() as {
        [key: string]: (u: string) => {
          send: (b: unknown) => Promise<{ status: number }>;
        };
      })[method](url).send(body);
      assert.equal(res.status, 401,
        `${method} ${url} → ${res.status}`);
    }
    // Authenticated non-Lead = bounded 403 on mutation AND projection.
    const outsiderEstimate = await estimateViaHttp({
      token: outsider,
      scopeId: f.scope.id,
      quotationVersionId: f.scope.approvedQuotationVersionId,
      quotationLineId: f.quotationLineId,
      idempotencyKey: key(),
    });
    assert.equal(outsiderEstimate.status, 403);
    const outsiderProjection = await authed(outsider)(
      'get', `${matBase(f.scope.id)}/final-charge-ready`).send({});
    assert.equal(outsiderProjection.status, 403);
    const outsiderProgress = await progressViaHttp(outsider, f.scope.id);
    assert.equal(outsiderProgress.status, 403);
    // Authority-shaped keys are structurally IGNORED: spoofing
    // actorUserId/clientId/status/absolute quantities does nothing —
    // the service rejects with the SAME domain error as without them.
    const est = await estimateViaHttp({
      token: f.token,
      scopeId: f.scope.id,
      quotationVersionId: f.scope.approvedQuotationVersionId,
      quotationLineId: f.quotationLineId,
      idempotencyKey: key(),
    });
    assert.equal(est.status, 200);
    const body = est.body as {
      data: { line: { id: string; status: string } };
    };
    const spoofed = await lineViaHttp(
      f.token, f.scope.id, body.data.line.id, 'approve', {
        idempotencyKey: key(),
        actorUserId: randomUUID(), // structurally ignored
        clientId: randomUUID(),
        status: 'ISSUED', // cannot shortcut the lifecycle
        usedQty: 99, // cannot seed an absolute quantity
        occurredAt: new Date().toISOString(),
      });
    assert.equal(spoofed.status, 200);
    const spoofedLine = (spoofed.body.data as {
      line: { status: string; usedQty: number };
    }).line;
    assert.equal(spoofedLine.status, 'APPROVED'); // only APPROVED run
    assert.equal(spoofedLine.usedQty, 0);
  });

  it('3: validation — bad path/body = 400 before any authority lookup', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await leadFixture();
    const key = () => `k-${randomUUID()}`;
    // Garbage UUID path segments = 400 VALIDATION_ERROR.
    const badScope = await postWith(f.token)(
      `${V1}/handyman/execution-scopes/not-a-uuid/material-lines/estimate`,
      { quotationVersionId: f.scope.approvedQuotationVersionId,
        quotationLineId: f.quotationLineId,
        estimatedQty: 6, idempotencyKey: key() });
    assert.equal(badScope.status, 400);
    assert.equal(metErr(badScope), 'VALIDATION_ERROR');
    const badLine = await postWith(f.token)(
      `${matBase(f.scope.id)}/junk/approve`, {
        idempotencyKey: key(),
      });
    assert.equal(badLine.status, 400);
    assert.equal(metErr(badLine), 'VALIDATION_ERROR');
    // Missing/blank idempotencyKey = 400; unknown-key filler ignored.
    const missingKey = await postWith(f.token)(
      `${matBase(f.scope.id)}/estimate`, {
        quotationVersionId: f.scope.approvedQuotationVersionId,
        quotationLineId: f.quotationLineId,
        estimatedQty: 6,
      });
    assert.equal(missingKey.status, 400);
    assert.equal(metErr(missingKey), 'VALIDATION_ERROR');
    // Non-finite / negative / zero quantity = bounded 400.
    const garbageQty = await lineViaHttp(
      f.token, f.scope.id, randomUUID(), 'use', {
        quantity: 'abc', idempotencyKey: key(),
      });
    assert.equal(garbageQty.status, 400);
    assert.equal(metErr(garbageQty), 'VALIDATION_ERROR');
    // NUMERIC(14,3): reject excess decimal scale and the first
    // out-of-range integer magnitude before any database write.
    const excessEstimateScale = await estimateViaHttp({
      token: f.token,
      scopeId: f.scope.id,
      quotationVersionId: f.scope.approvedQuotationVersionId,
      quotationLineId: f.quotationLineId,
      estimatedQty: 1.2345,
      idempotencyKey: key(),
    });
    assert.equal(excessEstimateScale.status, 400);
    assert.equal(metErr(excessEstimateScale),
      'HANDYMAN_MATERIAL_EXECUTION_ESTIMATE_INVALID');
    for (const quantity of [1.2345, 100_000_000_000]) {
      const unpersistable = await lineViaHttp(
        f.token, f.scope.id, randomUUID(), 'issue', {
          quantity, idempotencyKey: key(),
        });
      assert.equal(unpersistable.status, 400);
      assert.equal(metErr(unpersistable),
        'HANDYMAN_MATERIAL_EXECUTION_QUANTITY_EXCEEDED');
    }
    // Overlong key / reference = 400.
    const longKey = await postWith(f.token)(
      `${matBase(f.scope.id)}/estimate`, {
        quotationVersionId: f.scope.approvedQuotationVersionId,
        quotationLineId: f.quotationLineId,
        estimatedQty: 6, idempotencyKey: 'x'.repeat(201),
      });
    assert.equal(longKey.status, 400);
    const longRef = await lineViaHttp(
      f.token, f.scope.id, randomUUID(), 'purchase', {
        quantity: 1, supplierReference: 'r'.repeat(201),
        idempotencyKey: key(),
      });
    assert.equal(longRef.status, 400);
    // Unknown version id ≠ the scope's APPROVED snapshot = bounded
    // 409 LINK_INVALID (PART 03: the link must anchor to the scope's
    // immutable snapshot, never to an arbitrary version — 404 is
    // reserved for unknown scope/line identity).
    const unknownVersion = await estimateViaHttp({
      token: f.token,
      scopeId: f.scope.id,
      quotationVersionId: randomUUID(),
      quotationLineId: f.quotationLineId,
      idempotencyKey: key(),
    });
    assert.equal(unknownVersion.status, 409);
    assert.equal(metErr(unknownVersion),
      'HANDYMAN_MATERIAL_EXECUTION_LINK_INVALID');
    // VALID quotationVersionId + unknown quotation line id = 409
    // (line is not a MATERIAL line ON the approved snapshot).
    const unknownQuoteLine = await estimateViaHttp({
      token: f.token,
      scopeId: f.scope.id,
      quotationVersionId: f.scope.approvedQuotationVersionId,
      quotationLineId: randomUUID(),
      idempotencyKey: key(),
    });
    assert.equal(unknownQuoteLine.status, 409);
    assert.equal(metErr(unknownQuoteLine),
      'HANDYMAN_MATERIAL_EXECUTION_LINK_INVALID');
  });

  it('4: bounded 409/404 error mapping from the services', async (t) => {
    if (!requireDatabase(t)) return;
    // Transition conflict: USE on APPROVED (no acquisition) = 409.
    const approved = await lineAt('APPROVED');
    const useBeforeAcquire = await lineViaHttp(
      approved.token, approved.scope.id, approved.lineId, 'use', {
        quantity: 1, idempotencyKey: approved.makeKey(),
      });
    assert.equal(useBeforeAcquire.status, 409);
    assert.equal(metErr(useBeforeAcquire),
      'HANDYMAN_MATERIAL_EXECUTION_ILLEGAL_TRANSITION');
    // Quantity overflow: ISSUE beyond approvedQty = 400.
    const issueOverflow = await lineViaHttp(
      approved.token, approved.scope.id, approved.lineId, 'issue', {
        quantity: 6.5, idempotencyKey: approved.makeKey(),
      });
    assert.equal(issueOverflow.status, 400);
    assert.equal(metErr(issueOverflow),
      'HANDYMAN_MATERIAL_EXECUTION_QUANTITY_EXCEEDED');
    // Unknown scope ids = 404 (never fabricated).
    const unknownScope = await estimateViaHttp({
      token: approved.token,
      scopeId: randomUUID(),
      quotationVersionId: approved.scope.approvedQuotationVersionId,
      quotationLineId: approved.quotationLineId,
      idempotencyKey: approved.makeKey(),
    });
    assert.equal(unknownScope.status, 404);
    // Unknown line id on a REAL scope = 404.
    const unknownLine = await lineViaHttp(
      approved.token, approved.scope.id, randomUUID(), 'approve', {
        idempotencyKey: approved.makeKey(),
      });
    assert.equal(unknownLine.status, 404);
    // Mixed acquisition mode over HTTP: ISSUE then PURCHASE = 409.
    const mixed = await lineViaHttp(
      approved.token, approved.scope.id, approved.lineId, 'issue', {
        quantity: 2, idempotencyKey: approved.makeKey(),
      });
    assert.equal(mixed.status, 200);
    const purchaseMixed = await lineViaHttp(
      approved.token, approved.scope.id, approved.lineId, 'purchase', {
        quantity: 1, idempotencyKey: approved.makeKey(),
      });
    assert.equal(purchaseMixed.status, 409);
    assert.equal(metErr(purchaseMixed),
      'HANDYMAN_MATERIAL_EXECUTION_ILLEGAL_TRANSITION');
  });

  it('5: Lead progress read returns quote-linked identity, UOM, and field-safe quantities', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await lineAt('ISSUED', {
      issueQty: 4.125,
      useQty: 1.25,
      returnQty: 0.5,
    });
    const response = await progressViaHttp(f.token, f.scope.id);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data as {
      executionScopeId: string;
      lines: {
        id: string;
        executionScopeId: string;
        material: { description: string; sourceItemId: string | null };
        uom: { id: string; code: string; name: string;
          symbol: string; category: string };
        status: string;
        acquisitionMode: string | null;
        estimatedQty: number;
        approvedQty: number;
        issuedQty: number;
        purchasedQty: number;
        usedQty: number;
        returnedQty: number;
        finalUsedQty: number | null;
      }[];
    };
    assert.equal(data.executionScopeId, f.scope.id);
    assert.equal(data.lines.length, 1);
    assert.deepEqual(data.lines[0], {
      id: f.lineId,
      executionScopeId: f.scope.id,
      material: { description: 'Sealant cartridge', sourceItemId: null },
      uom: f.uom,
      status: 'USED',
      acquisitionMode: 'ISSUED',
      estimatedQty: 6,
      approvedQty: 6,
      issuedQty: 4.125,
      purchasedQty: 0,
      usedQty: 1.25,
      returnedQty: 0.5,
      finalUsedQty: null,
    });
    const json = JSON.stringify(response.body);
    for (const forbidden of ['events', 'supplierReference', 'clientId',
      'quotationLineId', 'unitAmount', 'price', 'charge']) {
      assert.equal(json.includes(forbidden), false, `zero ${forbidden}`);
    }
  });

  it('6: final-used is non-negative and settled totals group by UOM', async (t) => {
    if (!requireDatabase(t)) return;
    const f = await lineAt('SETTLED', { issueQty: 4, useQty: 0.5,
      returnQty: 3 });
    const secondLine = await addSettledLineWithDifferentUom(f, {
      issuedQty: 4,
      usedQty: 1.25,
      returnedQty: 0.5,
    });
    const projection = await authed(f.token)(
      'get', `${matBase(f.scope.id)}/final-charge-ready`).send({});
    assert.equal(projection.status, 200, JSON.stringify(projection.body));
    const data = projection.body.data as {
      executionScopeId: string;
      lines: { id: string; status: string; finalUsedQty: number;
        usedQty: number; returnedQty: number; uom: { id: string } }[];
      totalsByUom: { uom: { id: string }; totalFinalUsedQty: number }[];
    };
    assert.deepEqual(data.lines.map((l) => l.id).sort(),
      [f.lineId, secondLine.lineId].sort());
    const lineById = new Map(data.lines.map((line) => [line.id, line]));
    assert.equal(lineById.get(f.lineId)?.status, 'FINAL_CHARGE_READY');
    assert.equal(lineById.get(f.lineId)?.finalUsedQty, 0.5);
    assert.equal(lineById.get(f.lineId)?.returnedQty, 3);
    assert.equal(lineById.get(secondLine.lineId)?.finalUsedQty, 1.25);
    assert.equal(data.totalsByUom.length, 2);
    assert.deepEqual(
      Object.fromEntries(data.totalsByUom.map((total) => [
        total.uom.id, total.totalFinalUsedQty,
      ])),
      { [f.uom.id]: 0.5, [secondLine.uomId]: 1.25 },
    );
    assert.equal('totalFinalUsedQty' in (projection.body.data as object), false);
    // NO financial identifier anywhere in the payload tree.
    const json = JSON.stringify(projection.body);
    for (const token of ['unitPrice', 'unitAmount', 'lineTotal',
      'currency', 'subtotal', 'totalAmount', 'rate', 'charge',
      'billable', 'billing', 'payment', 'invoice', 'fee']) {
      assert.equal(json.includes(token), false, `zero ${token}`);
    }
    // Unsettled line never appears in the projection.
    const second = await leadFixture();
    await estimateViaHttp({
      token: second.token,
      scopeId: second.scope.id,
      quotationVersionId: second.scope.approvedQuotationVersionId,
      quotationLineId: second.quotationLineId,
      idempotencyKey: `k-${randomUUID()}`,
    });
    const secondProjection = await authed(second.token)(
      'get', `${matBase(second.scope.id)}/final-charge-ready`).send({});
    assert.equal(secondProjection.status, 200);
    const secondData = secondProjection.body.data as {
      lines: unknown[];
      totalsByUom: unknown[];
    };
    assert.deepEqual(secondData.lines, []);
    assert.deepEqual(secondData.totalsByUom, []);
  });

  it('7: OpenAPI parity — every route exists, no forbidden surface', async () => {
    const doc = YAML.parse(readFileSync('docs/api/openapi.yaml',
      'utf8')) as {
      paths: Record<string, Record<string, unknown>>;
      components: { schemas: Record<string, unknown> };
    };
    const paths = Object.keys(doc.paths);
    const expectedRoutes = [
      '/handyman/execution-scopes/{executionScopeId}/material-lines',
      '/handyman/execution-scopes/{executionScopeId}/material-lines/estimate',
      '/handyman/execution-scopes/{executionScopeId}/material-lines/final-charge-ready',
      '/handyman/execution-scopes/{executionScopeId}/material-lines/progress',
      '/handyman/execution-scopes/{executionScopeId}/material-lines/{lineId}/approve',
      '/handyman/execution-scopes/{executionScopeId}/material-lines/{lineId}/issue',
      '/handyman/execution-scopes/{executionScopeId}/material-lines/{lineId}/purchase',
      '/handyman/execution-scopes/{executionScopeId}/material-lines/{lineId}/use',
      '/handyman/execution-scopes/{executionScopeId}/material-lines/{lineId}/return',
      '/handyman/execution-scopes/{executionScopeId}/material-lines/{lineId}/settle',
    ];
    for (const route of expectedRoutes) {
      assert.ok(paths.includes(route), `missing ${route}`);
    }
    // The base path is the pre-existing Customer Care history route;
    // BE12 adds a separate Lead progress route without reusing it.
    assert.equal(
      paths.filter((p) => p.includes('material-lines')).length,
      expectedRoutes.length);
    const progressOperation = (doc.paths[
      '/handyman/execution-scopes/{executionScopeId}/material-lines/progress'
    ] as { get: { responses: Record<string, unknown> } }).get;
    const progress200 = progressOperation.responses['200'] as {
      content: { 'application/json': { schema: {
        allOf: [{ $ref: string }, { properties: {
          data: { $ref: string };
        } }];
      } } };
    };
    assert.equal(progress200.content['application/json'].schema.allOf[0].$ref,
      '#/components/schemas/SuccessEnvelope');
    assert.equal(progress200.content['application/json'].schema.allOf[1]
      .properties.data.$ref,
    '#/components/schemas/HandymanMaterialProgressProjection');
    const finalOperation = (doc.paths[
      '/handyman/execution-scopes/{executionScopeId}/material-lines/final-charge-ready'
    ] as { get: { responses: Record<string, unknown> } }).get;
    const final200 = finalOperation.responses['200'] as {
      content: { 'application/json': { schema: {
        allOf: [{ $ref: string }, { properties: {
          data: { $ref: string };
        } }];
      } } };
    };
    assert.equal(final200.content['application/json'].schema.allOf[0].$ref,
      '#/components/schemas/SuccessEnvelope');
    assert.equal(final200.content['application/json'].schema.allOf[1]
      .properties.data.$ref,
    '#/components/schemas/HandymanMaterialFinalChargeReadyProjection');
    for (const schema of ['HandymanMaterialExecutionUom',
      'HandymanMaterialExecutionProgressLine',
      'HandymanMaterialProgressProjection',
      'HandymanMaterialFinalUsedTotalByUom',
      'HandymanMaterialFinalChargeReadyProjection']) {
      assert.ok(doc.components.schemas[schema], `missing schema ${schema}`);
    }
    // HTTP reality check when PostgreSQL is available.
    if (database && pool) {
      const f = await leadFixture();
      const key = () => `k-${randomUUID()}`;
      const est = await estimateViaHttp({
        token: f.token,
        scopeId: f.scope.id,
        quotationVersionId: f.scope.approvedQuotationVersionId,
        quotationLineId: f.quotationLineId,
        idempotencyKey: key(),
      });
      assert.notEqual(est.status, 404);
      const lineId = (est.body.data as { line: { id: string } }).line.id;
      for (const action of ['approve', 'issue', 'use', 'return',
        'settle'] as const) {
        const res = await lineViaHttp(
          f.token, f.scope.id, lineId, action,
          action === 'issue' || action === 'use' || action === 'return'
            ? { quantity: 1, idempotencyKey: key() }
            : { idempotencyKey: key() });
        assert.notEqual(res.status, 404,
          `route ${action} must exist (got 404)`);
      }
      for (const action of ['purchase'] as const) {
        // New line can never exist now (line already ISSUED), still
        // verifies route MOUNTED (any non-404 domain outcome).
        const res = await lineViaHttp(
          f.token, f.scope.id, lineId, action, {
            quantity: 1, idempotencyKey: key(),
          });
        assert.notEqual(res.status, 404);
      }
      const proj = await authed(f.token)(
        'get', `${matBase(f.scope.id)}/final-charge-ready`).send({});
      assert.notEqual(proj.status, 404);
      const progress = await progressViaHttp(f.token, f.scope.id);
      assert.notEqual(progress.status, 404);
    }
    // FORBIDDEN sweep: NO pricing/billing/payment/FM field may ever
    // be VALIDATED, PARSED, or SERIALIZED at the HTTP boundary —
    // comment-stripped scan over the WHOLE API layer code surface
    // (route paths plus whitelist parser plus serializer).
    const apiDir = 'src/modules/handyman-material-execution-api';
    const fsModule = await import('node:fs');
    const apiFiles = fsModule.readdirSync(apiDir).sort();
    assert.deepEqual(apiFiles, [
      'handyman-material-execution-api.controller.ts',
      'handyman-material-execution-api.routes.ts',
      'handyman-material-execution-api.validation.ts',
      'index.ts',
    ].sort());
    for (const file of apiFiles) {
      const scanned = fsModule.readFileSync(`${apiDir}/${file}`, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
        .replaceAll('final-charge-ready', 'settled-state');
      for (const token of ['price', 'unitPrice', 'unitAmount',
        'lineTotal', 'subtotal', 'totalAmount', 'rate', 'billable',
        'financial', 'monetary', 'purchaseOrder', 'goodsReceipt',
        'workOrder', 'work_order', 'stockMovement', 'commitment']) {
        assert.equal(scanned.includes(token), false,
          `zero ${token} in ${file}`);
      }
    }
    // Lead responses serialize only the existing bounded command result,
    // field-safe progress lines, and per-UOM settled totals.
    const controllerSrc = fsModule.readFileSync(
      `${apiDir}/handyman-material-execution-api.controller.ts`, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    assert.ok(controllerSrc.includes('totalFinalUsedQty'));
    assert.ok(controllerSrc.includes('sendSuccess'));
    // Exactly one router registration entry.
    const routesIndex = readFileSync('src/routes/index.ts', 'utf8');
    const registrations = routesIndex.match(
      /createHandymanMaterialExecutionApiRouter\(\)/g) ?? [];
    assert.equal(registrations.length, 1);
  });
});
