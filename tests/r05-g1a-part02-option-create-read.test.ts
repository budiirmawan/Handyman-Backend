/**
 * R05-G1A PART 02 — Checklist fixed-option CREATE + READ authority.
 *
 * Static contract/parser tests (no PostgreSQL required). Live DB
 * creation/atomicity cases run in CI via the embedded-postgres
 * checklist-administration suite.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { AppError } from '../src/shared/errors';
import { parseCreateChecklistItem } from '../src/modules/checklist-administration/checklist-administration.validation';

const SPEC = parse(readFileSync('docs/api/openapi.yaml', 'utf8'));

describe('R05-G1A PART 02 create/read authority', () => {
  it('parses SELECT item creation with multiple options and normalizes codes uppercase', () => {
    const out = parseCreateChecklistItem({
      code: 'clr_01',
      label: 'Cleanliness',
      itemType: 'SELECT',
      required: true,
      displayOrder: 3,
      status: 'ACTIVE',
      options: [
        { code: 'b', label: 'Baik', displayOrder: 0 },
        { code: 'k', label: 'Kurang', displayOrder: 10 },
        { code: 'r', label: 'Rusak', displayOrder: 20 },
      ],
    });
    assert.equal(out.itemType, 'SELECT');
    assert.equal(out.options.length, 3);
    assert.deepEqual(out.options.map(o => o.code), ['B', 'K', 'R']);
    assert.deepEqual(out.options.map(o => o.displayOrder), [0, 10, 20]);
  });

  it('SELECT without options is rejected', () => {
    assert.throws(() => parseCreateChecklistItem({
      code: 'clr_02', label: 'X', itemType: 'SELECT',
      required: false, displayOrder: 1, status: 'ACTIVE',
    }), (e:any)=>e instanceof AppError);
  });

  it('SELECT with empty options is rejected', () => {
    assert.throws(() => parseCreateChecklistItem({
      code: 'clr_03', label: 'X', itemType: 'SELECT',
      required: false, displayOrder: 1, status: 'ACTIVE', options: [],
    }), (e:any)=>e instanceof AppError);
  });

  it('non-SELECT with options is rejected', () => {
    for (const t of ['CHECK','BOOLEAN','TEXT','NUMBER'] as const) {
      assert.throws(() => parseCreateChecklistItem({
        code: `x_${t}`, label: 'X', itemType: t,
        required: false, displayOrder: 0, status: 'ACTIVE',
        options: [{ code: 'A', label: 'Aye', displayOrder: 0 }],
      }), (e:any)=>e instanceof AppError, `type ${t} should reject options`);
    }
  });

  it('rejects duplicate option codes (case-insensitive, normalized)', () => {
    assert.throws(() => parseCreateChecklistItem({
      code: 'dup', label: 'D', itemType: 'SELECT',
      required: false, displayOrder: 0, status: 'ACTIVE',
      options: [
        { code: 'ok', label: 'OK', displayOrder: 0 },
        { code: 'OK', label: 'OK 2', displayOrder: 10 },
      ],
    }), (e:any)=>e instanceof AppError);
  });

  it('rejects invalid option code/label/displayOrder', () => {
    const bad = [
      { code: '', label: 'x', displayOrder: 0 },
      { code: 'bad code', label: 'x', displayOrder: 0 },
      { code: 'A', label: '', displayOrder: 0 },
      { code: 'A', label: 'x', displayOrder: -1 },
      { code: 'A', label: 'x', displayOrder: 1.5 },
    ];
    for (const opt of bad) {
      assert.throws(() => parseCreateChecklistItem({
        code: 'inv', label: 'X', itemType: 'SELECT', required: false,
        displayOrder: 0, status: 'ACTIVE', options: [opt],
      }), (e:any)=>e instanceof AppError, JSON.stringify(opt));
    }
  });

  it('non-SELECT items parse with empty options array default (API contract)', () => {
    const out = parseCreateChecklistItem({
      code: 'it_num', label: 'N', itemType: 'NUMBER',
      required: false, displayOrder: 0, status: 'ACTIVE',
    });
    assert.equal(out.itemType, 'NUMBER');
    assert.deepEqual(out.options, []);
  });

  it('OpenAPI defines AdminChecklistItemOption and CreateAdminChecklistItemOption schemas with no semantic fields', () => {
    const schemas = SPEC.components.schemas;
    assert.ok(schemas.AdminChecklistItemOption, 'AdminChecklistItemOption missing');
    assert.ok(schemas.CreateAdminChecklistItemOption, 'CreateAdminChecklistItemOption missing');
    assert.deepEqual(
      Object.keys(schemas.AdminChecklistItemOption.properties).sort(),
      ['checklistItemId','code','createdAt','displayOrder','id','label','status','updatedAt'],
    );
    assert.deepEqual(
      Object.keys(schemas.CreateAdminChecklistItemOption.properties).sort(),
      ['code','displayOrder','label'],
    );
    for (const forbidden of ['semanticCategory','evaluation','isPass','isFail',
      'isCompliant','isAbnormal','findingPolicy','evidencePolicy','score','color','icon']) {
      assert.ok(
        !schemas.AdminChecklistItemOption.properties[forbidden]
          && !schemas.CreateAdminChecklistItemOption.properties[forbidden],
        `forbidden field on option schema: ${forbidden}`,
      );
    }
  });

  it('OpenAPI AdminChecklistItem exposes options array; CreateAdminChecklistItemRequest accepts options', () => {
    const ai = SPEC.components.schemas.AdminChecklistItem;
    assert.ok(ai.properties.options, 'AdminChecklistItem.options missing');
    assert.equal(ai.properties.options.type, 'array');
    assert.ok(ai.properties.options.items.$ref?.endsWith('/AdminChecklistItemOption'));
    const cr = SPEC.components.schemas.CreateAdminChecklistItemRequest;
    assert.ok(cr.properties.options, 'CreateAdminChecklistItemRequest.options missing');
    assert.ok(cr.properties.options.items.$ref?.endsWith('/CreateAdminChecklistItemOption'));
  });

  it('OpenAPI does NOT expose DELETE on item-options; PATCH for option update is defined in PART 03', () => {
    // In PART 02 we only verify that no premature DELETE exists. PATCH endpoint
    // is added in PART 03 and tested there.
    for (const [p, methods] of Object.entries(SPEC.paths) as any) {
      if (/item-options/.test(p)) {
        assert.equal((methods as any).delete, undefined, `unexpected DELETE on ${p}`);
      }
    }
  });
});
