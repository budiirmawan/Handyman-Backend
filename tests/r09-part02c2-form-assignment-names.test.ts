import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * R09 PART 02C2 — Form Assignment Target Display Names focused validation
 *
 * Static source assertions only; live database cases are CI-required.
 * Both UNION branches must resolve current live target names from the
 * persisted R06 assignment IDs without changing form occurrence grain.
 */

const ROOT = process.cwd();
const REPO_PATH = resolve(ROOT, 'src/modules/form-execution-detail/form-execution-detail.repository.ts');
const TYPES_PATH = resolve(ROOT, 'src/modules/form-execution-detail/form-execution-detail.types.ts');

const read = (path: string): string => readFileSync(path, 'utf8');
const repo = read(REPO_PATH);
const types = read(TYPES_PATH);
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\*.*$/gm, '');
const repoCode = stripComments(repo);
const count = (source: string, pattern: RegExp): number => (source.match(pattern) ?? []).length;

const queryStart = repoCode.indexOf('const sql = `');
const queryEnd = repoCode.indexOf('const result = await getPool()');
assert.ok(queryStart >= 0 && queryEnd > queryStart, 'form query must exist');
const queryBody = repoCode.slice(queryStart, queryEnd);
const unionMarker = 'UNION ALL';
const unionIndex = queryBody.indexOf(unionMarker);
assert.ok(unionIndex > 0, 'form query must contain UNION ALL');
assert.equal(count(queryBody, /UNION ALL/g), 1);
const branch1 = queryBody.slice(0, unionIndex);
const branch2 = queryBody.slice(unionIndex + unionMarker.length);

const selectLists = [...queryBody.matchAll(/SELECT\n((?:      [^\n]*\n)+)    FROM fi_filtered/g)].map(
  (match) => match[1],
);

const workforceSafeJoin = /LEFT JOIN workforce_profiles awp\s+ON awp\.id = fi_filtered\.assigned_workforce_profile_id\s+AND EXISTS \(\s+SELECT 1\s+FROM organizations awp_org\s+WHERE awp_org\.id = awp\.organization_id\s+AND awp_org\.client_id = fi_filtered\.client_id\s+\)/g;
const teamSafeJoin = /LEFT JOIN teams assigned_team\s+ON assigned_team\.id = fi_filtered\.assigned_team_id\s+AND EXISTS \(\s+SELECT 1\s+FROM departments assigned_department\s+JOIN organizations assigned_organization\s+ON assigned_organization\.id = assigned_department\.organization_id\s+WHERE assigned_department\.id = assigned_team\.department_id\s+AND assigned_organization\.client_id = fi_filtered\.client_id\s+\)/g;

const workforceJoins = [...queryBody.matchAll(workforceSafeJoin)];
const teamJoins = [...queryBody.matchAll(teamSafeJoin)];
assert.equal(workforceJoins.length, 2, 'one safe workforce join per UNION branch');
assert.equal(teamJoins.length, 2, 'one safe team join per UNION branch');

const assignmentSelect = /fi_filtered\.assignee_type,\s+fi_filtered\.assigned_workforce_profile_id,\s+awp\.full_name AS assigned_workforce_name,\s+fi_filtered\.assigned_team_id,\s+assigned_team\.name AS assigned_team_name,\s+fi_filtered\.assignment_snapshot_at,/;

