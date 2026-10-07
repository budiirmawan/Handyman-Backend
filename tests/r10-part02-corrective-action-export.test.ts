import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { createCorrectiveAction, listCorrectiveActions,
  setCorrectiveActionDueDate, type PublicCorrectiveAction } from '../src/modules/corrective-actions';
import { createIncident } from '../src/modules/incidents';
import { propertyService } from '../src/modules/properties';
import { REPORTING_EXPORT_DATASETS, REPORTING_EXPORT_DATASET_REGISTRY,
  reportingExportService, type ReportingExportDataset } from '../src/modules/reporting-export';
import { REPORTING_EXPORT_DATASET_METADATA } from '../src/modules/reporting-export/reporting-export.types';
import { projectCorrectiveAction } from '../src/modules/reporting-export/reporting-export.r10-projections';
import { createAdminUser } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * R10 PART 02 — CORRECTIVE_ACTION export projection.
 *
 * Proves statically: registration (1,2,3,12,13,14,15), OpenAPI parity (16), no
 * renderer/archive branch (17,18), no route/permission/migration/domain change
 * (19). Proves against the pure projection and end-to-end through the owning
 * read: a verbatim single-table copy, one row per authoritative corrective
 * action, no child fan-out, no due-state recomputation (4-11). Focused only.
 */

const BASELINE_DATASETS = [
  'SECURITY_PATROL', 'SECURITY_FINDING_INCIDENT', 'WORKFORCE', 'VENDOR_TENANT', 'UTILITY',
  'MANAGEMENT_OPERATIONS_COMMAND_CENTER', 'VENDOR_SERVICE_REGISTER', 'FINDING_REGISTER',
  'WORK_ORDER_REGISTER', 'CHECKLIST_EXECUTION_SUMMARY', 'OPERATIONAL_DETAIL',
];
const FROZEN_COLUMNS = [
  'correctiveActionId', 'incidentId', 'incidentNumber', 'incidentType', 'incidentStatus',
  'clientId', 'buildingId', 'actionType', 'description', 'status', 'statusChangedAt',
  'dueDate', 'dueState', 'isOverdue', 'dueDateSetAt', 'dueDateSetByUserId',
  'verifiedByUserId', 'createdByUserId', 'createdAt', 'updatedAt',
];
const R10_PROJECTIONS = 'src/modules/reporting-export/reporting-export.r10-projections.ts';
const REGISTRY = 'src/modules/reporting-export/reporting-export.registry.ts';
const R10_FILES = [R10_PROJECTIONS, REGISTRY];
/** Domain-owned due-state vocabulary Reporting must never redeclare or derive. */
const DUE_VOCABULARY = ['NONE', 'ON_TRACK', 'OVERDUE', 'MET', 'MISSED'];
/** Renderers and archive services, which must stay dataset-generic. */
const GENERIC_FILES = ['csv-renderer', 'xlsx-renderer', 'pdf-renderer']
  .map((f) => `src/modules/reporting-export/${f}.ts`).concat(
    ['reporting-archive.validation', 'reporting-archive-generation.service']
      .map((f) => `src/modules/reporting-archives/${f}.ts`));
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
/** Comment-stripped code, so documentation prose cannot mask a real violation. */
const codeOnly = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
/** Only the CORRECTIVE_ACTION adapter block, as comment-stripped code — scoped
 * so a later R10 PART adding an unrelated dataset cannot break this scan. */
