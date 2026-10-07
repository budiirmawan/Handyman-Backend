import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { AppError } from '../src/shared/errors';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { findingRegisterService, type FindingRegisterFilters } from '../src/modules/finding-register';
import { findingService } from '../src/modules/findings';
import { propertyService } from '../src/modules/properties';
import {
  REPORTING_EXPORT_DATASETS,
  REPORTING_EXPORT_DATASET_REGISTRY,
} from '../src/modules/reporting-export';
import { REPORTING_EXPORT_DATASET_METADATA } from '../src/modules/reporting-export/reporting-export.types';
import { userService } from '../src/modules/users';
import { workOrderService } from '../src/modules/work-orders';
import { createAdminUser } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * R10 PART 01 — FINDING_REGISTER optional `sourceId` filter.
 *
 * Proves: (1) optional, (2) exact match on `f.source_id`, (3) independent of
 * and conjunctive with `sourceType` (never inferred), (4) conjunctive with
 * existing filters, (5) never bypasses `f.building_id = ANY(...)`, (6) omission
 * preserves prior behavior, (7) frozen 44-column row shape, (8) Work Order
 * enrichment still requires same client AND same building, (9) no R08 Finding
 * child registered/exported, (10) no new dataset, route, permission, migration,
 * renderer, archive branch or OpenAPI change. Focused only — not a broad audit.
 */

