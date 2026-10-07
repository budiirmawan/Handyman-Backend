import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * R09 PART 02C1 — Checklist Assignment Target Display Names focused validation
 *
 * Static source assertions only; live database cases are CI-required.
 * The presentation names are current live facts resolved from the persisted
 * R06 assignment snapshot IDs. They are not executor or historical-name data.
 */

const REPO_ROOT = process.cwd();
const REPO_PATH = resolve(
  REPO_ROOT,
  'src/modules/checklist-execution-detail/checklist-execution-detail.repository.ts',
);
const TYPES_PATH = resolve(
  REPO_ROOT,
  'src/modules/checklist-execution-detail/checklist-execution-detail.types.ts',
);

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

const repo = read(REPO_PATH);
const types = read(TYPES_PATH);
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\*.*$/gm, '');
const repoCode = stripComments(repo);

const workforceJoin = repoCode.match(
  /LEFT JOIN workforce_profiles awp\s+ON awp\.id = ce_filtered\.assigned_workforce_profile_id\s+AND EXISTS \(\s+SELECT 1\s+FROM organizations awp_org\s+WHERE awp_org\.id = awp\.organization_id\s+AND awp_org\.client_id = ce_filtered\.client_id\s+\)/,
);
const teamJoin = repoCode.match(
  /LEFT JOIN teams assigned_team\s+ON assigned_team\.id = ce_filtered\.assigned_team_id\s+AND EXISTS \(\s+SELECT 1\s+FROM departments assigned_department\s+JOIN organizations assigned_organization\s+ON assigned_organization\.id = assigned_department\.organization_id\s+WHERE assigned_department\.id = assigned_team\.department_id\s+AND assigned_organization\.client_id = ce_filtered\.client_id\s+\)/,
);

assert.ok(workforceJoin, 'workforce name join must be present');
assert.ok(teamJoin, 'team name join must be present');

const assignmentJoinSql = repoCode.slice(
  repoCode.indexOf('LEFT JOIN workforce_profiles'),
  repoCode.indexOf('LEFT JOIN checklist_item_options'),
);

const fieldLine = (field: string): string =>
  types.split('\n').find((line) => line.includes(`${field}:`)) ?? '';