function correctiveAdapterCode(): string {
  const code = codeOnly(REGISTRY);
  const start = code.indexOf('CORRECTIVE_ACTION: {');
  assert.ok(start >= 0, 'CORRECTIVE_ACTION adapter not found in the registry');
  return code.slice(start, code.indexOf('\n  },', start));
}

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let managerUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) return;
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE corrective_actions, incidents, operational_events, buildings,
       properties, users, roles, permissions, clients CASCADE`,
  );
  managerUserId = (await createAdminUser()).userId;
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
const daysFromNow = (n: number) => new Date(Date.now() + n * 86400000).toISOString();

/** One authorized building, one REPORTED incident, and three corrective actions
 * spanning the domain's own due states: none, past deadline, future. */
async function fixture() {
  const client = await clientService.createClient({ code: `C_${suffix()}`, name: 'CA Client' });
  const property = await propertyService.createProperty(
    { clientId: client.id, code: `P_${suffix()}`, name: 'CA Property' });
  const building = await buildingService.createBuilding(
    { propertyId: property.id, code: `B_${suffix()}`, name: 'CA Building' });
  await buildingAssignmentService.createAssignment(managerUserId, { buildingId: building.id });
  const incident = await createIncident({
    buildingId: building.id, incidentNumber: `INC_${suffix()}`,
    incidentType: 'OPERATIONAL', title: 'Recurring pump seal failure' }, managerUserId);
  const action = (description: string) => createCorrectiveAction(
    { incidentId: incident.id, actionType: 'REPLACEMENT', description }, managerUserId);
  const noDue = await action('No deadline proposed');
  const pastDue = await action('Past deadline');
  const futureDue = await action('Future deadline');
  const setDue = (id: string, days: number) =>
    setCorrectiveActionDueDate(id, { dueDate: new Date(daysFromNow(days)) }, managerUserId);
  await setDue(pastDue.id, -3);
  await setDue(futureDue.id, 3);
  return { building, incident, ids: [noDue.id, pastDue.id, futureDue.id] };
}

const exportCorrective = (passThrough: Record<string, unknown> = {}) =>
  reportingExportService.getReportingExport(
    { dataset: 'CORRECTIVE_ACTION', passThrough }, managerUserId);

describe('R10 PART 02 — CORRECTIVE_ACTION export', () => {
  it('1/2/3/12/13/14/15. registration contract', () => {
    // (1)(15) exactly once, appended; the 11 pre-PART datasets keep their order.
    assert.equal(REPORTING_EXPORT_DATASETS.length, 12);
    assert.deepEqual([...REPORTING_EXPORT_DATASETS], [...BASELINE_DATASETS, 'CORRECTIVE_ACTION']);
    assert.equal(REPORTING_EXPORT_DATASETS.filter((d) => d === 'CORRECTIVE_ACTION').length, 1);
    // (2)(3) exactly one adapter, with the owning domain's read permission.
    assert.equal(Object.keys(REPORTING_EXPORT_DATASET_REGISTRY).length, 12);
    const adapter = REPORTING_EXPORT_DATASET_REGISTRY.CORRECTIVE_ACTION;
    assert.ok(adapter, 'CORRECTIVE_ACTION adapter is registered');
    assert.equal(adapter.dataset, 'CORRECTIVE_ACTION');
    assert.equal(adapter.requiredReadPermission, 'corrective_action.read');
    assert.match(adapter.sourceAuthority, /corrective-actions/);
    // (12)(13) no CSV default for this dataset; the legacy one is untouched.
    assert.equal('CORRECTIVE_ACTION' in REPORTING_EXPORT_DATASET_METADATA, false);
    assert.deepEqual(Object.keys(REPORTING_EXPORT_DATASET_METADATA), ['OPERATIONAL_DETAIL']);
    assert.equal(REPORTING_EXPORT_DATASET_METADATA.OPERATIONAL_DETAIL?.csvDefaultTableKey,
      'operationalDetail');
    // (14) every pre-PART adapter is still present with its own permission.
    for (const dataset of BASELINE_DATASETS) {
      const existing = REPORTING_EXPORT_DATASET_REGISTRY[dataset as ReportingExportDataset];
      assert.equal(existing.dataset, dataset);
      assert.equal(typeof existing.requiredReadPermission, 'string');
      assert.equal(typeof existing.load, 'function');
    }
  });

  it('16. OpenAPI ReportArchiveDataset matches the runtime enum', () => {
    const yaml = read('docs/api/openapi.yaml');
    const block = yaml.slice(yaml.indexOf('    ReportArchiveDataset:'));
    const enumBlock = block.slice(block.indexOf('enum:'), block.indexOf('description:'));
    const documented = [...enumBlock.matchAll(/([A-Z][A-Z0-9_]{3,})/g)].map((m) => m[1]);
    assert.equal(documented.length, 12);
    assert.deepEqual(documented, [...REPORTING_EXPORT_DATASETS]);
    assert.equal(documented.filter((d) => d === 'CORRECTIVE_ACTION').length, 1);
  });

  it('17/18. no renderer-specific or archive-specific branch', () => {
    for (const f of GENERIC_FILES) {
      assert.equal(codeOnly(f).includes('CORRECTIVE_ACTION'), false, `${f} must stay generic`);
    }
    // The archive path consumes the runtime dataset list generically.
    assert.ok(codeOnly('src/modules/reporting-archives/reporting-archive.validation.ts')
      .includes('REPORTING_EXPORT_DATASETS'));
  });

  it('5/6/7/8/9/10/11. projection is a verbatim single-table copy', () => {
    const base: PublicCorrectiveAction = {
      id: 'ca-1', incidentId: 'inc-1', clientId: 'cli-1', buildingId: 'bld-1',
      incidentNumber: 'INC-1', incidentType: 'OPERATIONAL', incidentStatus: 'REPORTED',
      actionType: 'REPLACEMENT', description: 'd', status: 'PROPOSED', proposedAt: '',
      approvedAt: null, approvedByUserId: null, rejectedAt: null, rejectedByUserId: null,
      rejectionReason: null, startedAt: null, completedAt: null, completedByUserId: null,
      completionNotes: null, cancelledAt: null, cancelledByUserId: null, verifiedAt: null,
      verifiedByUserId: 'v-1', statusChangedAt: 'sc', notes: null, dueDate: 'dd',
      dueDateSetAt: 'dds', dueDateSetByUserId: 'ddsu', createdByUserId: 'cbu',
      createdAt: 'ca', updatedAt: 'ua', availableActions: [],
      dueStatus: { dueDate: 'dd', dueState: 'OVERDUE', isOverdue: true, daysUntilDue: -3 },
    };
    const out = projectCorrectiveAction([base, { ...base, id: 'ca-2' }]);
    // (5) exactly one table, and no calculated headline figures.
    assert.equal(out.tables.length, 1);
    assert.equal(out.tables[0].key, 'correctiveAction');
    assert.equal(out.kpis.length, 0);
    // (6) grain: one authoritative row -> one export row, order preserved.
    assert.equal(out.tables[0].rowCount, 2);
    assert.deepEqual(out.tables[0].rows.map((r) => r.correctiveActionId), ['ca-1', 'ca-2']);
    assert.deepEqual(out.tables[0].columns.map((c) => c.key), FROZEN_COLUMNS);
    assert.deepEqual(Object.keys(out.tables[0].rows[0]).sort(), [...FROZEN_COLUMNS].sort());
    // (8)(9) due state copied verbatim from the domain's nested projection.
    assert.equal(out.tables[0].rows[0].dueState, 'OVERDUE');
    assert.equal(out.tables[0].rows[0].isOverdue, true);
    assert.equal('daysUntilDue' in out.tables[0].rows[0], false);
    // (7) verification / responsibility children are neither joined nor flattened.
    for (const key of ['verificationId', 'verifiedAt', 'responsibilityId',
      'responsibleUserId', 'verifications', 'responsibilities']) {
      assert.equal(key in out.tables[0].rows[0], false, `${key} must not appear`);
      assert.equal(out.tables[0].columns.some((c) => c.key === key), false);
    }
    // (11) incident context is carried through, never reconstructed.
    assert.equal(out.tables[0].rows[0].clientId, 'cli-1');
    assert.equal(out.tables[0].rows[0].buildingId, 'bld-1');
    assert.equal(out.tables[0].rows[0].incidentNumber, 'INC-1');
    // (10) The domain still owns the vocabulary; Reporting declares none and
    // never recomputes the outcome — no clock, no day arithmetic, no SQL, and
    // no second read authority reaching past the owning service.
    for (const [label, code] of [['projection', codeOnly(R10_PROJECTIONS)],
      ['adapter', correctiveAdapterCode()]] as const) {
      assert.equal(code.includes('CORRECTIVE_ACTION_DUE_STATES'), false,
        `${label} redeclares the due-state vocabulary`);
      for (const word of DUE_VOCABULARY) {
        assert.equal(new RegExp(`'${word}'`).test(code), false, `${label} hardcodes '${word}'`);
      }
      for (const banned of ['Date.now', 'getTime', 'MS_PER_DAY', '86400000', '86_400_000',
        'getPool', 'correctiveActionRepository', 'SELECT ', 'corrective_action_verifications',
        'corrective_action_responsibilities']) {
        assert.equal(code.includes(banned), false, `${label} contains '${banned}'`);
      }
    }
  });

  it('4/6/8/9/11. end-to-end through the authoritative corrective-action read', async (t) => {
    if (!ready(t)) return;
    const seeded = await fixture();
    const exported = await exportCorrective();
    const table = exported.tables[0];
    assert.equal(exported.tables.length, 1);
    assert.equal(table.key, 'correctiveAction');
    // (4) The rows are exactly what the owning read returns — no second authority.
    const authoritative = await listCorrectiveActions({}, managerUserId);
    assert.equal(table.rowCount, authoritative.length);
    assert.deepEqual(
      table.rows.map((r) => r.correctiveActionId).sort(),
      authoritative.map((a) => a.id).sort(),
    );
    assert.deepEqual(
      table.rows.map((r) => r.correctiveActionId).sort(), seeded.ids.slice().sort());
    // (8)(9)(11) Every projected field — including the derived deadline
    // projection and the Incident-resolved client/building — is a verbatim copy
    // of the owning domain's own published output. Whole-row equality.
    for (const action of authoritative) {
      assert.deepEqual(table.rows.find((r) => r.correctiveActionId === action.id), {
        correctiveActionId: action.id, incidentId: action.incidentId,
        incidentNumber: action.incidentNumber, incidentType: action.incidentType,
        incidentStatus: action.incidentStatus, clientId: action.clientId,
        buildingId: action.buildingId, actionType: action.actionType,
        description: action.description, status: action.status,
        statusChangedAt: action.statusChangedAt, dueDate: action.dueDate,
        dueState: action.dueStatus.dueState, isOverdue: action.dueStatus.isOverdue,
        dueDateSetAt: action.dueDateSetAt, dueDateSetByUserId: action.dueDateSetByUserId,
        verifiedByUserId: action.verifiedByUserId, createdByUserId: action.createdByUserId,
        createdAt: action.createdAt, updatedAt: action.updatedAt,
      });
    }
    // The fixture genuinely spans more than one domain due state.
    const states = new Set(table.rows.map((r) => r.dueState));
    assert.ok(states.has('NONE'), 'expected a row with no deadline');
    assert.ok(states.has('OVERDUE'), 'expected a past-deadline row');
    assert.ok(states.has('ON_TRACK'), 'expected a future-deadline row');
    assert.equal(table.rows.filter((r) => r.isOverdue === true).length,
      authoritative.filter((a) => a.dueStatus.isOverdue).length);
    // Envelope provenance: single building, no report window, filters echoed.
    assert.equal(exported.metadata.buildingId, null);
    assert.deepEqual(exported.metadata.buildingScope, [seeded.building.id]);
    assert.equal(exported.metadata.period.dateFrom, null);
    assert.equal(exported.metadata.period.dateTo, null);
    assert.deepEqual(exported.metadata.filters, {});
    assert.equal(exported.metadata.csvDefaultTableKey, undefined);
    // Filters are passed to the owning parser, not reinterpreted.
    const filtered = await exportCorrective({ incidentId: seeded.incident.id });
    assert.equal(filtered.tables[0].rowCount, 3);
    assert.equal(filtered.metadata.filters.incidentId, seeded.incident.id);
    const none = await exportCorrective({ status: 'COMPLETED' });
    assert.equal(none.tables[0].rowCount, 0);
    assert.equal(none.metadata.filters.status, 'COMPLETED');
  });

  it('19. no route, permission, migration or corrective-action domain change', () => {
    // The owning domain still gates its own routes with the same permissions,
    // and no extra Reporting permission was seeded for it.
    const routes = codeOnly('src/modules/corrective-actions/corrective-action.routes.ts');
    assert.ok(routes.includes("requirePermission('corrective_action.read')"));
    assert.ok(routes.includes("requirePermission('corrective_action.manage')"));
    assert.equal(read('src/database/seeds/foundation-access.seed.ts')
      .match(/corrective_action\.read/g)?.length, 1);
    // No migration was added, and no R10 file reaches past the owning service
    // into the corrective-action repository (no second read authority).
    assert.equal(readdirSync(join(process.cwd(), 'src/database/migrations'))
      .some((f) => /r10|corrective_action_export/i.test(f)), false);
    for (const f of R10_FILES) {
      assert.equal(codeOnly(f).includes('correctiveActionRepository'), false, f);
    }
  });
});