describe('R09 PART 02C2 — Form Assignment Target Display Names', () => {
  it('01 adds exactly two nullable presentation fields', () => {
    assert.match(types, /assignedWorkforceName: string \| null;/);
    assert.match(types, /assignedTeamName: string \| null;/);
    assert.doesNotMatch(types, /assignedWorkforceName: string;/);
    assert.doesNotMatch(types, /assignedTeamName: string;/);
  });

  it('02 keeps names adjacent to the corresponding persisted IDs', () => {
    assert.match(
      types,
      /assignedWorkforceProfileId: string \| null;[\s\S]*assignedWorkforceName: string \| null;[\s\S]*assignedTeamId: string \| null;[\s\S]*assignedTeamName: string \| null;/,
    );
    assert.match(repo, /assignedWorkforceProfileId: row\.assigned_workforce_profile_id,/);
    assert.match(repo, /assignedWorkforceName: row\.assigned_workforce_name,/);
    assert.match(repo, /assignedTeamId: row\.assigned_team_id,/);
    assert.match(repo, /assignedTeamName: row\.assigned_team_name,/);
  });

  it('03 preserves the exact assignment sources in the fi_base lineage', () => {
    assert.match(repoCode, /fi\.assignee_type,/);
    assert.match(repoCode, /fi\.assigned_workforce_profile_id,/);
    assert.match(repoCode, /fi\.assigned_team_id,/);
    assert.match(repoCode, /fi\.assignment_snapshot_at,/);
    assert.match(repoCode, /fi_filtered\.assignee_type,/);
    assert.match(repoCode, /fi_filtered\.assigned_workforce_profile_id,/);
    assert.match(repoCode, /fi_filtered\.assigned_team_id,/);
    assert.match(repoCode, /fi_filtered\.assignment_snapshot_at,/);
    assert.match(repo, /assigneeType: row\.assignee_type,/);
    assert.match(repo, /assignmentSnapshotAt: toIso\(row\.assignment_snapshot_at\),/);
  });

  it('04 both UNION branches select both presentation names from authoritative sources', () => {
    assert.equal(count(branch1, /awp\.full_name AS assigned_workforce_name/g), 1);
    assert.equal(count(branch2, /awp\.full_name AS assigned_workforce_name/g), 1);
    assert.equal(count(branch1, /assigned_team\.name AS assigned_team_name/g), 1);
    assert.equal(count(branch2, /assigned_team\.name AS assigned_team_name/g), 1);
    assert.match(repoCode, /awp\.full_name AS assigned_workforce_name/);
    assert.match(repoCode, /assigned_team\.name AS assigned_team_name/);
  });

  it('05 every workforce join is anchored to the exact profile ID and lineage', () => {
    for (const join of workforceJoins) {
      assert.match(join[0], /awp\.id = fi_filtered\.assigned_workforce_profile_id/);
      assert.match(join[0], /awp_org\.id = awp\.organization_id/);
      assert.match(join[0], /awp_org\.client_id = fi_filtered\.client_id/);
      assert.doesNotMatch(join[0], /status/i);
    }
  });

  it('06 every team join is anchored to the exact team ID and lineage', () => {
    for (const join of teamJoins) {
      assert.match(join[0], /assigned_team\.id = fi_filtered\.assigned_team_id/);
      assert.match(join[0], /assigned_department\.id = assigned_team\.department_id/);
      assert.match(join[0], /assigned_organization\.id = assigned_department\.organization_id/);
      assert.match(join[0], /assigned_organization\.client_id = fi_filtered\.client_id/);
      assert.doesNotMatch(join[0], /status/i);
    }
  });

  it('07 has no PK-only or broad client lookup pattern', () => {
    assert.equal(count(queryBody, /LEFT JOIN workforce_profiles\b/g), 2);
    assert.equal(count(queryBody, /LEFT JOIN teams\b/g), 2);
    assert.doesNotMatch(queryBody, /JOIN organizations\s+\w+\s+ON\s+\w+\.client_id\s*=\s*fi_filtered\.client_id/);
    assert.doesNotMatch(queryBody, /FROM workforce_profiles[\s\S]{0,160}client_id\s*=\s*fi_filtered\.client_id/);
    assert.doesNotMatch(queryBody, /FROM teams[\s\S]{0,160}client_id\s*=\s*fi_filtered\.client_id/);
  });

  it('08 keeps name resolution nullable and free of fallback or synthesis', () => {
    assert.doesNotMatch(queryBody, /COALESCE\([^)]*(?:assigned_workforce_name|assigned_team_name|awp\.|assigned_team\.)/);
    assert.doesNotMatch(queryBody, /assigned_workforce_name[\s\S]{0,100}\|\||assigned_team_name[\s\S]{0,100}\|\|/);
    assert.doesNotMatch(queryBody, /assigned_workforce_name[\s\S]{0,100}(?:email|display_name)/i);
    assert.doesNotMatch(queryBody, /assigned_team_name[\s\S]{0,100}(?:email|display_name)/i);
    assert.doesNotMatch(queryBody, /current task assignment|task_assignments/i);
  });

  it('09 proves 0..1 join shape and no row-repair logic', () => {
    assert.equal(workforceJoins.length, 2);
    assert.equal(teamJoins.length, 2);
    assert.equal(count(queryBody, /EXISTS \(/g), 4);
    assert.doesNotMatch(repoCode, /DISTINCT|GROUP BY|ROW_NUMBER/);
  });

  it('10 preserves both UNION select-list count and order', () => {
    assert.equal(selectLists.length, 2, 'two SELECT lists detected');
    assert.ok(selectLists[0].length > 0 && selectLists[1].length > 0);
    assert.equal(selectLists[0].trim().split('\n').length, selectLists[1].trim().split('\n').length);
    assert.equal(selectLists[0], selectLists[1]);
    assert.match(branch1, assignmentSelect);
    assert.match(branch2, assignmentSelect);
  });

  it('11 preserves actor and UOM authorities independently in both branches', () => {
    assert.equal(count(repoCode, /LEFT JOIN users\b/g), 6);
    assert.equal(count(repoCode, /LEFT JOIN units_of_measure uom/g), 2);
    assert.equal(count(repoCode, /uom\.name AS uom_name/g), 2);
    assert.equal(count(repoCode, /uom\.symbol AS uom_symbol/g), 2);
    assert.equal(count(repoCode, /LEFT JOIN users cbu\s+ON cbu\.id = fi_filtered\.completed_by_user_id/g), 2);
    assert.equal(count(repoCode, /LEFT JOIN users lru\s+ON lru\.id = r\.last_responded_by_user_id/g), 2);
    assert.equal(count(repoCode, /LEFT JOIN users vru\s+ON vru\.id = vr\.reviewer_user_id/g), 2);
  });

  it('12 preserves form occurrence grain, authorization, ordering, and pagination', () => {
    assert.match(repo, /JOIN form_instance_occurrences occ ON occ\.form_instance_id = fi_filtered\.id AND occ\.repeatable_group_id = rg\.id/);
    assert.match(repo, /LEFT JOIN LATERAL \(SELECT NULL::uuid AS id, NULL::int AS occurrence_index\) occ ON rg\.id IS NULL/);
    assert.match(repo, /WHERE rg\.id IS NULL AND \$\{conditions\.join\(' AND '\)\}/);
    assert.match(repo, /fi_filtered\.building_id = ANY\(\$1::uuid\[\]\)/);
    assert.match(repo, /SELECT \* FROM fi_base WHERE building_id IS NOT NULL/);
    assert.match(repo, /ORDER BY instance_created_at DESC, form_instance_id ASC, section_display_order ASC, section_id ASC, occurrence_index ASC NULLS FIRST, display_order ASC, version_field_id ASC/);
    assert.match(repo, /\$\{limitClause\}/);
    assert.match(repo, /\$\{offsetClause\}/);
    assert.equal(count(repoCode, /getPool\(\)\.query/g), 1);
  });

  it('13 preserves response and latest-COMPLETED review semantics', () => {
    assert.equal(count(repoCode, /AND r\.occurrence_id IS NULL/g), 1);
    assert.equal(count(repoCode, /AND r\.occurrence_id = occ\.id/g), 1);
    assert.equal(count(repoCode, /target_type = 'FORM_INSTANCE'/g), 2);
    assert.equal(count(repoCode, /status = 'COMPLETED'/g), 2);
    assert.equal(count(repoCode, /LIMIT 1/g), 2);
  });

  it('14 documents both names as current live facts, not snapshots or executors', () => {
    const workforceLine = types.split('\n').find((line) => line.includes('assignedWorkforceName:')) ?? '';
    const teamLine = types.split('\n').find((line) => line.includes('assignedTeamName:')) ?? '';
    assert.match(workforceLine, /CURRENT LIVE FACT/);
    assert.match(workforceLine, /NOT a historical assignment snapshot/);
    assert.match(workforceLine, /NOT an actual executor/);
    assert.match(teamLine, /CURRENT LIVE FACT/);
    assert.match(teamLine, /NOT a historical assignment snapshot/);
    assert.match(teamLine, /team-only/);
    assert.match(teamLine, /NOT an actual executor/);
    assert.match(repo, /R09 PART 02C2/);
  });
});
