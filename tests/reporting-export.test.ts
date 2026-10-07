import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { propertyService } from '../src/modules/properties';
import { createAdminUser, createPlainSession } from './helpers/access';
import { api } from './helpers/http';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * BE-23J — Export Dataset focused validation.
 *
 * Covers ONLY the BE-23J surface:
 *  - export-ready reporting dataset
 *  - period / filter metadata
 *  - KPI values
 *  - row/column structured output
 *  - generated timestamp
 *
 * The central guarantee is that BE-23J RECALCULATES NOTHING: several
 * tests pin exported values against the owning BE-23 KPI endpoint so the
 * two can never diverge. Chart rendering, PDF/Excel generation and any
 * warehouse behaviour are deliberately absent and asserted absent.
 */

let database: DatabaseConfig | null = null;
let pool: Pool | null = null;
let adminToken = '';
let adminUserId = '';

before(async () => {
  const db = await ensureTestDatabase();
  if (!db) {
    return;
  }
  pool = await initDatabase(db);
  await migrateUp(pool);
  await pool.query(
    `TRUNCATE
       reviews, utility_abnormal_consumptions, utility_abnormality_rules,
       utility_calculations, utility_calculation_bases,
       utility_meter_consumptions, utility_meter_readings,
       utility_meter_tenant_assignments, utility_meter_hierarchies,
       utility_type_uoms, utility_type_configurations, utility_meters,
       units_of_measure,
       vendor_works, vendor_assignments,
       vendor_building_relationships, vendors,
       tenant_service_requests, tenant_space_relationships,
       tenant_building_contexts, tenant_pics, tenant_companies,
       finding_escalation_incidents, operational_incidents, incidents,
       security_shift_handover_bindings, shift_handovers,
       security_finding_links, findings,
       patrol_point_visits, patrol_schedule_bindings,
       patrol_routes, patrol_route_points,
       task_assignments, generated_tasks,
       schedule_definitions, schedule_recurrence,
       checklist_executions, checklist_item_responses, checklist_items,
       checklist_templates,
       security_posts, shifts,
       work_orders, work_requests,
       workforce_building_assignments, workforce_profiles,
       teams, positions, departments, organizations,
       functional_locations, spaces, rooms, areas, floors,
       user_building_assignments, buildings, properties,
       users, roles, permissions, clients
     CASCADE`,
  );
  const admin = await createAdminUser();
  adminToken = admin.token;
  adminUserId = admin.userId;
  database = db;
});

after(async () => {
  if (pool) {
    await closePool(pool);
    pool = null;
  }
  database = null;
});

function ready(t: TestContext): boolean {
  if (!database || !pool) {
    t.skip('test database unavailable');
    return false;
  }
  return true;
}

const suffix = () => randomUUID().slice(0, 8).toUpperCase();
const auth = (token = adminToken) => ({ Authorization: `Bearer ${token}` });
const dayOffset = (days: number) =>
  new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

const EXPORT_PATH = '/api/v1/reports/export';

async function exportDataset(
  query: Record<string, string>,
  token = adminToken,
) {
  return api().get(EXPORT_PATH).query(query).set(auth(token));
}

/**
 * Minimal structure plus a little workforce / patrol activity, so the
 * exports have non-trivial rows to project.
 */