describe('R09 PART 02C1 — Checklist Assignment Target Display Names', () => {
  it('01 adds exactly two nullable presentation fields', () => {
    assert.match(types, /assignedWorkforceName: string \| null;/);
    assert.match(types, /assignedTeamName: string \| null;/);
    assert.doesNotMatch(types, /assignedWorkforceName: string;/);
    assert.doesNotMatch(types, /assignedTeamName: string;/);
  });

  it('02 keeps presentation fields adjacent to their persisted assignment IDs', () => {
    assert.match(
      types,
      /assignedWorkforceProfileId: string \| null;[\s\S]*assignedWorkforceName: string \| null;[\s\S]*assignedTeamId: string \| null;[\s\S]*assignedTeamName: string \| null;/,
    );
    assert.match(
      repo,
      /ce_filtered\.assigned_workforce_profile_id,\s+awp\.full_name AS assigned_workforce_name,\s+ce_filtered\.assigned_team_id,\s+assigned_team\.name AS assigned_team_name,/,
    );
  });

  it('03 preserves the exact R06 assignment ID and snapshot sources', () => {
    assert.match(repoCode, /ce\.assignee_type,/);
    assert.match(repoCode, /ce\.assigned_workforce_profile_id,/);
    assert.match(repoCode, /ce\.assigned_team_id,/);
    assert.match(repoCode, /ce\.assignment_snapshot_at,/);
    assert.match(repoCode, /ce_filtered\.assignee_type,/);
    assert.match(repoCode, /ce_filtered\.assigned_workforce_profile_id,/);
    assert.match(repoCode, /ce_filtered\.assigned_team_id,/);
    assert.match(repoCode, /ce_filtered\.assignment_snapshot_at,/);
    assert.match(repo, /assigneeType: row\.assignee_type,/);
    assert.match(repo, /assignedWorkforceProfileId: row\.assigned_workforce_profile_id,/);
    assert.match(repo, /assignedTeamId: row\.assigned_team_id,/);
    assert.match(repo, /assignmentSnapshotAt: toIso\(row\.assignment_snapshot_at\),/);
  });

  it('04 resolves workforce name from full_name and maps it directly', () => {
    assert.equal((repoCode.match(/awp\.full_name AS assigned_workforce_name/g) ?? []).length, 1);
    assert.match(repo, /assignedWorkforceName: row\.assigned_workforce_name,/);
    assert.doesNotMatch(repoCode, /assigned_workforce_name[^\n]*(?:email|display_name)/i);
  });

  it('05 resolves team name from teams.name and maps it directly', () => {
    assert.equal((repoCode.match(/assigned_team\.name AS assigned_team_name/g) ?? []).length, 1);
    assert.match(repo, /assignedTeamName: row\.assigned_team_name,/);
    assert.doesNotMatch(repoCode, /assigned_team_name[^\n]*(?:email|display_name)/i);
  });

  it('06 workforce name-bearing row is structurally client-safe and fail-closed', () => {
    assert.ok(workforceJoin);
    assert.match(workforceJoin?.[0] ?? '', /awp\.id = ce_filtered\.assigned_workforce_profile_id/);
    assert.match(workforceJoin?.[0] ?? '', /awp_org\.id = awp\.organization_id/);
    assert.match(workforceJoin?.[0] ?? '', /awp_org\.client_id = ce_filtered\.client_id/);
    assert.doesNotMatch(workforceJoin?.[0] ?? '', /status/i);
  });

  it('07 team name-bearing row is structurally client-safe and fail-closed', () => {
    assert.ok(teamJoin);
    assert.match(teamJoin?.[0] ?? '', /assigned_team\.id = ce_filtered\.assigned_team_id/);
    assert.match(teamJoin?.[0] ?? '', /assigned_department\.id = assigned_team\.department_id/);
    assert.match(teamJoin?.[0] ?? '', /assigned_organization\.id = assigned_department\.organization_id/);
    assert.match(teamJoin?.[0] ?? '', /assigned_organization\.client_id = ce_filtered\.client_id/);
    assert.doesNotMatch(teamJoin?.[0] ?? '', /status/i);
  });

  it('08 does not use PK-only or broad client lookup joins', () => {
    assert.equal((repoCode.match(/LEFT JOIN workforce_profiles\b/g) ?? []).length, 1);
    assert.equal((repoCode.match(/LEFT JOIN teams\b/g) ?? []).length, 1);
    assert.doesNotMatch(repoCode, /LEFT JOIN workforce_profiles awp\s+ON awp\.id = ce_filtered\.assigned_workforce_profile_id\s*\n\s*LEFT JOIN/);
    assert.doesNotMatch(repoCode, /LEFT JOIN teams assigned_team\s+ON assigned_team\.id = ce_filtered\.assigned_team_id\s*\n\s*LEFT JOIN/);
    assert.doesNotMatch(repoCode, /JOIN organizations\s+\w+\s+ON\s+\w+\.client_id\s*=\s*ce_filtered\.client_id/);
    assert.doesNotMatch(repoCode, /FROM workforce_profiles[\s\S]{0,160}client_id\s*=\s*ce_filtered\.client_id/);
    assert.doesNotMatch(repoCode, /FROM teams[\s\S]{0,160}client_id\s*=\s*ce_filtered\.client_id/);
  });

  it('09 assignment presentation has no fallback, synthesis, or status gate', () => {
    assert.doesNotMatch(assignmentJoinSql, /COALESCE|\|\||\?\?/);
    assert.doesNotMatch(assignmentJoinSql, /status/i);
    assert.doesNotMatch(repoCode, /assigned_workforce_name[\s\S]{0,100}(?:current task|task_assignment)/i);
    assert.doesNotMatch(repoCode, /assigned_team_name[\s\S]{0,100}(?:current task|task_assignment)/i);
  });

  it('10 uses independent nullable 0..1 left joins without row-repair logic', () => {
    assert.equal((repoCode.match(/LEFT JOIN workforce_profiles\b/g) ?? []).length, 1);
    assert.equal((repoCode.match(/LEFT JOIN teams\b/g) ?? []).length, 1);
    assert.equal((assignmentJoinSql.match(/EXISTS \(/g) ?? []).length, 2);
    assert.doesNotMatch(repoCode, /DISTINCT|GROUP BY|ROW_NUMBER/);
  });

  it('11 preserves existing actor and UOM structural joins', () => {
    assert.match(repoCode, /LEFT JOIN users cbu\s+ON cbu\.id = ce_filtered\.completed_by_user_id/);
    assert.match(repoCode, /LEFT JOIN users lru\s+ON lru\.id = r\.last_responded_by_user_id/);
    assert.match(repoCode, /LEFT JOIN users vru\s+ON vru\.id = vr\.reviewer_user_id/);
    assert.match(repoCode, /LEFT JOIN units_of_measure uom\s+ON uom\.id = ci\.uom_id\s+AND uom\.client_id = ce_filtered\.client_id/);
  });

  it('12 preserves one query, authorization, grain, ordering, and pagination', () => {
    assert.equal((repoCode.match(/getPool\(\)\.query/g) ?? []).length, 1);
    assert.match(repo, /ce_filtered\.building_id = ANY\(\$1::uuid\[\]\)/);
    assert.match(repo, /SELECT \* FROM ce_base WHERE building_id IS NOT NULL/);
    assert.match(repo, /ORDER BY ce_filtered\.created_at DESC, ce_filtered\.id ASC, ci\.display_order ASC, ci\.id ASC/);
    assert.match(repo, /\$\{limitClause\}/);
    assert.match(repo, /\$\{offsetClause\}/);
  });

  it('13 documents both names as current live assignment targets, not executor facts', () => {
    const workforceField = fieldLine('assignedWorkforceName');
    const teamField = fieldLine('assignedTeamName');
    assert.match(workforceField, /CURRENT LIVE FACT/);
    assert.match(workforceField, /NOT a historical assignment snapshot/);
    assert.match(workforceField, /NOT an actual executor/);
    assert.match(teamField, /CURRENT LIVE FACT/);
    assert.match(teamField, /NOT a historical assignment snapshot/);
    assert.match(teamField, /team-only/);
    assert.match(teamField, /NOT an actual executor/);
    assert.match(types, /persisted R06 assignment snapshot IDs|persisted assignedWorkforceProfileId/);
  });
});
