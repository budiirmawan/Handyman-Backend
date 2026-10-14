import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import { closePool, getPool, initDatabase, migrateUp } from '../src/database';
import { buildingAssignmentService } from '../src/modules/building-assignments';
import { buildingService } from '../src/modules/buildings';
import {
  getHandymanQcRunDetail,
  listHandymanDefectsByScope,
  openHandymanDefect,
  openHandymanQcRun,
  setHandymanQcRunItemOutcome,
} from '../src/modules/handyman-evidence-qc';
import { handymanDisciplineRepository } from '../src/modules/handyman-disciplines';
import { permissionService } from '../src/modules/permissions';
import { roleService } from '../src/modules/roles';
import { assignHandymanExecutionScopeCrew } from '../src/modules/handyman-scope-assignments';
import { userService } from '../src/modules/users';
import { workforceService } from '../src/modules/workforce';
import { assignSupervisor } from '../src/modules/workforce-reporting-lines';
import { workforceBuildingAssignmentService } from '../src/modules/workforce-building-assignments';
import { createAdminUser } from './helpers/access';
import { baseFixture, crewFixture, initHandymanFixtures } from './helpers/handyman-fixtures';

let pg: EmbeddedPostgres;
let dir: string;
let adminId: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hm-qc-authority-'));
  const port = 54000 + Math.floor(Math.random() * 1000);
  pg = new EmbeddedPostgres({ databaseDir: dir, port, user: 'postgres',
    password: 'password', persistent: false });
  await pg.initialise();
  await pg.start();
  const pool = await initDatabase({ host: '127.0.0.1', port,
    name: 'postgres', user: 'postgres', password: 'password',
    ssl: false, poolMin: 1, poolMax: 16 });
  await migrateUp(pool);
  adminId = (await createAdminUser()).userId;
  const discipline = await handymanDisciplineRepository.findDisciplineByCode(
    undefined, 'GENERAL_HANDYMAN');
  if (!discipline) throw new Error('Missing GENERAL_HANDYMAN discipline');
  initHandymanFixtures({ adminUserId: adminId, disciplineId: discipline.id,
    query: (sql, params) => pool.query(sql, params) });
});