async function seed() {
  await pool!.query(
    `TRUNCATE task_assignments, generated_tasks,
       workforce_building_assignments, workforce_profiles CASCADE`,
  );

  const client = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Export client',
  });
  const property = await propertyService.createProperty({
    clientId: client.id,
    code: `P_${suffix()}`,
    name: 'Property',
  });
  const building = await buildingService.createBuilding({
    propertyId: property.id,
    code: `B_${suffix()}`,
    name: 'Building',
  });
  await buildingAssignmentService.createAssignment(adminUserId, {
    buildingId: building.id,
  });

  const foreignClient = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Foreign client',
  });
  const foreignProperty = await propertyService.createProperty({
    clientId: foreignClient.id,
    code: `P_${suffix()}`,
    name: 'Foreign property',
  });
  const foreignBuilding = await buildingService.createBuilding({
    propertyId: foreignProperty.id,
    code: `B_${suffix()}`,
    name: 'Foreign building',
  });

  // BE-03 structure + one workforce member holding assignments.
  const org = (
    await api()
      .post('/api/v1/organizations')
      .set(auth())
      .send({ clientId: client.id, code: `O_${suffix()}`, name: 'Ops' })
  ).body.data;
  const dept = (
    await api()
      .post('/api/v1/departments')
      .set(auth())
      .send({ organizationId: org.id, code: `D_${suffix()}`, name: 'Dept' })
  ).body.data;
  const position = (
    await api()
      .post(`/api/v1/organizations/${org.id}/positions`)
      .set(auth())
      .send({ code: `POS_${suffix()}`, name: 'Tech' })
  ).body.data;
  const worker = (
    await api()
      .post(`/api/v1/organizations/${org.id}/workforce-profiles`)
      .set(auth())
      .send({
        departmentId: dept.id,
        positionId: position.id,
        employeeCode: `WF_${suffix()}`,
        fullName: 'Export Tech',
      })
  ).body.data;
  await api()
    .post(`/api/v1/workforce/${worker.id}/buildings`)
    .set(auth())
    .send({ buildingId: building.id });

  const template = (
    await api()
      .post(`/api/v1/clients/${client.id}/checklist-templates`)
      .set(auth())
      .send({ code: `CT_${suffix()}`, name: 'Checklist', status: 'ACTIVE' })
  ).body.data;
  const schedule = (
    await api()
      .post('/api/v1/schedules')
      .set(auth())
      .send({
        targetType: 'CHECKLIST_TEMPLATE',
        targetId: template.id,
        code: `SCH_${suffix()}`,
        name: 'Schedule',
        startAt: `${dayOffset(-10)}T00:00:00.000Z`,
        timezone: 'UTC',
        buildingId: building.id,
      })
  ).body.data;

  const yesterday = dayOffset(-1);

  // One completed assignment (2h) and one overdue open assignment.
  async function addTask(
    occurrenceAt: string,
    status: string,
    options: { startedAt?: string; completedAt?: string } = {},
  ) {
    const taskId = randomUUID();
    await pool!.query(
      `INSERT INTO generated_tasks
         (id, client_id, schedule_definition_id, occurrence_at, target_type,
          target_id, building_id, status, started_at, completed_at)
       VALUES ($1,$2,$3,$4,'CHECKLIST_TEMPLATE',$5,$6,$7,$8,$9)`,
      [
        taskId,
        client.id,
        schedule.id,
        occurrenceAt,
        template.id,
        building.id,
        status,
        options.startedAt ?? null,
        options.completedAt ?? null,
      ],
    );
    await pool!.query(
      `INSERT INTO task_assignments
         (id, task_id, assignee_type, workforce_profile_id,
          assigned_by_user_id, status)
       VALUES ($1,$2,'WORKFORCE',$3,$4,'ACTIVE')`,
      [randomUUID(), taskId, worker.id, adminUserId],
    );
    return taskId;
  }

  await addTask(`${yesterday}T01:00:00.000Z`, 'COMPLETED', {
    startedAt: `${yesterday}T01:00:00.000Z`,
    completedAt: `${yesterday}T03:00:00.000Z`,
  });
  await addTask(`${yesterday}T05:00:00.000Z`, 'OPEN');

  return { client, building, foreignBuilding, worker, yesterday };
}

