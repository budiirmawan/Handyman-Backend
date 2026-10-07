import assert from 'node:assert/strict';
import { after, before, describe, it, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { DatabaseConfig } from '../src/config';
import { closePool, initDatabase, migrateUp } from '../src/database';
import {
  checklistAdministrationService,
} from '../src/modules/checklist-administration';
import {
  getChecklistExecutionSummary,
  parseChecklistExecutionSummaryQuery,
} from '../src/modules/checklist-execution-summary';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import { clientService } from '../src/modules/clients';
import { sourceFormService } from '../src/modules/source-forms';
import { formTemplateService } from '../src/modules/form-templates';
import { propertyService } from '../src/modules/properties';
import { userService } from '../src/modules/users';
import { AppError } from '../src/shared/errors';
import { createAdminUser } from './helpers/access';
import { ensureTestDatabase } from './helpers/postgres';

/**
 * CR-BE-REPORT-READ-04 PART 01 — Checklist Execution Summary focused validation.
 *
 * Covers ONLY the read contract surface (service-level; no HTTP endpoint).
 * Spine fixtures use the authoritative services for clients/properties/buildings/
 * users/source-forms/form-templates/checklist-templates; executions and bindings
 * are pinned by direct SQL exactly as the register tests do.
 */

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
    `TRUNCATE
       operational_events, evidence_submissions, reviews, findings,
       form_responses, form_instances, form_template_version_fields,
       form_template_version_sections, form_template_versions,
       form_fields, form_sections, form_templates, source_forms,
       checklist_item_responses, checklist_items, checklist_executions,
       checklist_templates, engineering_checklist_bindings,
       inspection_bindings, patrol_checklist_bindings,
       toilet_inspection_bindings, public_area_inspection_bindings,
       vendor_checklist_bindings, vendor_works, vendor_assignments,
       vendors, meter_reading_bindings, log_sheet_bindings,
       generated_tasks, schedule_definitions, assets, functional_locations,
       workforce_building_assignments, workforce_profiles,
       buildings, properties,
       users, roles, permissions, clients
     CASCADE`,
  );
  const admin = await createAdminUser();
  managerUserId = admin.userId;

  const outsider = await userService.createUser({
    email: `outsider-${randomUUID().slice(0, 8)}@example.com`,
    displayName: 'Outsider User',
  });
  outsiderUserId = outsider.id;
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
const daysAgoIso = (days: number) =>
  new Date(Date.now() - days * 86400000).toISOString();

type Seed = {
  clientAId: string;
  clientCId: string;
  buildingAId: string;
  buildingBId: string;
  buildingCId: string;
  clTpl1Id: string;
  asset1Id: string;
  fl1Id: string;
  vendorId: string;
  vworkId: string;
  ceEngineeringId: string;
  ceVendorId: string;
  ceUnboundId: string;
  ceTaskBoundId: string;
  fiMeterId: string;
  fiLogId: string;
  fiTaskBoundId: string;
  ceForbiddenId: string;
  formTplId: string;
  formVersionId: string;
  scheduleId: string;
};

