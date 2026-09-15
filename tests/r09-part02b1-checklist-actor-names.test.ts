import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * R09 PART 02B1 — Checklist User Actor Display Names focused validation
 *
 * Static source assertions (no DB). Live-DB cases are CI-required.
 *
 * Proves the contract-critical facts:
 *  1-3. three nullable name fields added
 *  4. exactly three users LEFT JOINs introduced
 *  5. completion join resolves by persisted completedByUserId source
 *  6. last-responder join resolves by persisted lastRespondedByUserId source
 *  7. reviewer join resolves by persisted verificationReviewerUserId source
 *  8. all three are PK-based 0..1 LEFT JOINs
 *  9. no user status predicate
 * 10. no invented client predicate
 * 11. no membership predicate
 * 12-14. display_name selected for each name
 * 15. mapRow direct copies
 * 16. no COALESCE/fallback/concatenation on names
 * 17. no email substitution
 * 18. no workforce-profile substitution
 * 19. persisted actor ID fields unchanged
 * 20. assignment fields unchanged
 * 21. UOM fields and safe UOM join unchanged
 * 22. grain/order/pagination unchanged
 * 23. building/client authorization unchanged
 * 24. response semantics unchanged
 * 25. latest-COMPLETED review selector unchanged
 * 26. form physical detail untouched
 * 27. neutral operational detail untouched
 * 28. export projection untouched
 * 29. no second export table
 * 30. documentation classifies names CURRENT LIVE FACT, not snapshots
 */

const REPO_PATH = resolve(
  __dirname,
  '../src/modules/checklist-execution-detail/checklist-execution-detail.repository.ts',
);
const TYPES_PATH = resolve(
  __dirname,
  '../src/modules/checklist-execution-detail/checklist-execution-detail.types.ts',
);
const FORM_REPO_PATH = resolve(
  __dirname,
  '../src/modules/form-execution-detail/form-execution-detail.repository.ts',
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
const formRepo = read(FORM_REPO_PATH);
const neutralTypes = read(NEUTRAL_TYPES_PATH);
const projections = read(PROJECTIONS_PATH);

const count = (src: string, re: RegExp): number => (src.match(re) ?? []).length;

// Code-only view: block comments and ` * ` comment lines stripped so join
// counting cannot be fooled by documentation text.
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\*.*$/gm, '');
const repoCode = stripComments(repo);

// The actor-join region (from the first users join to the WHERE clause).
const joinStart = repoCode.indexOf('LEFT JOIN users cbu');
const joinEnd = repoCode.indexOf("WHERE ${conditions.join(' AND ')}", joinStart);
assert.ok(joinStart >= 0 && joinEnd > joinStart, 'actor-join region must exist');
const actorJoins = repoCode.slice(joinStart, joinEnd);

const opDetailStart = projections.indexOf('export function projectOperationalDetail(');
assert.ok(opDetailStart >= 0, 'projectOperationalDetail must exist');
const opDetail = projections.slice(opDetailStart);