describe('BE-23J reporting export dataset', () => {
  it('exports an envelope with metadata, kpis, tables and a generated timestamp', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await exportDataset({
      dataset: 'WORKFORCE',
      buildingId: f.building.id,
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data;

    // The envelope shape is exactly the BE-23J contract.
    assert.deepEqual(Object.keys(data).sort(), [
      'generatedAt',
      'kpis',
      'metadata',
      'tables',
    ]);

    // Metadata: dataset identity, building scope and period.
    assert.equal(data.metadata.dataset, 'WORKFORCE');
    assert.equal(data.metadata.datasetLabel, 'Workforce');
    assert.equal(data.metadata.buildingId, f.building.id);
    assert.deepEqual(data.metadata.buildingScope, [f.building.id]);
    assert.equal(data.metadata.period.dateFrom, null);
    assert.equal(data.metadata.period.dateTo, null);
    assert.ok(data.metadata.asOf, 'asOf must be carried from the KPI');

    // Generated timestamp is a valid, recent ISO-8601 instant.
    assert.ok(!Number.isNaN(Date.parse(data.generatedAt)));
    assert.ok(
      Math.abs(Date.now() - Date.parse(data.generatedAt)) < 60_000,
      'generatedAt should be the moment of export',
    );

    // asOf (measurement) and generatedAt (envelope) are distinct fields.
    assert.ok('asOf' in data.metadata);
    assert.ok(!('asOf' in data));
  });

  it('emits flat KPI values with key, label, value and type', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await exportDataset({
      dataset: 'WORKFORCE',
      buildingId: f.building.id,
    });
    const kpis = response.body.data.kpis;

    assert.ok(Array.isArray(kpis) && kpis.length > 0);
    for (const entry of kpis) {
      assert.deepEqual(Object.keys(entry).sort(), [
        'key',
        'label',
        'type',
        'value',
      ]);
      assert.ok(['STRING', 'NUMBER', 'PERCENT', 'DATE'].includes(entry.type));
    }

    // KPI keys are unique — a spreadsheet column can address each one.
    const keys = kpis.map((entry: { key: string }) => entry.key);
    assert.equal(new Set(keys).size, keys.length);

    const byKey = (key: string) =>
      kpis.find((entry: { key: string }) => entry.key === key);
    assert.equal(byKey('workforceTotal').value, 1);
    assert.equal(byKey('assignmentsScheduled').value, 2);
    assert.equal(byKey('assignmentsCompleted').value, 1);
    assert.equal(byKey('manHoursTotal').value, 2);
    assert.equal(byKey('assignmentCompletionRate').type, 'PERCENT');
  });

  it('emits row/column structured tables whose rows match their columns', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await exportDataset({
      dataset: 'WORKFORCE',
      buildingId: f.building.id,
    });
    const tables = response.body.data.tables;

    assert.ok(Array.isArray(tables) && tables.length > 0);

    for (const table of tables) {
      assert.deepEqual(Object.keys(table).sort(), [
        'columns',
        'key',
        'label',
        'rowCount',
        'rows',
      ]);
      assert.equal(table.rowCount, table.rows.length);
      assert.ok(table.columns.length > 0);

      const columnKeys = table.columns.map((c: { key: string }) => c.key);
      // Column keys are unique and every row is addressable by them.
      assert.equal(new Set(columnKeys).size, columnKeys.length);
      for (const row of table.rows) {
        assert.deepEqual(
          Object.keys(row).sort(),
          [...columnKeys].sort(),
          'every row must carry exactly the declared columns',
        );
      }
    }

    const members = tables.find(
      (tbl: { key: string }) => tbl.key === 'workforceMembers',
    );
    assert.ok(members, 'expected the workforce members table');
    assert.equal(members.rowCount, 1);
    assert.equal(members.rows[0].workforceId, f.worker.id);
    assert.equal(members.rows[0].fullName, 'Export Tech');
    assert.equal(members.rows[0].totalHours, 2);
  });

  it('does not recalculate: exported values equal the owning KPI endpoint', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const [exported, kpi] = await Promise.all([
      exportDataset({ dataset: 'WORKFORCE', buildingId: f.building.id }),
      api()
        .get('/api/v1/workforce/reports/kpi')
        .query({ buildingId: f.building.id })
        .set(auth()),
    ]);
    assert.equal(exported.status, 200, JSON.stringify(exported.body));
    assert.equal(kpi.status, 200, JSON.stringify(kpi.body));

    const value = (key: string) =>
      exported.body.data.kpis.find((e: { key: string }) => e.key === key).value;
    const source = kpi.body.data;

    assert.equal(value('workforceTotal'), source.workforce.total);
    assert.equal(value('assignmentsScheduled'), source.assignments.scheduled);
    assert.equal(value('assignmentsCompleted'), source.assignments.completed);
    assert.equal(value('assignmentsOverdue'), source.assignments.overdue);
    assert.equal(
      value('assignmentCompletionRate'),
      source.assignments.completionRate,
    );
    assert.equal(value('manHoursTotal'), source.manHours.totalHours);

    // The per-member table is a verbatim projection too.
    const members = exported.body.data.tables.find(
      (tbl: { key: string }) => tbl.key === 'workforceMembers',
    );
    assert.equal(members.rowCount, source.byWorkforce.length);
    assert.equal(members.rows[0].totalHours, source.byWorkforce[0].totalHours);
    assert.equal(
      members.rows[0].completionRate,
      source.byWorkforce[0].completionRate,
    );
  });

  it('exports every supported dataset', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const datasets = [
      ['SECURITY_PATROL', 'Security Patrol & Activity'],
      ['SECURITY_FINDING_INCIDENT', 'Security Finding / Incident / Handover'],
      ['WORKFORCE', 'Workforce'],
      ['VENDOR_TENANT', 'Vendor / Tenant'],
      ['UTILITY', 'Utility'],
    ] as const;

    for (const [dataset, label] of datasets) {
      const response = await exportDataset({
        dataset,
        buildingId: f.building.id,
      });
      assert.equal(
        response.status,
        200,
        `${dataset}: ${JSON.stringify(response.body)}`,
      );
      const data = response.body.data;
      assert.equal(data.metadata.dataset, dataset);
      assert.equal(data.metadata.datasetLabel, label);
      assert.ok(Array.isArray(data.kpis) && data.kpis.length > 0, dataset);
      assert.ok(Array.isArray(data.tables) && data.tables.length > 0, dataset);
      assert.ok(data.generatedAt, dataset);
    }
  });

  it('carries period and dataset-specific filter metadata', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await exportDataset({
      dataset: 'SECURITY_PATROL',
      buildingId: f.building.id,
      dateFrom: f.yesterday,
      dateTo: f.yesterday,
      graceMinutes: '30',
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const metadata = response.body.data.metadata;

    assert.equal(metadata.period.dateFrom, f.yesterday);
    assert.equal(metadata.period.dateTo, f.yesterday);
    // The dataset's own filters are echoed back for provenance.
    assert.equal(metadata.filters.buildingId, f.building.id);
    assert.equal(metadata.filters.graceMinutes, 30);

    // A utility export echoes its own distinct filter vocabulary.
    const utility = await exportDataset({
      dataset: 'UTILITY',
      buildingId: f.building.id,
      interval: 'YEAR',
    });
    assert.equal(utility.status, 200, JSON.stringify(utility.body));
    assert.equal(utility.body.data.metadata.filters.interval, 'YEAR');
    assert.equal(
      utility.body.data.metadata.filters.meterScope,
      'EXCLUDE_SUB_METERS',
    );
  });

  it('delegates filter validation to the owning KPI module', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    // `graceMinutes` belongs to the patrol KPI; its rules still apply.
    const badGrace = await exportDataset({
      dataset: 'SECURITY_PATROL',
      buildingId: f.building.id,
      graceMinutes: '-1',
    });
    assert.equal(badGrace.status, 400, JSON.stringify(badGrace.body));

    // `interval` belongs to the utility KPI.
    const badInterval = await exportDataset({
      dataset: 'UTILITY',
      buildingId: f.building.id,
      interval: 'WEEK',
    });
    assert.equal(badInterval.status, 400, JSON.stringify(badInterval.body));

    // `workforceType` belongs to the workforce KPI.
    const badType = await exportDataset({
      dataset: 'WORKFORCE',
      buildingId: f.building.id,
      workforceType: 'PERMANENT',
    });
    assert.equal(badType.status, 400, JSON.stringify(badType.body));

    const badBuilding = await exportDataset({
      dataset: 'WORKFORCE',
      buildingId: 'not-a-uuid',
    });
    assert.equal(badBuilding.status, 400, JSON.stringify(badBuilding.body));
  });

  it('rejects a missing or unknown dataset', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const missing = await api().get(EXPORT_PATH).set(auth());
    assert.equal(missing.status, 400, JSON.stringify(missing.body));
    assert.equal(missing.body.error.code, 'VALIDATION_ERROR');

    const unknown = await exportDataset({
      dataset: 'FINANCE',
      buildingId: f.building.id,
    });
    assert.equal(unknown.status, 400, JSON.stringify(unknown.body));
  });

  it('inherits building access enforcement from the KPI service', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await exportDataset({
      dataset: 'WORKFORCE',
      buildingId: f.foreignBuilding.id,
    });
    assert.equal(response.status, 403, JSON.stringify(response.body));
  });

  it('requires authentication and the reporting_export.read permission', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const anonymous = await api()
      .get(EXPORT_PATH)
      .query({ dataset: 'WORKFORCE', buildingId: f.building.id });
    assert.equal(anonymous.status, 401, JSON.stringify(anonymous.body));

    const plainToken = await createPlainSession();
    const forbidden = await exportDataset(
      { dataset: 'WORKFORCE', buildingId: f.building.id },
      plainToken,
    );
    assert.equal(forbidden.status, 403, JSON.stringify(forbidden.body));
  });

  it('returns JSON only — no chart, file or binary payload', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await exportDataset({
      dataset: 'WORKFORCE',
      buildingId: f.building.id,
    });
    assert.equal(response.status, 200);
    assert.match(response.headers['content-type'], /application\/json/);
    // No file download semantics.
    assert.equal(response.headers['content-disposition'], undefined);

    // No charting or file-format keys leak into the envelope.
    const serialised = JSON.stringify(response.body.data);
    for (const forbidden of [
      'chart',
      'series',
      'axis',
      'pdf',
      'xlsx',
      'base64',
    ]) {
      assert.ok(
        !serialised.toLowerCase().includes(forbidden),
        `export must not contain "${forbidden}"`,
      );
    }
  });

  it('exports a well-formed empty envelope when there is nothing in range', async (t) => {
    if (!ready(t)) return;
    const f = await seed();

    const response = await exportDataset({
      dataset: 'WORKFORCE',
      buildingId: f.building.id,
      dateFrom: dayOffset(60),
      dateTo: dayOffset(61),
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const data = response.body.data;

    const value = (key: string) =>
      data.kpis.find((e: { key: string }) => e.key === key).value;
    assert.equal(value('assignmentsScheduled'), 0);
    assert.equal(value('assignmentCompletionRate'), 0);
    assert.equal(value('manHoursTotal'), 0);

    // Structure is still fully present — an empty export is not a null one.
    assert.ok(data.tables.length > 0);
    const members = data.tables.find(
      (tbl: { key: string }) => tbl.key === 'workforceMembers',
    );
    assert.equal(members.rowCount, 0);
    assert.deepEqual(members.rows, []);
    assert.ok(members.columns.length > 0);
    assert.ok(data.generatedAt);
  });
});
