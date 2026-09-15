/**
 * R05-G1A PART 03 — Checklist option update + deactivation authority.
 *
 * Static/parser/OpenAPI tests (no PostgreSQL required). DB-scoped auth
 * and mutation-rollback cases run in CI.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { AppError } from '../src/shared/errors';
import { parseUpdateChecklistItemOption } from '../src/modules/checklist-administration/checklist-administration.validation';
import { checklistAdministrationRepository as repo } from '../src/modules/checklist-administration/checklist-administration.repository';
import { checklistAdministrationService as svc } from '../src/modules/checklist-administration/checklist-administration.service';

const SPEC = parse(readFileSync('docs/api/openapi.yaml', 'utf8'));

describe('R05-G1A PART 03 update + deactivation', () => {
  it('parser accepts label-only update', () => {
    const r = parseUpdateChecklistItemOption({ label: 'Baik (edited)' });
    assert.equal(r.label, 'Baik (edited)');
    assert.equal(r.displayOrder, undefined);
    assert.equal(r.status, undefined);
  });
  it('parser accepts displayOrder-only update', () => {
    const r = parseUpdateChecklistItemOption({ displayOrder: 5 });
    assert.equal(r.displayOrder, 5);
  });
  it('parser accepts ACTIVE -> INACTIVE and INACTIVE -> ACTIVE', () => {
    assert.equal(parseUpdateChecklistItemOption({ status: 'INACTIVE' }).status, 'INACTIVE');
    assert.equal(parseUpdateChecklistItemOption({ status: 'ACTIVE' }).status, 'ACTIVE');
  });
  it('parser rejects empty payload', () => {
    assert.throws(() => parseUpdateChecklistItemOption({}), (e:any)=>e instanceof AppError);
  });
  it('parser rejects code / checklistItemId / id / timestamps / semantic fields', () => {
    for (const bad of ['code','checklistItemId','id','createdAt','updatedAt','semanticCategory','evaluation','isPass','isFail','score','isNa']) {
      assert.throws(() => parseUpdateChecklistItemOption({ [bad]: 'X', label: 'y' }),
        (e:any)=>e instanceof AppError, `field ${bad} should be rejected`);
    }
  });
  it('parser rejects invalid status, displayOrder, label', () => {
    assert.throws(()=>parseUpdateChecklistItemOption({status:'FAIL'}), (e:any)=>e instanceof AppError);
    assert.throws(()=>parseUpdateChecklistItemOption({displayOrder:-1}), (e:any)=>e instanceof AppError);
    assert.throws(()=>parseUpdateChecklistItemOption({displayOrder:1.5}), (e:any)=>e instanceof AppError);
    assert.throws(()=>parseUpdateChecklistItemOption({label:''}), (e:any)=>e instanceof AppError);
  });
  it('repository exposes findItemOption + updateItemOption; no delete method exists', () => {
    assert.equal(typeof repo.findItemOption, 'function');
    assert.equal(typeof repo.updateItemOption, 'function');
    assert.equal((repo as any).deleteItemOption, undefined);
  });
  it('service exposes updateChecklistItemOption; no delete service exists', () => {
    assert.equal(typeof svc.updateChecklistItemOption, 'function');
    assert.equal((svc as any).deleteChecklistItemOption, undefined);
  });
  it('OpenAPI defines UpdateAdminChecklistItemOptionRequest WITHOUT code and PATCH item-options path; no DELETE', () => {
    const req = SPEC.components.schemas.UpdateAdminChecklistItemOptionRequest;
    assert.ok(req, 'UpdateAdminChecklistItemOptionRequest missing');
    assert.deepEqual(Object.keys(req.properties).sort(), ['displayOrder','label','status']);
    assert.equal(req.properties.code, undefined);
    const patch = SPEC.paths['/checklist-administration/item-options/{checklistItemOptionId}'];
    assert.ok(patch, 'PATCH path missing');
    assert.ok(patch.patch, 'patch verb missing');
    assert.equal(patch.delete, undefined);
    assert.equal(patch.post, undefined);
    assert.ok(SPEC.components.parameters.ChecklistItemOptionIdPath);
    assert.equal(patch.patch.operationId, 'updateAdminChecklistItemOption');
  });
});