describe('R09 PART 02B1 — Checklist User Actor Display Names', () => {
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

  // 4. exactly three users joins
  it('04 exactly three users LEFT JOINs introduced', () => {
    assert.equal(count(repoCode, /LEFT JOIN users\b/g), 3);
    assert.doesNotMatch(repoCode, /\bINNER JOIN users/);
    assert.doesNotMatch(repoCode, /\bJOIN users\b(?! (?:cbu|lru|vru)\b)/);
  });

  // 5-7. each join bound to the exact persisted actor source
  it('05 completion join resolves by persisted completion user UUID', () => {
    assert.match(repoCode, /LEFT JOIN users cbu\s+ON cbu\.id = ce_filtered\.completed_by_user_id/);
  });

  it('06 last-responder join resolves by persisted last responder UUID', () => {
    assert.match(repoCode, /LEFT JOIN users lru\s+ON lru\.id = r\.last_responded_by_user_id/);
  });

  it('07 reviewer join resolves by persisted verification reviewer UUID', () => {
    assert.match(repoCode, /LEFT JOIN users vru\s+ON vru\.id = vr\.reviewer_user_id/);
  });

  // 8. PK-based 0..1 shape
  it('08 all three joins are PK-based LEFT JOINs (alias.id = <persisted uuid>)', () => {
    for (const alias of ['cbu', 'lru', 'vru']) {
      assert.match(actorJoins, new RegExp(`LEFT JOIN users ${alias}\\s+ON ${alias}\\.id = `));
    }
  });

  // 9-11. no status / client / membership predicates
  it('09 no user status predicate on the actor joins', () => {
    assert.doesNotMatch(actorJoins, /status/i);
  });

  it('10 no client predicate invented on users', () => {
    assert.doesNotMatch(actorJoins, /client/i);
  });

  it('11 no membership predicate introduced', () => {
    assert.doesNotMatch(actorJoins, /membership|member|clients\b/i);
  });

  // 12-14. display_name selects
  it('12 display_name selected for completion name', () => {
    assert.equal(count(repoCode, /cbu\.display_name AS completed_by_name/g), 1);
  });

  it('13 display_name selected for last responder name', () => {
    assert.equal(count(repoCode, /lru\.display_name AS last_responded_by_name/g), 1);
  });

  it('14 display_name selected for verification reviewer name', () => {
    assert.equal(count(repoCode, /vru\.display_name AS verification_reviewer_name/g), 1);
  });

  // 15. direct mapping
  it('15 mapRow copies all three directly', () => {
    assert.match(repo, /completedByName: row\.completed_by_name,/);
    assert.match(repo, /lastRespondedByName: row\.last_responded_by_name,/);
    assert.match(repo, /verificationReviewerName: row\.verification_reviewer_name,/);
  });

  // 16. no COALESCE/fallback/concatenation
  it('16 no COALESCE, fallback, or concatenation on the names', () => {
    assert.doesNotMatch(repoCode, /COALESCE\([^)]*(?:cbu\.|lru\.|vru\.|completed_by_name|last_responded_by_name|verification_reviewer_name)/);
    for (const alias of ['cbu', 'lru', 'vru']) {
      assert.doesNotMatch(repoCode, new RegExp(`${alias}\\.display_name[\\s\\S]{0,40}\\|\\|`));
      assert.doesNotMatch(repoCode, new RegExp(`${alias}\\.display_name[\\s\\S]{0,40}\\?\\?`));
    }
  });

  // 17./18. no substitution sources
  it('17 no email substitution', () => {
    assert.doesNotMatch(repoCode, /cbu\.email|lru\.email|vru\.email/);
  });

  it('18 no workforce-profile substitution', () => {
    assert.doesNotMatch(repoCode, /workforce_profiles/);
    assert.doesNotMatch(repoCode, /full_name/);
  });

  // 19. persisted actor IDs unchanged
  it('19 persisted actor ID selections unchanged (ID + join anchor each)', () => {
    assert.equal(count(repoCode, /ce_filtered\.completed_by_user_id/g), 2);
    assert.equal(count(repoCode, /r\.last_responded_by_user_id/g), 2);
    assert.equal(count(repoCode, /vr\.reviewer_user_id AS verification_reviewer_user_id/g), 1);
    assert.match(repo, /completedByUserId: row\.completed_by_user_id,/);
    assert.match(repo, /lastRespondedByUserId: row\.last_responded_by_user_id,/);
    assert.match(repo, /verificationReviewerUserId: row\.verification_reviewer_user_id,/);
  });

  // 20. assignment fields unchanged
  it('20 assignment fields unchanged', () => {
    assert.match(repoCode, /ce_filtered\.assignee_type,/);
    assert.match(repoCode, /ce_filtered\.assigned_workforce_profile_id,/);
    assert.match(repoCode, /ce_filtered\.assigned_team_id,/);
    assert.match(repoCode, /ce_filtered\.assignment_snapshot_at,/);
  });

  // 21. UOM fields and safe join unchanged
  it('21 UOM presentation fields and structural safe join unchanged', () => {
    assert.equal(count(repoCode, /uom\.name AS uom_name/g), 1);
    assert.equal(count(repoCode, /uom\.symbol AS uom_symbol/g), 1);
    assert.match(repoCode, /LEFT JOIN units_of_measure uom\s+ON uom\.id = ci\.uom_id\s+AND uom\.client_id = ce_filtered\.client_id/);
  });

  // 22. grain/order/pagination
  it('22 grain, deterministic order, and pagination unchanged', () => {
    assert.match(
      repo,
      /ORDER BY ce_filtered\.created_at DESC, ce_filtered\.id ASC, ci\.display_order ASC, ci\.id ASC/,
    );
    assert.equal(count(repoCode, /getPool\(\)\.query/g), 1);
    assert.match(repo, /\$\{limitClause\}/);
    assert.match(repo, /\$\{offsetClause\}/);
    assert.doesNotMatch(repoCode, /GROUP BY|DISTINCT|ROW_NUMBER/);
  });

  // 23. authorization unchanged
  it('23 building/client authorization unchanged', () => {
    assert.match(repo, /ce_filtered\.building_id = ANY\(\$1::uuid\[\]\)/);
    assert.match(repo, /SELECT \* FROM ce_base WHERE building_id IS NOT NULL/);
    assert.match(repo, /ce_filtered\.created_at >= \$\$\{paramIndex\}/);
    assert.match(repo, /ce_filtered\.created_at < \$\$\{paramIndex\}/);
  });

  // 24. response semantics unchanged
  it('24 response, explicit N/A, and SELECT semantics unchanged', () => {
    assert.match(repoCode, /LEFT JOIN checklist_item_responses r\s+ON r\.checklist_execution_id = ce_filtered\.id\s+AND r\.checklist_item_id = ci\.id/);
    assert.match(repo, /r\.is_na AS is_na/);
    assert.match(repo, /WHEN ci\.item_type = 'SELECT' AND r\.id IS NOT NULL AND COALESCE\(r\.is_na, false\) = false AND r\.value IS NOT NULL/);
    assert.match(repo, /END AS option_code/);
  });

  // 25. review selector unchanged
  it('25 latest-COMPLETED-review LATERAL selector unchanged', () => {
    assert.match(repoCode, /target_type = 'CHECKLIST_EXECUTION'/);
    assert.match(repoCode, /status = 'COMPLETED'/);
    assert.match(repo, /ORDER BY reviewed_at DESC, created_at DESC, id DESC\s+LIMIT 1/);
  });

  // 26. form physical untouched
  it('26 form physical detail untouched (no users join yet; PART 02A2 marker intact)', () => {
    assert.doesNotMatch(stripComments(formRepo), /LEFT JOIN users\b/);
    assert.match(formRepo, /R09 PART 02A2/);
  });

  // 27. neutral untouched
  it('27 neutral operational detail untouched (belongs to PART 02D)', () => {
    assert.doesNotMatch(neutralTypes, /completedByName|lastRespondedByName|verificationReviewerName/);
  });

  // 28./29. export untouched, no second table
  it('28 OPERATIONAL_DETAIL projection untouched (belongs to PART 02D)', () => {
    assert.doesNotMatch(opDetail, /completedByName|lastRespondedByName|verificationReviewerName/);
  });

  it('29 OPERATIONAL_DETAIL remains exactly one table', () => {
    assert.equal(count(opDetail, /\btable\(/g), 1);
  });

  // 30. truthful documentation
  it('30 all three names documented as CURRENT LIVE FACT, not snapshots', () => {
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
      assert.match(line ?? '', /NOT a historical snapshot/);
      assert.doesNotMatch(line ?? '', /VERSION SNAPSHOT|STABLE snapshot|stable snapshot/);
    }
    assert.match(repo, /R09 PART 02B1/);
  });
});