after(async () => {
  await closePool(getPool()).catch(() => undefined);
  if (pg) await pg.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const key = () => `qc-${randomUUID()}`;
const code = (error: unknown) => (error as { code?: string }).code;

async function grant(userId: string, permissionCodes: string[]) {
  const role = await roleService.createRole({
    code: `QC_${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Scoped QC test role',
  });
  for (const permissionCode of permissionCodes) {
    const permission = await permissionService.createPermission({
      code: permissionCode,
      name: `Scoped ${permissionCode}`,
    }).catch(async () => {
      const { permissionRepository } = await import('../src/modules/permissions');
      return permissionRepository.findByCode(permissionCode);
    });
    if (!permission) throw new Error(`Permission missing: ${permissionCode}`);
    await permissionService.assignPermissionToRole(role.id, permission.id);
  }
  await roleService.assignRoleToUser(userId, role.id);
}

async function fixture() {
  const f = await baseFixture();
  const crew = await crewFixture(f.realm);
  await workforceBuildingAssignmentService.assignBuildingToWorkforce({
    workforceProfileId: crew.workerContext.workforceProfileId,
    buildingId: f.realm.building.id,
  });
  await assignHandymanExecutionScopeCrew({ executionScopeId: f.scope.id,
    providerContextId: crew.providerContext.id, crewId: crew.crew.id }, adminId);
  const supervisor = await userService.createUser({
    email: `supervisor-${randomUUID()}@example.com`,
    displayName: 'Assigned Supervisor',
  });
  const supProfile = await workforceService.createWorkforceProfile({
    organizationId: f.realm.organization.id,
    departmentId: f.realm.department.id,
    positionId: f.realm.position.id,
    employeeCode: `SUP_${randomUUID().slice(0, 8)}`,
    fullName: 'Assigned Supervisor',
    userId: supervisor.id,
  });
  await assignSupervisor({
    workforceProfileId: crew.workerContext.workforceProfileId,
    supervisorWorkforceProfileId: supProfile.id,
  });
  await buildingAssignmentService.createAssignment(supervisor.id, {
    buildingId: f.realm.building.id,
  });
  await grant(supervisor.id, ['handyman.qc.manage']);
  return { ...f, crew, supervisor, supProfile };
}

const open = (scopeId: string) => ({ executionScopeId: scopeId,
  checklistIdentity: 'handyman-final-v1', idempotencyKey: key() });

describe('Supervisor QC is distinct from execution and inspection', () => {
  it('permits assigned supervisor and PIC reads, but denies PIC self-QC', async () => {
    const f = await fixture();
    const run = await openHandymanQcRun(open(f.scope.id), f.supervisor.id);
    assert.equal(run.run.status, 'OPEN');
    await assert.rejects(
      openHandymanQcRun(open(f.scope.id), f.crew.leadUser.id),
      (e) => code(e) === 'HANDYMAN_QC_NOT_AUTHORIZED');
    await assert.rejects(
      setHandymanQcRunItemOutcome({ qcRunId: run.run.id,
        itemKey: 'quality', outcome: 'PASS', idempotencyKey: key() },
      f.crew.leadUser.id),
      (e) => code(e) === 'HANDYMAN_QC_NOT_AUTHORIZED');
    await setHandymanQcRunItemOutcome({ qcRunId: run.run.id,
      itemKey: 'quality', outcome: 'DEFECT', idempotencyKey: key() },
      f.supervisor.id);
    const defect = await openHandymanDefect({ executionScopeId: f.scope.id,
      runId: run.run.id, description: 'Repair required',
      idempotencyKey: key() }, f.supervisor.id);
    assert.equal(defect.defect.status, 'OPENED');
    assert.equal((await getHandymanQcRunDetail(run.run.id,
      f.crew.leadUser.id)).items[0].outcome, 'DEFECT');
    assert.equal((await listHandymanDefectsByScope(f.scope.id,
      f.crew.leadUser.id)).length, 1);
    await assert.rejects(openHandymanDefect({ executionScopeId: f.scope.id,
      description: 'Self-verification', idempotencyKey: key() },
    f.crew.leadUser.id), (e) => code(e) === 'HANDYMAN_DEFECT_NOT_AUTHORIZED');
  });

  it('denies inspector, broad Operations permission, and unassigned supervisor', async () => {
    const f = await fixture();
    const inspector = await userService.createUser({
      email: `inspector-${randomUUID()}@example.com`,
      displayName: 'Inspector only',
    });
    await buildingAssignmentService.createAssignment(inspector.id, {
      buildingId: f.realm.building.id,
    });
    await grant(inspector.id, ['tenant_company.manage']);
    await assert.rejects(openHandymanQcRun(open(f.scope.id), inspector.id),
      (e) => code(e) === 'HANDYMAN_QC_NOT_AUTHORIZED');
    await assert.rejects(openHandymanQcRun(open(f.scope.id), adminId),
      (e) => code(e) === 'HANDYMAN_QC_NOT_AUTHORIZED');

    // Explicit permission alone cannot replace a current reporting line.
    await getPool().query(`UPDATE workforce_reporting_lines
      SET status = 'INACTIVE' WHERE supervisor_workforce_profile_id = $1`,
    [f.supProfile.id]);
    await assert.rejects(openHandymanQcRun(open(f.scope.id), f.supervisor.id),
      (e) => code(e) === 'HANDYMAN_QC_NOT_AUTHORIZED');
  });

  it('rejects same-Client sibling and foreign-Client buildings before QC', async () => {
    const f = await fixture();
    const sibling = await buildingService.createBuilding({
      propertyId: f.realm.property.id, code: `OTHER_${randomUUID().slice(0, 8)}`,
      name: 'Other Building',
    });
    await getPool().query(`UPDATE user_building_assignments
      SET status = 'INACTIVE' WHERE user_id = $1`, [f.supervisor.id]);
    await buildingAssignmentService.createAssignment(f.supervisor.id, {
      buildingId: sibling.id,
    });
    await assert.rejects(openHandymanQcRun(open(f.scope.id), f.supervisor.id),
      (e) => code(e) === 'BUILDING_ACCESS_DENIED');
    const other = await fixture();
    await assert.rejects(openHandymanQcRun(open(other.scope.id), f.supervisor.id),
      (e) => code(e) === 'BUILDING_ACCESS_DENIED');
    await assert.rejects(listHandymanDefectsByScope(other.scope.id,
      f.crew.leadUser.id), (e) => code(e) === 'BUILDING_ACCESS_DENIED');
  });
});