async function seed(): Promise<Seed> {
  const clientA = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Register client A',
  });
  const propA = await propertyService.createProperty({
    clientId: clientA.id,
    code: `P_${suffix()}`,
    name: 'Property A',
  });
  const buildingA = await buildingService.createBuilding({
    propertyId: propA.id,
    code: `B_${suffix()}`,
    name: 'Building A',
  });
  const buildingB = await buildingService.createBuilding({
    propertyId: propA.id,
    code: `B_${suffix()}`,
    name: 'Building B',
  });
  await buildingAssignmentService.createAssignment(managerUserId, {
    buildingId: buildingA.id,
  });
  await buildingAssignmentService.createAssignment(managerUserId, {
    buildingId: buildingB.id,
  });

  const clientC = await clientService.createClient({
    code: `C_${suffix()}`,
    name: 'Forbidden client',
  });
  const propC = await propertyService.createProperty({
    clientId: clientC.id,
    code: `P_${suffix()}`,
    name: 'Property C',
  });
  const buildingC = await buildingService.createBuilding({
    propertyId: propC.id,
    code: `B_${suffix()}`,
    name: 'Building C (forbidden)',
  });

  // Asset + functional location.
  const { assetService } = await import('../src/modules/assets');
  const { functionalLocationService } = await import(
    '../src/modules/functional-locations'
  );
  const asset1 = await assetService.createAsset({
    buildingId: buildingA.id,
    assetCode: `AST_${suffix()}`,
    assetName: 'Chiller 1',
  });
  const fl1 = await functionalLocationService.createFunctionalLocation({
    buildingId: buildingA.id,
    code: `FL_${suffix()}`,
    name: 'Chiller Room',
  });

  // Checklist template (engineering).
  const tpl = await checklistAdministrationService.createBuildingChecklist(
    buildingA.id,
    {
      code: `CL_${suffix()}`,
      name: 'Engineering Daily',
      status: 'ACTIVE',
    },
    managerUserId,
  );
  const clTpl1Id = tpl.template.id;
  // Add 3 items so itemCount is non-trivial.
  for (let i = 0; i < 3; i++) {
    await checklistAdministrationService.createChecklistItem(
      clTpl1Id,
      {
        code: `ITM_${suffix()}`,
        label: `Item ${i}`,
        itemType: i === 0 ? 'CHECK' : i === 1 ? 'NUMBER' : 'TEXT',
        required: i === 0,
        displayOrder: i,
      },
      managerUserId,
    );
  }

  // Vendor + vendor_work for vendor-bound CE.
  const { vendorService } = await import('../src/modules/vendors');
  const vendor = await vendorService.createVendor({
    clientId: clientA.id,
    vendorCode: `VND_${suffix()}`,
    vendorName: 'Acme Vendors',
  });
  // Minimal vendor_work + vendor_assignment via direct SQL to avoid broad orchestration.
  const vaId = randomUUID();
  await pool!.query(
    `INSERT INTO vendor_assignments (id, client_id, vendor_id, building_id, work_order_id, status, assigned_by_user_id, assigned_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,NULL,'ACTIVE',$5,NOW(),NOW(),NOW())`,
    [vaId, clientA.id, vendor.id, buildingA.id, managerUserId],
  );
  const vworkId = randomUUID();
  await pool!.query(
    `INSERT INTO vendor_works (id, vendor_assignment_id, vendor_id, work_order_id, building_id, status, created_at, updated_at)
     VALUES ($1,$2,$3,'00000000-0000-0000-0000-000000000000',$4,'NOT_STARTED',NOW(),NOW())`,
    [vworkId, vaId, vendor.id, buildingA.id],
  );

  // Engineering checklist binding (buildingA + asset1 + fl1).
  const ecbId = randomUUID();
  await pool!.query(
    `INSERT INTO engineering_checklist_bindings
       (id, client_id, building_id, checklist_template_id, asset_id, functional_location_id, status, created_by_user_id, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,'ACTIVE',$7,NOW(),NOW())`,
    [ecbId, clientA.id, buildingA.id, clTpl1Id, asset1.id, fl1.id, managerUserId],
  );

  // CE1 — engineering-bound execution (fully-linked CE).
  const ceEngineeringId = randomUUID();
  await pool!.query(
    `INSERT INTO checklist_executions
       (id, client_id, checklist_template_id, engineering_checklist_binding_id,
        status, started_at, completed_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'COMPLETED',$5,$6,$7,NOW())`,
    [ceEngineeringId, clientA.id, clTpl1Id, ecbId,
     daysAgoIso(3), daysAgoIso(1), daysAgoIso(5)],
  );

  // CE2 — vendor-bound execution (vendor_checklist_bindings reverse-FK).
  const ceVendorId = randomUUID();
  await pool!.query(
    `INSERT INTO checklist_executions
       (id, client_id, checklist_template_id, status, created_at, updated_at)
     VALUES ($1,$2,$3,'COMPLETED',$4,NOW())`,
    [ceVendorId, clientA.id, clTpl1Id, daysAgoIso(4)],
  );
  const vcbId = randomUUID();
  await pool!.query(
    `INSERT INTO vendor_checklist_bindings
       (id, client_id, vendor_work_id, checklist_template_id, checklist_execution_id,
        building_id, work_order_id, status, created_by_user_id, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,'00000000-0000-0000-0000-000000000000','ACTIVE',$7,NOW(),NOW())`,
    [vcbId, clientA.id, vworkId, clTpl1Id, ceVendorId, buildingA.id, managerUserId],
  );

  // CE3 — unbound / no-building execution (MUST BE EXCLUDED).
  const ceUnboundId = randomUUID();
  await pool!.query(
    `INSERT INTO checklist_executions
       (id, client_id, checklist_template_id, status, created_at, updated_at)
     VALUES ($1,$2,$3,'DRAFT',NOW(),NOW())`,
    [ceUnboundId, clientA.id, clTpl1Id],
  );

  // Generated task (for task-bound CE + FI).
  const scheduleId = randomUUID();
  await pool!.query(
    `INSERT INTO schedule_definitions (id, client_id, building_id, schedule_type, schedule_config, created_at, updated_at)
     VALUES ($1,$2,$3,'DAILY','{}'::jsonb,NOW(),NOW())`,
    [scheduleId, clientA.id, buildingA.id],
  );
  const taskCE = randomUUID();
  await pool!.query(
    `INSERT INTO generated_tasks
       (id, client_id, schedule_definition_id, occurrence_at, target_type, target_id, building_id, status, generated_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'CHECKLIST_TEMPLATE',$5,$6,'OPEN',NOW(),NOW(),NOW())`,
    [taskCE, clientA.id, scheduleId, daysAgoIso(2), clTpl1Id, buildingA.id],
  );
  const ceTaskBoundId = randomUUID();
  await pool!.query(
    `INSERT INTO checklist_executions
       (id, client_id, checklist_template_id, generated_task_id, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'IN_PROGRESS',$5,NOW())`,
    [ceTaskBoundId, clientA.id, clTpl1Id, taskCE, daysAgoIso(2)],
  );

  // Form template + version.
  const sf = await sourceFormService.createSourceForm({
    clientId: clientA.id,
    code: `SF_${suffix()}`,
    name: 'Meter Source',
    sourceType: 'INTERNAL',
  });
  const ft = await formTemplateService.createFormTemplate({
    sourceFormId: sf.id,
    code: `FT_${suffix()}`,
    name: 'Meter Log Form',
    status: 'ACTIVE',
  });
  const formTplId = ft.id;
  const formVersionId = randomUUID();
  const sec1Id = randomUUID();
  const fld1Id = randomUUID();
  const fld2Id = randomUUID();
  await pool!.query(
    `INSERT INTO form_template_versions
       (id, form_template_id, version_number, status, published_at, created_at, updated_at)
     VALUES ($1,$2,1,'PUBLISHED',NOW(),NOW(),NOW())`,
    [formVersionId, formTplId],
  );
  await pool!.query(
    `INSERT INTO form_sections (id, form_template_id, code, title, display_order, status, created_at, updated_at)
     VALUES ($1,$2,'SEC1','Section 1',0,'ACTIVE',NOW(),NOW())`,
    [sec1Id, formTplId],
  );
  await pool!.query(
    `INSERT INTO form_template_version_sections
       (id, version_id, section_id, code, title, description, display_order, status)
     VALUES ($1,$2,$3,'SEC1','Section 1',NULL,0,'ACTIVE')`,
    [randomUUID(), formVersionId, sec1Id],
  );
  // get the version-section id (we just inserted):
  const vsRow = await pool!.query<{ id: string }>(
    `SELECT id FROM form_template_version_sections WHERE version_id=$1 LIMIT 1`,
    [formVersionId],
  );
  const vsId = vsRow.rows[0].id;
  await pool!.query(
    `INSERT INTO form_fields
       (id, form_section_id, code, label, field_type, required, display_order, status, created_at, updated_at)
     VALUES
       ($1,$2,'F1','Temperature','NUMBER',TRUE,0,'ACTIVE',NOW(),NOW()),
       ($3,$2,'F2','Notes','TEXT',FALSE,1,'ACTIVE',NOW(),NOW())`,
    [fld1Id, sec1Id, fld2Id],
  );
  await pool!.query(
    `INSERT INTO form_template_version_fields
       (id, version_section_id, field_id, code, label, field_type, required, display_order, status)
     VALUES
       ($1,$2,$3,'F1','Temperature','NUMBER',TRUE,0,'ACTIVE'),
       ($4,$2,$5,'F2','Notes','TEXT',FALSE,1,'ACTIVE')`,
    [randomUUID(), vsId, fld1Id, randomUUID(), vsId, fld2Id],
  );

  // Meter reading binding (buildingA + asset1 + fl1).
  const uomRow = await pool!.query<{ id: string }>(
    `INSERT INTO units_of_measure (id, client_id, code, name, symbol, category, status, created_at, updated_at)
     VALUES ($1,$2,'C','Celsius','C','TEMPERATURE','ACTIVE',NOW(),NOW()) RETURNING id`,
    [randomUUID(), clientA.id],
  );
  const mrbId = randomUUID();
  await pool!.query(
    `INSERT INTO meter_reading_bindings
       (id, client_id, building_id, asset_id, functional_location_id, form_field_id, uom_id, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'ACTIVE',NOW(),NOW())`,
    [mrbId, clientA.id, buildingA.id, asset1.id, fl1.id, fld1Id, uomRow.rows[0].id],
  );
  const fiMeterId = randomUUID();
  await pool!.query(
    `INSERT INTO form_instances
       (id, client_id, form_template_version_id, meter_reading_binding_id, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'COMPLETED',$5,NOW())`,
    [fiMeterId, clientA.id, formVersionId, mrbId, daysAgoIso(4)],
  );

  // Log sheet binding (buildingA).
  const lsbId = randomUUID();
  await pool!.query(
    `INSERT INTO log_sheet_bindings
       (id, client_id, building_id, form_template_version_id, code, title, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'LOG','Daily Log','ACTIVE',NOW(),NOW())`,
    [lsbId, clientA.id, buildingA.id, formVersionId],
  );
  const fiLogId = randomUUID();
  await pool!.query(
    `INSERT INTO form_instances
       (id, client_id, form_template_version_id, log_sheet_binding_id, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'COMPLETED',$5,NOW())`,
    [fiLogId, clientA.id, formVersionId, lsbId, daysAgoIso(3)],
  );

  // Task-bound FI (uses generated_task on FORM_VERSION — we need a FORM_VERSION task).
  const taskFI = randomUUID();
  await pool!.query(
    `INSERT INTO generated_tasks
       (id, client_id, schedule_definition_id, occurrence_at, target_type, target_id, building_id, status, generated_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'FORM_VERSION',$5,$6,'OPEN',NOW(),NOW(),NOW())`,
    [taskFI, clientA.id, scheduleId, daysAgoIso(1), formVersionId, buildingA.id],
  );
  const fiTaskBoundId = randomUUID();
  await pool!.query(
    `INSERT INTO form_instances
       (id, client_id, form_template_version_id, generated_task_id, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'IN_PROGRESS',$5,NOW())`,
    [fiTaskBoundId, clientA.id, formVersionId, taskFI, daysAgoIso(1)],
  );

  // Forbidden CE (buildingC).
  const clTplCId = randomUUID();
  await pool!.query(
    `INSERT INTO checklist_templates (id, client_id, code, name, status, created_at, updated_at)
     VALUES ($1,$2,$3,'Forbidden Tpl','ACTIVE',NOW(),NOW())`,
    [clTplCId, clientC.id, `CL_${suffix()}`],
  );
  const ceForbiddenId = randomUUID();
  await pool!.query(
    `INSERT INTO checklist_executions
       (id, client_id, checklist_template_id, status, created_at, updated_at)
     VALUES ($1,$2,$3,'DRAFT',NOW(),NOW())`,
    [ceForbiddenId, clientC.id, clTplCId],
  );

  // Evidence (2 ACTIVE + 1 REMOVED for CE1; 1 ACTIVE for FI meter).
  await pool!.query(
    `INSERT INTO evidence_submissions
       (id, client_id, evidence_requirement_id, execution_type, execution_id,
        evidence_type, file_reference, original_file_name, mime_type, file_size,
        captured_at, submitted_by_user_id, status, created_at)
     VALUES
       ($1,$2,NULL,'CHECKLIST_EXECUTION',$3,'PHOTO','r1','a.jpg','image/jpeg',100,$4,$5,'ACTIVE',NOW()),
       ($6,$2,NULL,'CHECKLIST_EXECUTION',$3,'PHOTO','r2','b.jpg','image/jpeg',200,$4,$5,'ACTIVE',NOW()),
       ($7,$2,NULL,'CHECKLIST_EXECUTION',$3,'PHOTO','r3','c.jpg','image/jpeg',300,$4,$5,'REMOVED',NOW()),
       ($8,$2,NULL,'FORM_INSTANCE',$9,'PHOTO','r4','d.jpg','image/jpeg',100,$4,$5,'ACTIVE',NOW())`,
    [randomUUID(), clientA.id, ceEngineeringId, daysAgoIso(2), managerUserId,
     randomUUID(), randomUUID(), randomUUID(), fiMeterId],
  );

  // Findings — one OPEN + one CLOSED for ceEngineeringId (total 2).
  await pool!.query(
    `INSERT INTO findings
       (id, client_id, building_id, finding_number, title,
        source_type, source_id, status, reported_by_user_id, reported_at, created_at)
     VALUES
       ($1,$2,$3,$4,'Finding A','CHECKLIST_EXECUTION',$5,'OPEN',$6,$7,$7),
       ($8,$2,$3,$9,'Finding B','CHECKLIST_EXECUTION',$5,'VERIFIED',$6,$7,$7)`,
    [randomUUID(), clientA.id, buildingA.id, `FND_${suffix()}`, ceEngineeringId, managerUserId, daysAgoIso(1),
     randomUUID(), `FND_${suffix()}`],
  );

  // Reviews: older REJECTED, latest APPROVED on ceEngineeringId.
  await pool!.query(
    `INSERT INTO reviews
       (id, client_id, target_type, target_id, reviewer_user_id, decision, notes,
        reviewed_at, created_at, status)
     VALUES
       ($1,$2,'CHECKLIST_EXECUTION',$3,$4,'REJECTED','needs redo',$5,$5,'COMPLETED'),
       ($6,$2,'CHECKLIST_EXECUTION',$3,$4,'APPROVED','ok',$7,$7,'COMPLETED')`,
    [randomUUID(), clientA.id, ceEngineeringId, managerUserId, daysAgoIso(2),
     randomUUID(), daysAgoIso(1)],
  );

  return {
    clientAId: clientA.id,
    clientCId: clientC.id,
    buildingAId: buildingA.id,
    buildingBId: buildingB.id,
    buildingCId: buildingC.id,
    clTpl1Id,
    asset1Id: asset1.id,
    fl1Id: fl1.id,
    vendorId: vendor.id,
    vworkId,
    ceEngineeringId,
    ceVendorId,
    ceUnboundId,
    ceTaskBoundId,
    fiMeterId,
    fiLogId,
    fiTaskBoundId,
    ceForbiddenId,
    formTplId,
    formVersionId,
    scheduleId,
  };
}

