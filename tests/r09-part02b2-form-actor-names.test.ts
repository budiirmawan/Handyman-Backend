import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * R09 PART 02B2 — Form User Actor Display Names focused validation
 *
 * Static source assertions (no DB). Live-DB cases are CI-required.
 *
 * Proves the contract-critical facts:
 *  1-3. three nullable name fields added
 *  4-6. exact persisted actor sources preserved (completion / responder / reviewer)
 *  7-9. three users LEFT JOINs per UNION branch; six total
 * 10-12. each join bound only by its persisted actor UUID
 * 13-15. no status / client / membership predicate on any actor join
 * 16-18. both branches select all three display names
 * 19-20. UNION select-list count and order identical
 * 21. mapRow direct copies
 * 22. no COALESCE/fallback/concatenation
 * 23. no email substitution
 * 24. no workforce-profile substitution
 * 25. persisted actor IDs unchanged
 * 26. assignment fields unchanged
 * 27. UOM fields + structural safe joins unchanged
 * 28. occurrence semantics unchanged
 * 29. grain/order/pagination unchanged
 * 30. building/client authorization unchanged
 * 31. response semantics unchanged
 * 32. latest-COMPLETED review selector unchanged
 * 33. checklist physical module untouched
 * 34. neutral operational detail untouched
 * 35. export projection untouched
 * 36. no second export table
 * 37. documentation classifies names CURRENT LIVE FACT
 * 38. documentation does not classify them as historical snapshots
 */

const REPO_PATH = resolve(
  __dirname,
  '../src/modules/form-execution-detail/form-execution-detail.repository.ts',
);
const TYPES_PATH = resolve(
  __dirname,
  '../src/modules/form-execution-detail/form-execution-detail.types.ts',
);
const CHECKLIST_REPO_PATH = resolve(
  __dirname,
  '../src/modules/checklist-execution-detail/checklist-execution-detail.repository.ts',
);
const NEUTRAL_TYPES_PATH = resolve(
  __dirname,
  '../src/modules/operational-detail-reporting/operational-detail-reporting.types.ts',
);
const PROJECTIONS_PATH = resolve(
  __dirname,
  '../src/modules/reporting-export/reporting-export.projections.ts',
);

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const repo = read(REPO_PATH);
const types = read(TYPES_PATH);
const checklistRepo = read(CHECKLIST_REPO_PATH);
const neutralTypes = read(NEUTRAL_TYPES_PATH);
const projections = read(PROJECTIONS_PATH);

const count = (src: string, re: RegExp): number => (src.match(re) ?? []).length;

// Code-only view: block comments and ` * ` comment lines stripped so join
// counting cannot be fooled by documentation text.
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\*.*$/gm, '');
const repoCode = stripComments(repo);

// The query body split into its two UNION branches.
const queryStart = repoCode.indexOf('const sql = `');
const queryEnd = repoCode.indexOf('const result = await getPool()');
assert.ok(queryStart >= 0 && queryEnd > queryStart, 'query body must exist');
const queryBody = repoCode.slice(queryStart, queryEnd);
const branchSplit = queryBody.indexOf('UNION ALL');
assert.ok(branchSplit > 0, 'UNION ALL must exist exactly once');
assert.equal(count(queryBody, /UNION ALL/g), 1);
const branch1 = queryBody.slice(0, branchSplit);
const branch2 = queryBody.slice(branchSplit + 'UNION ALL'.length);

// Per-branch select lists.
const branchSelects = [
  ...repoCode.matchAll(/SELECT\n((?:      [^\n]*\n)+)    FROM fi_filtered/g),
].map((m) => m[1]);

const opDetailStart = projections.indexOf('export function projectOperationalDetail(');
assert.ok(opDetailStart >= 0, 'projectOperationalDetail must exist');
const opDetail = projections.slice(opDetailStart);