const BASELINE_DATASETS = [
  'SECURITY_PATROL', 'SECURITY_FINDING_INCIDENT', 'WORKFORCE', 'VENDOR_TENANT', 'UTILITY',
  'MANAGEMENT_OPERATIONS_COMMAND_CENTER', 'VENDOR_SERVICE_REGISTER', 'FINDING_REGISTER',
  'WORK_ORDER_REGISTER', 'CHECKLIST_EXECUTION_SUMMARY', 'OPERATIONAL_DETAIL',
];
const FROZEN_ROW_KEYS = [
  'findingId', 'findingNumber', 'title', 'description', 'status', 'classificationId',
  'classificationCode', 'classificationName', 'severityId', 'severityCode', 'severityName',
  'severityRank', 'sourceType', 'sourceId', 'sourceReferenceNumber', 'clientId', 'buildingId',
  'assetId', 'functionalLocationId', 'reportedByUserId', 'reportedAt', 'createdAt',
  'stateChangedAt', 'assigneeType', 'assignedWorkforceProfileId', 'assignedTeamId',
  'assignedVendorId', 'assignedByUserId', 'assignedAt', 'evidenceCount', 'reworkCount',
  'latestReworkId', 'latestReworkStatus', 'latestReworkRequestedAt', 'verificationReviewId',
  'verificationReviewStatus', 'verificationDecision', 'verificationReviewerUserId',
  'verificationReviewedAt', 'closedAt', 'closedByUserId', 'closureNotes', 'historyAvailable',
  'historyCount',
];

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let managerUserId = '';
let outsiderUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE findings, work_orders, work_requests, buildings, properties,
       users, roles, permissions, clients CASCADE`,
  );
  managerUserId = (await createAdminUser()).userId;
  // Plain user with no building assignments (empty authorized scope).
  outsiderUserId = (await userService.createUser({
    email: `outsider-${randomUUID().slice(0, 8)}@example.com`,
    displayName: 'Outsider User',
  })).id;
  database = db;
});

after(async () => {
  if (pool) await closePool(pool);
  pool = null;
  database = null;
});

function ready(t: TestContext): boolean {
  if (database && pool) return true;
  t.skip('test database unavailable');
  return false;
}

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const daysAgo = (n: number) =>
  new Date(Date.now() - n * 86400000).toISOString();
const ids = (rows: { findingId: string }[]) =>
  rows.map((r) => r.findingId).sort();

type Seed = Record<
  | 'buildingAId' | 'buildingBId' | 'buildingCId' | 'woAId' | 'woANumber'
  | 'woForeignId' | 'woForeignNumber' | 'ceSourceId' | 'fWoAId'
  | 'fForeignWoId' | 'fCeId' | 'fNoSourceId' | 'fForbiddenId',
  string
>;

async function seed(): Promise<Seed> {
  // Each test re-seeds: clear prior fixture rows so absolute-count assertions
  // on non-unique filter values never see rows accumulated from earlier tests.
  await pool!.query(`TRUNCATE findings, work_orders, work_requests CASCADE`);

  async function site(name: string) {
    const client = await clientService.createClient({ code: `C_${suffix()}`, name });
    const property = await propertyService.createProperty(
      { clientId: client.id, code: `P_${suffix()}`, name });
    const building = await buildingService.createBuilding(
      { propertyId: property.id, code: `B_${suffix()}`, name });
    return { clientId: client.id, buildingId: building.id };
  }
  const a = await site('Authorized A');
  const b = await site('Authorized B');
  const c = await site('Foreign C');
  for (const buildingId of [a.buildingId, b.buildingId]) {
    await buildingAssignmentService.createAssignment(managerUserId, { buildingId });
  }

  async function workOrder(clientId: string, buildingId: string) {
    const workOrderNumber = `WO_${suffix()}`;
    const wo = await workOrderService.createWorkOrder({
      clientId, buildingId, workOrderNumber, title: 'Source work order',
      workType: 'CORRECTIVE', createdByUserId: managerUserId });
    return { id: wo.id, workOrderNumber };
  }
  const woA = await workOrder(a.clientId, a.buildingId);
  const woForeign = await workOrder(c.clientId, c.buildingId);
  const ceSourceId = randomUUID();
  async function finding(clientId: string, buildingId: string) {
    return (await findingService.createFinding({
      clientId, buildingId, findingNumber: `FND_${suffix()}`,
      title: 'Source-id fixture', description: 'Fixture',
      reportedByUserId: managerUserId })).id;
  }
  const fWoAId = await finding(a.clientId, a.buildingId);
  const fForeignWoId = await finding(a.clientId, a.buildingId);
  const fCeId = await finding(a.clientId, a.buildingId);
  const fNoSourceId = await finding(b.clientId, b.buildingId);
  // Shares woA's sourceId but sits in a building the manager cannot access.
  const fForbiddenId = await finding(c.clientId, c.buildingId);

  // `findings.source_id` has no FK (migration 0092), so pointing fForeignWo at a
  // real Work Order owned by another client/building is a valid persisted state
  // — the enrichment join must fail closed on it.
  const bind = `UPDATE findings SET source_type=$2, source_id=$3, reported_at=$4 WHERE id=$1`;
  for (const [id, type, sourceId, days] of [
    [fWoAId, 'WORK_ORDER', woA.id, 5],
    [fForeignWoId, 'WORK_ORDER', woForeign.id, 4],
    [fCeId, 'CHECKLIST_EXECUTION', ceSourceId, 3],
    [fForbiddenId, 'WORK_ORDER', woA.id, 1],
  ]) {
    await pool!.query(bind, [id, type, sourceId, daysAgo(days)]);
  }
  await pool!.query(`UPDATE findings SET reported_at=$2 WHERE id=$1`,
    [fNoSourceId, daysAgo(2)]);
  await pool!.query(`UPDATE findings SET status='IN_PROGRESS', state_changed_at=$2 WHERE id=$1`,
    [fCeId, daysAgo(3)]);

  return {
    buildingAId: a.buildingId, buildingBId: b.buildingId,
    buildingCId: c.buildingId, woAId: woA.id, woANumber: woA.workOrderNumber,
    woForeignId: woForeign.id, woForeignNumber: woForeign.workOrderNumber,
    ceSourceId, fWoAId, fForeignWoId, fCeId, fNoSourceId, fForbiddenId,
  };
}

describe('R10 PART 01 — FINDING_REGISTER sourceId filter', () => {
  const reg = (filters: FindingRegisterFilters, userId = managerUserId) =>
    findingRegisterService.getFindingRegister(filters, userId);
  const hit = async (f: FindingRegisterFilters) => ids((await reg(f)).rows);
  const none = async (f: FindingRegisterFilters) => assert.equal((await reg(f)).rows.length, 0,
    `expected no rows for ${JSON.stringify(f)}`);
  const parse = (q: Record<string, unknown>) => findingRegisterService.parseFindingRegisterQuery(q);

  it('1/6. optional; omission preserves prior behavior', async (t) => {
    if (!ready(t)) return;
    const s = await seed();
    assert.equal('sourceId' in parse({}), false);
    assert.equal('sourceId' in parse({ sourceId: undefined }), false);
    // fForbidden is out of scope; the four authorized rows remain.
    assert.deepEqual(await hit({}), [s.fCeId, s.fForeignWoId, s.fNoSourceId, s.fWoAId].sort());
    assert.deepEqual(await hit({ sourceId: undefined }), await hit({}));
    // Pre-existing filter behavior is unchanged.
    assert.deepEqual(await hit({ sourceType: 'WORK_ORDER' }), [s.fForeignWoId, s.fWoAId].sort());
  });

  it('2. exact-match predicate on f.source_id', async (t) => {
    if (!ready(t)) return;
    const s = await seed();
    const byWo = await reg({ sourceId: s.woAId });
    assert.deepEqual(ids(byWo.rows), [s.fWoAId]);
    assert.ok(byWo.rows.every((r) => r.sourceId === s.woAId));
    assert.deepEqual(await hit({ sourceId: s.ceSourceId }), [s.fCeId]);
    // Exact match only — an unrelated UUID matches nothing (no LIKE/prefix).
    await none({ sourceId: randomUUID() });
  });

  it('3. independent of, and conjunctive with, sourceType', async (t) => {
    if (!ready(t)) return;
    const s = await seed();
    // No sourceType is inferred from sourceId: a CHECKLIST_EXECUTION source id
    // paired with sourceType=WORK_ORDER must match nothing.
    await none({ sourceId: s.ceSourceId, sourceType: 'WORK_ORDER' });
    assert.deepEqual(await hit({ sourceId: s.ceSourceId, sourceType: 'CHECKLIST_EXECUTION' }),
      [s.fCeId]);
    // Symmetrically, sourceType alone never implies a sourceId.
    assert.equal((await reg({ sourceType: 'CHECKLIST_EXECUTION' })).rows.length, 1);
  });

  it('4. conjunctive with the existing filters', async (t) => {
    if (!ready(t)) return;
    const s = await seed();
    assert.deepEqual(await hit({ sourceId: s.woAId, buildingId: s.buildingAId }), [s.fWoAId]);
    await none({ sourceId: s.woAId, buildingId: s.buildingBId });
    assert.deepEqual(await hit({ sourceId: s.ceSourceId, status: 'IN_PROGRESS' }), [s.fCeId]);
    await none({ sourceId: s.ceSourceId, status: 'OPEN' });
    assert.deepEqual(await hit({
      sourceId: s.woAId,
      dateFrom: daysAgo(6).slice(0, 10), dateTo: daysAgo(4).slice(0, 10),
    }), [s.fWoAId]);
    await none({
      sourceId: s.woAId,
      dateFrom: daysAgo(2).slice(0, 10), dateTo: daysAgo(0).slice(0, 10),
    });
  });

  it('5. never bypasses the authorized-building predicate', async (t) => {
    if (!ready(t)) return;
    const s = await seed();
    assert.ok(!(await hit({ sourceId: s.woAId })).includes(s.fForbiddenId));
    // Empty authorized scope yields nothing even for a valid sourceId.
    assert.equal((await reg({ sourceId: s.woAId }, outsiderUserId)).rows.length, 0);
    // An explicitly requested unauthorized building is rejected, not narrowed.
    await assert.rejects(() => reg({ sourceId: s.woAId, buildingId: s.buildingCId }),
      (err: unknown) => err instanceof AppError);
  });

  it('7. row shape unchanged', async (t) => {
    if (!ready(t)) return;
    const s = await seed();
    const row = (await reg({ sourceId: s.woAId })).rows[0];
    assert.deepEqual(Object.keys(row).sort(), [...FROZEN_ROW_KEYS].sort());
  });

  it('8. Work Order enrichment requires same client AND same building', async (t) => {
    if (!ready(t)) return;
    const s = await seed();
    assert.equal((await reg({ sourceId: s.woAId })).rows[0].sourceReferenceNumber, s.woANumber);
    // The foreign WO exists with a real work_order_number, yet the structural
    // client/building equality must keep every enriched field null.
    const foreign = (await reg({ sourceId: s.woForeignId })).rows[0];
    assert.equal(foreign.findingId, s.fForeignWoId);
    assert.ok(s.woForeignNumber.length > 0); // a real value is being withheld
    assert.deepEqual([foreign.sourceReferenceNumber, foreign.assetId,
      foreign.functionalLocationId], [null, null, null]);
    // Non-WORK_ORDER sources still expose sourceType + sourceId only.
    const ce = (await reg({ sourceId: s.ceSourceId })).rows[0];
    assert.deepEqual(
      [ce.sourceReferenceNumber, ce.assetId, ce.functionalLocationId], [null, null, null]);
  });

  it('9/10. no new dataset, permission, migration, renderer or OpenAPI', async (t) => {
    if (!ready(t)) return;
    await seed();
    const expected = [...BASELINE_DATASETS].sort();
    // Registry is exactly the pre-PART set; no R08 Finding child is exposed.
    assert.equal(REPORTING_EXPORT_DATASETS.length, 11);
    assert.deepEqual([...REPORTING_EXPORT_DATASETS].sort(), expected);
    assert.deepEqual(Object.keys(REPORTING_EXPORT_DATASET_REGISTRY).sort(), expected);
    // The R08 Finding child grain is NOT registered as a dataset.
    assert.deepEqual(expected.filter((d) => d.includes('FINDING')),
      ['FINDING_REGISTER', 'SECURITY_FINDING_INCIDENT']);
    // Existing permission reused; none added.
    assert.equal(REPORTING_EXPORT_DATASET_REGISTRY.FINDING_REGISTER.requiredReadPermission,
      'finding.read');
    // Renderer contract unchanged: OPERATIONAL_DETAIL is still the only dataset
    // carrying a CSV default table key.
    assert.deepEqual(Object.keys(REPORTING_EXPORT_DATASET_METADATA), ['OPERATIONAL_DETAIL']);
    assert.equal(REPORTING_EXPORT_DATASET_METADATA.OPERATIONAL_DETAIL?.csvDefaultTableKey,
      'operationalDetail');
    // OpenAPI enum matches the runtime registry; no migration was added.
    const openapi = readFileSync(join(process.cwd(), 'docs/api/openapi.yaml'), 'utf8');
    const block = openapi.slice(openapi.indexOf('ReportArchiveDataset:'));
    const enumBlock = block.slice(block.indexOf('enum:'), block.indexOf('description:'));
    const documented = [...enumBlock.matchAll(/([A-Z][A-Z0-9_]{3,})/g)].map((m) => m[1]);
    assert.deepEqual(documented.sort(), expected);
    assert.equal(readdirSync(join(process.cwd(), 'src/database/migrations'))
      .some((f) => /r10|source_id_filter|finding_register/i.test(f)), false);
    // UUID parsing convention preserved (validated + lowercased).
    assert.throws(() => parse({ sourceId: 'not-a-uuid' }),
      (err: unknown) => err instanceof AppError && err.code === 'VALIDATION');
    const upper = randomUUID().toUpperCase();
    assert.equal(parse({ sourceId: upper }).sourceId, upper.toLowerCase());
  });
});