describe('CR-BE-REPORT-READ-04 PART 01 — Checklist Execution Summary read contract', () => {
  it('1+2. fully-linked CHECKLIST_EXECUTION + FORM_INSTANCE rows expose authoritative fields', async (t) => {
    if (!ready(t)) return;
    const s = await seed();
    const r = await getChecklistExecutionSummary({ buildingId: s.buildingAId }, managerUserId);
    const ce = r.rows.find(x => x.executionId === s.ceEngineeringId);
    assert.ok(ce, 'fully-linked CE must appear');
    assert.equal(ce!.engine, 'CHECKLIST_EXECUTION');
    assert.equal(ce!.status, 'COMPLETED');
    assert.equal(ce!.buildingId, s.buildingAId);
    assert.equal(ce!.assetId, s.asset1Id);
    assert.equal(ce!.functionalLocationId, s.fl1Id);
    assert.equal(ce!.templateId, s.clTpl1Id);
    assert.ok(ce!.templateCode);
    assert.ok(ce!.templateName);
    assert.equal(ce!.templateVersionId, null);
    assert.equal(ce!.templateVersionNumber, null);
    assert.equal(ce!.evidenceCount, 2);
    assert.equal(ce!.findingCount, 2);
    assert.equal(ce!.verificationDecision, 'APPROVED');
    assert.equal(ce!.verificationReviewStatus, 'COMPLETED');
    assert.equal(ce!.verificationReviewerUserId, managerUserId);
    assert.equal(ce!.itemCount, 3);

    const fim = r.rows.find(x => x.executionId === s.fiMeterId);
    assert.ok(fim, 'fully-linked FI (meter) must appear');
    assert.equal(fim!.engine, 'FORM_INSTANCE');
    assert.equal(fim!.templateId, s.formTplId);
    assert.equal(fim!.templateVersionId, s.formVersionId);
    assert.equal(fim!.templateVersionNumber, 1);
    assert.equal(fim!.buildingId, s.buildingAId);
    assert.equal(fim!.assetId, s.asset1Id);
    assert.equal(fim!.functionalLocationId, s.fl1Id);
    assert.equal(fim!.evidenceCount, 1);
    assert.equal(fim!.findingCount, 0);
    assert.equal(fim!.verificationReviewId, null);
    assert.equal(fim!.itemCount, 2);
  });

  it('3/4. engine discriminator verbatim + checklist version fields null / form version fields populated', async (t) => {
    if (!ready(t)) return;
    const s = await seed();
    const r = await getChecklistExecutionSummary({ buildingId: s.buildingAId }, managerUserId);
    for (const row of r.rows) {
      assert.ok(['CHECKLIST_EXECUTION', 'FORM_INSTANCE'].includes(row.engine));
      if (row.engine === 'CHECKLIST_EXECUTION') {
        assert.equal(row.templateVersionId, null);
        assert.equal(row.templateVersionNumber, null);
      } else {
        assert.ok(row.templateVersionId);
        assert.equal(typeof row.templateVersionNumber, 'number');
      }
    }
  });

  it('5. no join fan-out: one row per execution', async (t) => {
    if (!ready(t)) return;
    const s = await seed();
    const r = await getChecklistExecutionSummary({}, managerUserId);
    const ids = r.rows.map(x => `${x.engine}:${x.executionId}`);
    assert.equal(new Set(ids).size, ids.length, 'duplicate rows indicate fan-out');
    // Expected visible: ceEngineering, ceVendor, ceTaskBound, fiMeter, fiLog, fiTaskBound = 6
    assert.ok(r.rows.some(x => x.executionId === s.ceEngineeringId));
    assert.ok(r.rows.some(x => x.executionId === s.ceVendorId));
    assert.ok(r.rows.some(x => x.executionId === s.ceTaskBoundId));
    assert.ok(r.rows.some(x => x.executionId === s.fiMeterId));
    assert.ok(r.rows.some(x => x.executionId === s.fiLogId));
    assert.ok(r.rows.some(x => x.executionId === s.fiTaskBoundId));
    assert.equal(ids.length, 6);
  });

  it('6. building resolution: engineering binding + vendor binding + generated task + meter/log bindings', async (t) => {
    if (!ready(t)) return;
    const s = await seed();
    const r = await getChecklistExecutionSummary({}, managerUserId);
    const find = (id: string) => r.rows.find(x => x.executionId === id)!;
    assert.equal(find(s.ceEngineeringId).buildingId, s.buildingAId);
    assert.equal(find(s.ceVendorId).buildingId, s.buildingAId);
    assert.equal(find(s.ceVendorId).vendorId, s.vendorId);
    assert.equal(find(s.ceTaskBoundId).buildingId, s.buildingAId);
    assert.equal(find(s.fiMeterId).buildingId, s.buildingAId);
    assert.equal(find(s.fiLogId).buildingId, s.buildingAId);
    assert.equal(find(s.fiTaskBoundId).buildingId, s.buildingAId);
  });

  it('7. unresolved-building execution (unbound CE) is excluded', async (t) => {
    if (!ready(t)) return;
    const s = await seed();
    const r = await getChecklistExecutionSummary({}, managerUserId);
    assert.ok(!r.rows.some(x => x.executionId === s.ceUnboundId), 'unbound CE excluded');
  });

  it('8. explicit-building unauthorized access rejected', async (t) => {
    if (!ready(t)) return;
    const s = await seed();
    await assert.rejects(
      () => getChecklistExecutionSummary({ buildingId: s.buildingCId }, managerUserId),
    );
  });

  it('9. accessible-building rollup excludes forbidden Building C', async (t) => {
    if (!ready(t)) return;
    const s = await seed();
    const r = await getChecklistExecutionSummary({}, managerUserId);
    assert.deepEqual([...r.buildingScope].sort(), [s.buildingAId, s.buildingBId].sort());
    assert.ok(!r.rows.some(x => x.executionId === s.ceForbiddenId));
  });

  it('10. empty authorized scope returns empty register', async (t) => {
    if (!ready(t)) return;
    await seed();
    const r = await getChecklistExecutionSummary({}, outsiderUserId);
    assert.deepEqual(r.buildingScope, []);
    assert.deepEqual(r.rows, []);
  });

  it('11. supported filters narrow correctly', async (t) => {
    if (!ready(t)) return;
    const s = await seed();

    const byEngineCE = await getChecklistExecutionSummary({ engine: 'CHECKLIST_EXECUTION' }, managerUserId);
    assert.ok(byEngineCE.rows.every(x => x.engine === 'CHECKLIST_EXECUTION'));

    const byStatus = await getChecklistExecutionSummary({ status: 'COMPLETED' }, managerUserId);
    assert.ok(byStatus.rows.every(x => x.status === 'COMPLETED'));

    const byTpl = await getChecklistExecutionSummary({ templateId: s.clTpl1Id }, managerUserId);
    assert.ok(byTpl.rows.every(x => x.templateId === s.clTpl1Id));

    const byAsset = await getChecklistExecutionSummary({ assetId: s.asset1Id }, managerUserId);
    assert.ok(byAsset.rows.every(x => x.assetId === s.asset1Id));
    assert.ok(byAsset.rows.length >= 2);

    const byFl = await getChecklistExecutionSummary({ functionalLocationId: s.fl1Id }, managerUserId);
    assert.ok(byFl.rows.every(x => x.functionalLocationId === s.fl1Id));

    const byVendor = await getChecklistExecutionSummary({ vendorId: s.vendorId }, managerUserId);
    assert.ok(byVendor.rows.every(x => x.vendorId === s.vendorId));
    assert.equal(byVendor.rows.length, 1);
    assert.equal(byVendor.rows[0].executionId, s.ceVendorId);

    const byDecision = await getChecklistExecutionSummary({ verificationDecision: 'APPROVED' }, managerUserId);
    assert.ok(byDecision.rows.every(x => x.verificationDecision === 'APPROVED'));
    assert.equal(byDecision.rows.length, 1);

    const windowed = await getChecklistExecutionSummary({
      dateFrom: new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10),
      dateTo: new Date(Date.now() - 4 * 86400000).toISOString().slice(0, 10),
    }, managerUserId);
    assert.ok(windowed.rows.some(x => x.executionId === s.ceEngineeringId));
    assert.ok(!windowed.rows.some(x => x.executionId === s.fiTaskBoundId));
  });

  it('12. invalid filter rejection', async (t) => {
    if (!ready(t)) return;
    function mustThrow(q: Record<string, unknown>, label: string) {
      assert.throws(
        () => parseChecklistExecutionSummaryQuery(q),
        (err: unknown) => err instanceof AppError && err.code === 'VALIDATION',
        `expected VALIDATION error for ${label}`,
      );
    }
    mustThrow({ buildingId: 'not-uuid' }, 'bad buildingId');
    mustThrow({ engine: 'BOGUS' }, 'bad engine');
    mustThrow({ status: 'BOGUS' }, 'bad status');
    mustThrow({ verificationDecision: 'BOGUS' }, 'bad decision');
    mustThrow({ dateFrom: 'nope' }, 'bad date');
    mustThrow({ dateFrom: '2025-12-31', dateTo: '2025-01-01' }, 'inverted');
    mustThrow({ dateFrom: '2025-01-01', dateTo: '2030-01-01' }, 'oversized');
    mustThrow({ status: ['DRAFT', 'COMPLETED'] }, 'array');
  });

  it('13. evidenceCount ACTIVE only', async (t) => {
    if (!ready(t)) return;
    const s = await seed();
    const r = await getChecklistExecutionSummary({ buildingId: s.buildingAId }, managerUserId);
    const ce = r.rows.find(x => x.executionId === s.ceEngineeringId)!;
    assert.equal(ce.evidenceCount, 2); // 2 ACTIVE; REMOVED excluded.
  });

  it('14. findingCount total only (no open filter)', async (t) => {
    if (!ready(t)) return;
    const s = await seed();
    const r = await getChecklistExecutionSummary({ buildingId: s.buildingAId }, managerUserId);
    const ce = r.rows.find(x => x.executionId === s.ceEngineeringId)!;
    assert.equal(ce.findingCount, 2); // OPEN + VERIFIED = 2
    assert.equal('openFindingCount' in ce, false);
  });

  it('15. latest COMPLETED verification ordering (APPROVED over older REJECTED)', async (t) => {
    if (!ready(t)) return;
    const s = await seed();
    const r = await getChecklistExecutionSummary({ buildingId: s.buildingAId }, managerUserId);
    const ce = r.rows.find(x => x.executionId === s.ceEngineeringId)!;
    assert.equal(ce.verificationDecision, 'APPROVED');
    assert.equal(ce.verificationReviewStatus, 'COMPLETED');
    assert.ok(ce.verificationReviewId);
  });

  it('16. no executor/result/rework/history derived fields present', async (t) => {
    if (!ready(t)) return;
    const s = await seed();
    const r = await getChecklistExecutionSummary({ buildingId: s.buildingAId }, managerUserId);
    const ce = r.rows.find(x => x.executionId === s.ceEngineeringId)!;
    for (const forbidden of [
      'executedByUserId', 'workforceProfileId', 'teamId', 'executorVendorId', 'assignedAt',
      'answeredCount', 'passCount', 'failCount', 'abnormalCount', 'resultSummary',
      'reworkCount', 'currentReworkStatus',
      'historyCount', 'historyAvailable',
      'executionNumber', 'submittedAt', 'domain', 'reportFamily',
      'floorId', 'areaId', 'roomId', 'spaceId', 'tenantId',
    ]) {
      assert.ok(!(forbidden in ce), `${forbidden} must NOT be projected`);
    }
  });
});