describe('R09 PART 02B2 — Form User Actor Display Names', () => {
  // 1-3. nullable name contract
  it('01 completedByName nullable string added', () => {
    assert.match(types, /completedByName: string \| null;/);
    assert.doesNotMatch(types, /completedByName: string;/);
  });

  it('02 lastRespondedByName nullable string added', () => {
    assert.match(types, /lastRespondedByName: string \| null;/);
    assert.doesNotMatch(types, /lastRespondedByName: string;/);
  });

  it('03 verificationReviewerName nullable string added', () => {
    assert.match(types, /verificationReviewerName: string \| null;/);
    assert.doesNotMatch(types, /verificationReviewerName: string;/);
  });

  // 4-6. exact persisted actor sources preserved
  it('04 completion source preserved: fi_filtered.completed_by_user_id (select + join anchor)', () => {
    assert.equal(count(repoCode, /fi_filtered\.completed_by_user_id/g), 4); // 2 selects + 2 join anchors
    assert.match(repo, /completedByUserId: row\.completed_by_user_id,/);
  });

  it('05 last responder source preserved: r.last_responded_by_user_id (select + join anchor)', () => {
    assert.equal(count(repoCode, /r\.last_responded_by_user_id/g), 4); // 2 selects + 2 join anchors
    assert.match(repo, /lastRespondedByUserId: row\.last_responded_by_user_id,/);
  });

  it('06 reviewer source preserved: vr.reviewer_user_id (select + join anchor)', () => {
    assert.equal(count(repoCode, /vr\.reviewer_user_id AS verification_reviewer_user_id/g), 2);
    assert.match(repo, /verificationReviewerUserId: row\.verification_reviewer_user_id,/);
  });

  // 7-9. join counts
  it('07 branch 1 contains exactly three users LEFT JOINs', () => {
    assert.equal(count(branch1, /LEFT JOIN users\b/g), 3);
  });

  it('08 branch 2 contains exactly three users LEFT JOINs', () => {
    assert.equal(count(branch2, /LEFT JOIN users\b/g), 3);
  });

  it('09 expected total = 6 (no shared CTE structure exists)', () => {
    assert.equal(count(repoCode, /LEFT JOIN users\b/g), 6);
    assert.doesNotMatch(repoCode, /\bINNER JOIN users/);
    assert.doesNotMatch(repoCode, /\bJOIN users\b(?! (?:cbu|lru|vru)\b)/);
  });

  // 10-12. binding to persisted UUIDs only
  it('10 completion joins bind only by persisted completion actor UUID', () => {
    assert.equal(count(repoCode, /LEFT JOIN users cbu\s+ON cbu\.id = fi_filtered\.completed_by_user_id/g), 2);
  });

  it('11 last-responder joins bind only by persisted response actor UUID', () => {
    assert.equal(count(repoCode, /LEFT JOIN users lru\s+ON lru\.id = r\.last_responded_by_user_id/g), 2);
  });

  it('12 reviewer joins bind only by persisted reviewer UUID', () => {
    assert.equal(count(repoCode, /LEFT JOIN users vru\s+ON vru\.id = vr\.reviewer_user_id/g), 2);
  });

  // 13-15. no predicates
  it('13 no actor join has a status predicate', () => {
    for (const b of [branch1, branch2]) {
      assert.doesNotMatch(
        b.slice(b.indexOf('LEFT JOIN users cbu'), b.indexOf('LEFT JOIN users cbu') + 400),
        /status/i,
      );
    }
  });

  it('14 no actor join has a client predicate', () => {
    for (const b of [branch1, branch2]) {
      const region = b.slice(b.indexOf('LEFT JOIN users cbu'), b.indexOf('LEFT JOIN users cbu') + 400);
      assert.doesNotMatch(region, /client/i);
    }
  });

  it('15 no actor join has a membership predicate', () => {
    for (const b of [branch1, branch2]) {
      const region = b.slice(b.indexOf('LEFT JOIN users cbu'), b.indexOf('LEFT JOIN users cbu') + 400);
      assert.doesNotMatch(region, /membership|member|clients\b/i);
    }
  });

  // 16-18. both branches select all three names
  it('16 both branches select completed_by_name', () => {
    assert.equal(count(branch1, /cbu\.display_name AS completed_by_name/g), 1);
    assert.equal(count(branch2, /cbu\.display_name AS completed_by_name/g), 1);
  });

  it('17 both branches select last_responded_by_name', () => {
    assert.equal(count(branch1, /lru\.display_name AS last_responded_by_name/g), 1);
    assert.equal(count(branch2, /lru\.display_name AS last_responded_by_name/g), 1);
  });

  it('18 both branches select verification_reviewer_name', () => {
    assert.equal(count(branch1, /vru\.display_name AS verification_reviewer_name/g), 1);
    assert.equal(count(branch2, /vru\.display_name AS verification_reviewer_name/g), 1);
  });

  // 19-20. UNION alignment
  it('19 UNION select-list column counts remain identical', () => {
    assert.equal(branchSelects.length, 2, 'two UNION branches detected');
    const [a, b] = branchSelects.map((s) => s.trim().split('\n'));
    assert.ok(a.length > 0 && b.length > 0);
    assert.equal(a.length, b.length);
  });

  it('20 select order identical between branches (full parity)', () => {
    assert.equal(branchSelects[0], branchSelects[1]);
  });

  // 21-24. mapping purity
  it('21 mapRow copies all three names directly', () => {
    assert.match(repo, /completedByName: row\.completed_by_name,/);
    assert.match(repo, /lastRespondedByName: row\.last_responded_by_name,/);
    assert.match(repo, /verificationReviewerName: row\.verification_reviewer_name,/);
  });

  it('22 no COALESCE, fallback, or concatenation on the names', () => {
    assert.doesNotMatch(repoCode, /COALESCE\([^)]*(?:cbu\.|lru\.|vru\.|completed_by_name|last_responded_by_name|verification_reviewer_name)/);
    for (const alias of ['cbu', 'lru', 'vru']) {
      assert.doesNotMatch(repoCode, new RegExp(`${alias}\\.display_name[\\s\\S]{0,40}\\|\\|`));
      assert.doesNotMatch(repoCode, new RegExp(`${alias}\\.display_name[\\s\\S]{0,40}\\?\\?`));
    }
  });

  it('23 no email substitution', () => {
    assert.doesNotMatch(repoCode, /cbu\.email|lru\.email|vru\.email/);
  });

  it('24 no workforce-profile substitution', () => {
    assert.doesNotMatch(repoCode, /workforce_profiles/);
    assert.doesNotMatch(repoCode, /full_name/);
  });

  // 25-27. existing authorities preserved
  it('25 persisted actor ID selections unchanged', () => {
    assert.equal(count(repoCode, /fi_filtered\.completed_by_user_id,/g), 2);
    assert.equal(count(repoCode, /r\.last_responded_by_user_id,/g), 2);
    assert.equal(count(repoCode, /vr\.reviewer_user_id AS verification_reviewer_user_id/g), 2);
  });

  it('26 assignment fields unchanged', () => {
    assert.equal(count(repoCode, /fi_filtered\.assignee_type,/g), 2);
    assert.equal(count(repoCode, /fi_filtered\.assigned_workforce_profile_id,/g), 2);
    assert.equal(count(repoCode, /fi_filtered\.assigned_team_id,/g), 2);
    assert.equal(count(repoCode, /fi_filtered\.assignment_snapshot_at,/g), 2);
  });

  it('27 UOM fields and structural safe joins unchanged (both branches)', () => {
    assert.equal(count(repoCode, /uom\.name AS uom_name/g), 2);
    assert.equal(count(repoCode, /uom\.symbol AS uom_symbol/g), 2);
    assert.equal(
      count(repoCode, /LEFT JOIN units_of_measure uom\n      ON uom\.id = ff\.uom_id\n     AND uom\.client_id = fi_filtered\.client_id/g),
      2,
    );
  });

  // 28-32. grain / authorization / semantics
  it('28 occurrence semantics unchanged (expansion + non-repeatable placeholder + guard)', () => {
    assert.match(repo, /JOIN form_instance_occurrences occ ON occ\.form_instance_id = fi_filtered\.id AND occ\.repeatable_group_id = rg\.id/);
    assert.match(repo, /LEFT JOIN LATERAL \(SELECT NULL::uuid AS id, NULL::int AS occurrence_index\) occ ON rg\.id IS NULL/);
    assert.match(repo, /WHERE rg\.id IS NULL AND \$\{conditions\.join\(' AND '\)\}/);
  });

  it('29 grain, deterministic order, and pagination unchanged', () => {
    assert.match(
      repo,
      /ORDER BY instance_created_at DESC, form_instance_id ASC, section_display_order ASC, section_id ASC, occurrence_index ASC NULLS FIRST, display_order ASC, version_field_id ASC/,
    );
    assert.equal(count(repoCode, /getPool\(\)\.query/g), 1);
    assert.match(repo, /\$\{limitClause\}/);
    assert.match(repo, /\$\{offsetClause\}/);
    assert.doesNotMatch(repoCode, /GROUP BY|DISTINCT|ROW_NUMBER/);
  });

  it('30 building/client authorization unchanged', () => {
    assert.match(repo, /fi_filtered\.building_id = ANY\(\$1::uuid\[\]\)/);
    assert.match(repo, /SELECT \* FROM fi_base WHERE building_id IS NOT NULL/);
    assert.match(repo, /fi_filtered\.id = \$\$\{paramIndex\}::uuid/);
    assert.match(repo, /ft\.id = \$\$\{paramIndex\}::uuid/);
    assert.match(repo, /fi_filtered\.created_at >= \$\$\{paramIndex\}/);
    assert.match(repo, /fi_filtered\.created_at < \$\$\{paramIndex\}/);
  });

  it('31 response semantics unchanged in both branches', () => {
    assert.equal(count(repoCode, /AND r\.occurrence_id IS NULL/g), 1);
    assert.equal(count(repoCode, /AND r\.occurrence_id = occ\.id/g), 1);
  });

  it('32 latest-COMPLETED-review selector unchanged in both branches', () => {
    assert.equal(count(repoCode, /target_type = 'FORM_INSTANCE'/g), 2);
    assert.equal(count(repoCode, /status = 'COMPLETED'/g), 2);
    assert.equal(count(repoCode, /LIMIT 1/g), 2);
  });

  // 33-36. other modules untouched
  it('33 checklist physical module untouched (its three PART 02B1 joins intact, nothing form-side added)', () => {
    assert.match(checklistRepo, /R09 PART 02B1/);
    assert.equal(count(stripComments(checklistRepo), /LEFT JOIN users\b/g), 3);
    assert.doesNotMatch(checklistRepo, /fi_filtered\.completed_by_user_id/);
  });

  it('34 neutral operational detail untouched (belongs to PART 02D)', () => {
    assert.doesNotMatch(neutralTypes, /completedByName|lastRespondedByName|verificationReviewerName/);
  });

  it('35 OPERATIONAL_DETAIL projection untouched (belongs to PART 02D)', () => {
    assert.doesNotMatch(opDetail, /completedByName|lastRespondedByName|verificationReviewerName/);
  });

  it('36 no second export table introduced', () => {
    assert.equal(count(opDetail, /\btable\(/g), 1);
  });

  // 37-38. truthful documentation
  it('37 all three names documented as CURRENT LIVE FACT', () => {
    for (const field of [
      'completedByName: string | null;',
      'lastRespondedByName: string | null;',
      'verificationReviewerName: string | null;',
    ]) {
      const line = types
        .split('\n')
        .find((l) => l.includes(field));
      assert.ok(line, `${field} line present`);
      assert.match(line ?? '', /CURRENT LIVE FACT/);
    }
    assert.match(repo, /R09 PART 02B2/);
  });

  it('38 no historical-snapshot classification for any name', () => {
    for (const field of [
      'completedByName: string | null;',
      'lastRespondedByName: string | null;',
      'verificationReviewerName: string | null;',
    ]) {
      const line = types
        .split('\n')
        .find((l) => l.includes(field));
      assert.ok(line, `${field} line present`);
      assert.match(line ?? '', /NOT a historical snapshot/);
      assert.doesNotMatch(line ?? '', /VERSION SNAPSHOT|STABLE snapshot|stable snapshot/);
    }
  });
});
