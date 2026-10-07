/**
 * R05-G1B PART 02C — Execution N/A write authority + transitions (static).
 *
 * Source-level assertions over saveChecklistResponses. Live-DB
 * persistence, ACTIVE/INACTIVE SELECT enforcement, N/A row state, and
 * na_requires_note gating remain CI-required.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const SVC = 'src/modules/checklist-executions/checklist-execution.service.ts';
const ROUTES = 'src/modules/checklist-executions/checklist-execution.routes.ts';
const OAPI = 'docs/api/openapi.yaml';

describe('R05-G1B PART 02C N/A execution authority (static)', () => {
  const svc = readFileSync(SVC, 'utf8');
  const oapi = readFileSync(OAPI, 'utf8');

  it('item policy query fetches is_na_allowed and na_requires_note', () => {
    assert.match(svc, /SELECT id, item_type, is_na_allowed, na_requires_note[\s\S]*FROM checklist_items/);
  });

  it('isNa is strictly validated as boolean (presence-based, no truthy coercion)', () => {
    assert.match(svc, /function parseIsNa/);
    // Presence check uses hasOwnProperty, not truthiness.
    assert.match(svc, /hasOwnProperty\.call\(entry, 'isNa'\)/);
    // Absent → default false (no fall-through to rejection).
    assert.match(svc, /if \(!Object\.prototype\.hasOwnProperty\.call\(entry, 'isNa'\)\) return false;/);
    // Present non-boolean → rejection (including explicit null).
    assert.match(svc, /typeof v !== 'boolean'/);
    assert.match(svc, /isNa must be a boolean/);
    // No v==null → default, no Number/!!/Boolean coercion.
    assert.doesNotMatch(svc, /v === null \?\? false|v == null/);
    assert.doesNotMatch(svc, /!!\s*v/);
    assert.doesNotMatch(svc, /Boolean\(v\)/);
    assert.doesNotMatch(svc, /\+v/);
  });

  it('naNotes is validated as optional nullable string trimmed, <=2048 chars', () => {
    assert.match(svc, /function parseNaNotes/);
    assert.match(svc, /typeof v !== 'string'/);
    assert.match(svc, /trimmed\.length > 2048/);
  });

  it('N/A rejected when item policy disallows it (is_na_allowed=false)', () => {
    assert.match(svc, /if \(!itemRow\.is_na_allowed\)[\s\S]*N\/A is not allowed for this item\./);
  });

  it('N/A value exclusivity: non-null value rejected', () => {
    assert.match(svc, /entry\.value !== undefined && entry\.value !== null[\s\S]*N\/A responses must not include a value\./);
  });

  it('N/A result exclusivity: non-null result rejected', () => {
    assert.match(svc, /entry\.result !== undefined && entry\.result !== null[\s\S]*N\/A responses must not include a result\./);
  });

  it('na_requires_note enforcement: missing/blank reason rejected', () => {
    assert.match(svc, /requireNote && !\(preserved && preserved\.trim\(\)\.length > 0\)[\s\S]*naNotes is required/);
    assert.match(svc, /requireNote && !\(parsed && parsed\.length > 0\)[\s\S]*naNotes is required/);
    // general `notes` cannot satisfy the policy (policy checks `preserved`
    // derived ONLY from existing na_notes / incoming naNotes).
    assert.doesNotMatch(svc, /entry\.notes.*naNotes is required|notes.*naRequiresNote/);
  });

  it('N/A write uses SQL NULL (no JSON.stringify) for value and result, sets is_na=true', () => {
    // R06 PART 03B appends the latest-response-writer actor as the trailing
    // bind parameter; the R05 N/A invariants (SQL NULL value/result, is_na
    // literal true, na_notes last-before-actor) are unchanged.
    assert.match(svc, /INSERT INTO checklist_item_responses[\s\S]*VALUES \(\$1,\s*\$2,\s*\$3,\s*NULL,\s*NULL,\s*\$4,\s*true,\s*\$5(,\s*\$6)?\)/);
    // On conflict DO UPDATE also sets value=NULL, result=NULL, is_na=true
    assert.match(svc, /DO UPDATE SET value = NULL, result = NULL,[\s\S]*is_na = true, na_notes = EXCLUDED\.na_notes/);
  });

  it('SELECT N/A bypasses membership (no checklist_item_options reference in N/A branch)', () => {
    // Locate the N/A branch block by "EXPLICIT N/A RESPONSE PATH" and confirm
    // it never references checklist_item_options.
    const naBlock = svc.split('===== EXPLICIT N/A RESPONSE PATH =====')[1]?.split('=====')[0];
    assert.ok(naBlock, 'N/A branch not found');
    assert.doesNotMatch(naBlock, /checklist_item_options/);
    assert.doesNotMatch(naBlock, /WHERE EXISTS/);
  });

  it('normal SELECT preserves atomic WHERE EXISTS membership against ACTIVE option', () => {
    // SELECT normal block (in the isNa=false branch) still contains the
    // atomic INSERT...SELECT...WHERE EXISTS.
    const normalBlock = svc.split('===== NORMAL RESPONSE PATH =====')[1]?.split('===== EXPLICIT N/A')[0];
    assert.ok(normalBlock, 'normal branch not found');
    assert.match(normalBlock, /WHERE EXISTS/);
    assert.match(normalBlock, /FROM checklist_item_options/);
    assert.match(normalBlock, /code = \$7/);
    assert.match(normalBlock, /status = 'ACTIVE'/);
    assert.match(normalBlock, /Selected option is not valid for this item\./);
    assert.match(normalBlock, /normalizeOptionCode/);
    // normal path writes is_na=false and na_notes=NULL
    assert.match(normalBlock, /is_na = false, na_notes = NULL/);
  });

  it('normal non-SELECT path writes is_na=false, na_notes=NULL and JSON-stringifies value', () => {
    const nonSelect = svc.split('} else {')[1]?.split('===== EXPLICIT N/A')[0];
    assert.ok(nonSelect, 'non-SELECT else block not found');
    assert.match(nonSelect, /is_na, na_notes/);
    assert.match(nonSelect, /false, NULL/);
    assert.match(nonSelect, /is_na = false, na_notes = NULL/);
    assert.match(nonSelect, /JSON\.stringify\(entry\.value\)/);
  });

  it('NORMAL → N/A transition explicitly clears value/result and sets na_notes (no stale state)', () => {
    // On conflict for N/A path: value=NULL,result=NULL,is_na=true,na_notes=EXCLUDED.na_notes
    const naBranch = svc.split('===== EXPLICIT N/A RESPONSE PATH =====')[1];
    assert.match(naBranch, /DO UPDATE SET value = NULL, result = NULL/);
    assert.match(naBranch, /is_na = true, na_notes = EXCLUDED\.na_notes/);
  });

  it('N/A → NORMAL transition explicitly clears na_notes (normal path sets na_notes=NULL)', () => {
    // Normal branches (both SELECT and non-SELECT) set is_na=false,na_notes=NULL
    const normalBlock = svc.split('===== NORMAL RESPONSE PATH =====')[1]?.split('===== EXPLICIT N/A')[0] ?? '';
    const occurrences = normalBlock.match(/na_notes = NULL/g);
    assert.ok(occurrences && occurrences.length >= 2, 'both normal branches must clear na_notes');
  });

  it('N/A → N/A preserves existing na_notes when incoming naNotes omitted (if previously N/A)', () => {
    assert.match(svc, /SELECT is_na, na_notes FROM checklist_item_responses/);
    assert.match(svc, /prev\.rows\[0\]\.is_na[\s\S]*existingNaNotes = prev\.rows\[0\]\.na_notes/);
    // normalizeNaNotesForWrite preserves existing when incoming undefined
    assert.match(svc, /if \(incoming === undefined\)/);
    assert.match(svc, /const preserved = existing \?\? null/);
  });

  it('completion SQL is NOT modified (row-existence rule unchanged)', () => {
    assert.match(svc, /LEFT JOIN checklist_item_responses r[\s\S]*i\.required AND r\.id IS NULL/);
    // Exactly one occurrence of that LEFT JOIN pattern.
    const matches = svc.match(/LEFT JOIN checklist_item_responses/g);
    assert.equal(matches?.length ?? 0, 1);
  });

  it('no magic-string / null reinterpretation (no scanning for "NA"/"N/A"/"-"/null-as-na)', () => {
    for (const lit of ["'NA'", "'N/A'", "'NOT_APPLICABLE'", "'-'", '"NA"', '"N/A"']) {
      assert.ok(!svc.includes(lit), `unexpected magic literal ${lit}`);
    }
    assert.doesNotMatch(svc, /value\s+IS\s+NULL\s+AND\s+is_na/);
  });

  it('no semantic evaluation / auto-Finding / score / PASS / FAIL', () => {
    for (const forbidden of ['isPass','isFail','PASS','FAIL','isCompliant','semanticCategory',
      'createFinding','evaluation','score','riskLevel','findingPolicy','evidencePolicy']) {
      assert.ok(!new RegExp('\\b'+forbidden+'\\b').test(svc), `unexpected token ${forbidden}`);
    }
  });

  it('no broad transaction wrapping introduced (preserves per-item partial-write semantics)', () => {
    assert.doesNotMatch(svc, /BEGIN|COMMIT|ROLLBACK|PoolClient|connect\(\)/);
  });

  it('OpenAPI ChecklistResponsesRequest exposes isNa (boolean, default false) and naNotes (nullable, maxLength 2048)', () => {
    const m = oapi.match(/    ChecklistResponsesRequest:\n([\s\S]*?)\n    ChecklistTemplate:/);
    assert.ok(m);
    const block = m[0];
    assert.match(block, /isNa:\s*\n\s*type:\s*boolean[\s\S]*?default:\s*false/);
    assert.match(block, /naNotes:\s*\n\s*type:\s*string[\s\S]*?nullable:\s*true[\s\S]*?maxLength:\s*2048/);
  });

  it('OpenAPI ChecklistItemResponse exposes is_na and na_notes', () => {
    const idx = oapi.indexOf('ChecklistItemResponse:');
    assert.ok(idx >= 0);
    const block = oapi.slice(idx, idx + 1500);
    assert.match(block, /is_na:\s*\n\s*type:\s*boolean/);
    assert.match(block, /na_notes:\s*\n\s*type:\s*string[\s\S]*?nullable:\s*true/);
  });

  it('existing save endpoint route remains PUT /checklist-executions/:id/responses (no new endpoint)', () => {
    const routes = readFileSync(ROUTES, 'utf8');
    assert.match(routes, /checklist-executions\/:id\/responses/);
    assert.match(routes, /saveChecklistResponses/);
    // Count of distinct admin+mobile PUT bindings for that path: admin route
    // registers it once; mobile delegates to service (no separate response
    // write endpoint path).
    assert.ok((routes.match(/\.put\([^)]*checklist-executions\/:id\/responses/g) ?? []).length >= 1);
  });
});
