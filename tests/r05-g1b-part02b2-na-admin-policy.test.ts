/**
 * R05-G1B PART 02B2 — Checklist Item N/A Policy Administration (static).
 *
 * Source-level assertions over types/validation/repository/service/OpenAPI.
 * Live-DB create/update/read persistence remains CI-required.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const TYPES = 'src/modules/checklist-administration/checklist-administration.types.ts';
const VALID = 'src/modules/checklist-administration/checklist-administration.validation.ts';
const REPO = 'src/modules/checklist-administration/checklist-administration.repository.ts';
const SVC = 'src/modules/checklist-administration/checklist-administration.service.ts';
const OAPI = 'docs/api/openapi.yaml';

describe('R05-G1B PART 02B2 N/A policy administration (static)', () => {
  const types = readFileSync(TYPES, 'utf8');
  const valid = readFileSync(VALID, 'utf8');
  const repo = readFileSync(REPO, 'utf8');
  const svc = readFileSync(SVC, 'utf8');
  const oapi = readFileSync(OAPI, 'utf8');

  it('AdminChecklistItem read shape includes isNaAllowed and naRequiresNote booleans', () => {
    assert.match(types, /isNaAllowed:boolean/);
    assert.match(types, /naRequiresNote:boolean/);
  });

  it('create DTO includes isNaAllowed/naRequiresNote booleans', () => {
    assert.match(types, /CreateChecklistItemInput=\{[^}]*isNaAllowed:boolean[^}]*naRequiresNote:boolean[^}]*\}/);
  });

  it('update DTO includes optional isNaAllowed?/naRequiresNote?', () => {
    assert.match(types, /UpdateChecklistItemInput=\{[^}]*isNaAllowed\?:boolean[^}]*naRequiresNote\?:boolean[^}]*\}/);
  });

  it('create parser accepts isNaAllowed/naRequiresNote in allowlist and validates booleans + combo', () => {
    assert.match(valid, /unknown\(b,\['code','label','itemType','required','displayOrder','status','isNaAllowed','naRequiresNote','options'\]/);
    assert.match(valid, /boolField\(b\.isNaAllowed,'isNaAllowed',d,false\)/);
    assert.match(valid, /boolField\(b\.naRequiresNote,'naRequiresNote',d,false\)/);
    assert.match(valid, /naRequiresNote===true&&isNaAllowed!==true[\s\S]*naRequiresNote requires isNaAllowed=true/);
  });

  it('update parser accepts isNaAllowed/naRequiresNote in allowlist and validates boolean types', () => {
    assert.match(valid, /unknown\(b,\['label','itemType','required','displayOrder','status','isNaAllowed','naRequiresNote'\]/);
    assert.match(valid, /isNaAllowed!==undefined&&typeof isNaAllowed!=='boolean'[\s\S]*isNaAllowed must be boolean/);
    assert.match(valid, /naRequiresNote!==undefined&&typeof naRequiresNote!=='boolean'[\s\S]*naRequiresNote must be boolean/);
    // update parser does NOT silently auto-clear naRequiresNote (no defaulting or stripping)
    assert.doesNotMatch(valid, /naRequiresNote\s*=\s*false/);
  });

  it('repository SELECT I maps is_na_allowed / na_requires_note columns', () => {
    assert.match(repo, /is_na_allowed AS "isNaAllowed"/);
    assert.match(repo, /na_requires_note AS "naRequiresNote"/);
  });

  it('repository createItem writes is_na_allowed and na_requires_note', () => {
    assert.match(repo, /INSERT INTO checklist_items[\s\S]*is_na_allowed,na_requires_note[\s\S]*\$9,\$10/);
    assert.match(repo, /i\.isNaAllowed,i\.naRequiresNote/);
  });

  it('repository updateItem whitelists is_na_allowed and na_requires_note', () => {
    assert.match(repo, /\['isNaAllowed','is_na_allowed'\]/);
    assert.match(repo, /\['naRequiresNote','na_requires_note'\]/);
  });

  it('service enforces effective-state policy on update (does not auto-clear)', () => {
    // Reads existing row, computes effective, rejects invalid combo.
    assert.match(svc, /const existing=await scopedItem\(id,u\)/);
    assert.match(svc, /effIsNaAllowed=i\.isNaAllowed!==undefined\?i\.isNaAllowed:existing\.isNaAllowed/);
    assert.match(svc, /effNaRequiresNote=i\.naRequiresNote!==undefined\?i\.naRequiresNote:existing\.naRequiresNote/);
    assert.match(svc, /effNaRequiresNote===true&&effIsNaAllowed!==true/);
    assert.match(svc, /naRequiresNote requires isNaAllowed=true/);
    // No automatic clearing.
    assert.doesNotMatch(svc, /naRequiresNote\s*=\s*false/);
    assert.doesNotMatch(svc, /i\.naRequiresNote\s*=\s*/);
  });

  it('admin module never references checklist_item_responses or response-state columns', () => {
    // PART 02B2 confined to admin item-policy (is_na_allowed / na_requires_note
    // on checklist_items); it must not touch response-state columns.
    for (const f of [repo, svc, valid, types]) {
      assert.doesNotMatch(f, /checklist_item_responses/);
      assert.doesNotMatch(f, /\bis_na\b/);        // response-state column only
      assert.doesNotMatch(f, /\bna_notes\b/);    // response-state column only
      // isNaAllowed / naRequiresNote (item policy) ARE expected to appear.
    }
  });

  it('admin read DTOs carry no response-state fields (is_na/na_notes are execution-only)', () => {
    // AdminChecklistItem exposes policy (isNaAllowed, naRequiresNote) only —
    // NOT execution-state (isNa, naNotes).
    assert.doesNotMatch(types, /isNa:boolean/);
    assert.doesNotMatch(types, /naNotes/);
  });

  it('OpenAPI AdminChecklistItem exposes both fields', () => {
    // locate AdminChecklistItem section
    const m = oapi.match(/    AdminChecklistItem:\n([\s\S]*?)\n    AdminChecklistItemOption:/);
    assert.ok(m, 'AdminChecklistItem schema block not found');
    const block = m[0];
    assert.match(block, /isNaAllowed:\s*\{\s*type:\s*boolean/);
    assert.match(block, /naRequiresNote:\s*\{\s*type:\s*boolean/);
  });

  it('OpenAPI CreateAdminChecklistItemRequest exposes both fields with defaults', () => {
    const m = oapi.match(/    CreateAdminChecklistItemRequest:\n([\s\S]*?)\n    UpdateAdminChecklistItemRequest:/);
    assert.ok(m, 'CreateAdminChecklistItemRequest schema block not found');
    const block = m[0];
    assert.match(block, /isNaAllowed:\s*\{\s*type:\s*boolean[^}]*default:\s*false/);
    assert.match(block, /naRequiresNote:\s*\{\s*type:\s*boolean[^}]*default:\s*false/);
  });

  it('OpenAPI UpdateAdminChecklistItemRequest exposes both optional fields', () => {
    const m = oapi.match(/    UpdateAdminChecklistItemRequest:\n([\s\S]*?)\n\n    OperationalSettingKey:/);
    assert.ok(m, 'UpdateAdminChecklistItemRequest schema block not found');
    const block = m[0];
    assert.match(block, /isNaAllowed:\s*\{\s*type:\s*boolean/);
    assert.match(block, /naRequiresNote:\s*\{\s*type:\s*boolean/);
    // Admin request schemas never reference response-side isNa/naNotes
    // (those are an execution concern).
    assert.doesNotMatch(block, /\bisNa\b/);
    assert.doesNotMatch(block, /\bnaNotes\b/);
  });

  it('no semantic fields (pass/fail/compliant/score/finding/evaluation) introduced in admin contracts', () => {
    const combined = types + valid + repo + svc;
    for (const forbidden of ['isPass','isFail','isCompliant','isAbnormal',
      'semanticCategory','evaluationPolicy','scorePolicy',
      'findingPolicy','evidencePolicy','resultEvaluation','compliant']) {
      assert.ok(!new RegExp('\\b'+forbidden+'\\b','i').test(combined),
        `unexpected semantic field ${forbidden}`);
    }
  });
});
