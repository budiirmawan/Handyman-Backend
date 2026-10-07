import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

/** R09 PART 02D-E2 — focused projection-only attribution contract. */

const ROOT = process.cwd();
const projection = readFileSync(
  resolve(ROOT, 'src/modules/reporting-export/reporting-export.projections.ts'),
  'utf8',
);
const types = readFileSync(
  resolve(ROOT, 'src/modules/reporting-export/reporting-export.types.ts'),
  'utf8',
);
const start = projection.indexOf('export function projectOperationalDetail(');
assert.ok(start >= 0, 'OPERATIONAL_DETAIL projection must exist');
const operationalDetail = projection.slice(start);
const primaryStart = operationalDetail.indexOf("table(\n        'operationalDetail'");
const attributionStart = operationalDetail.indexOf(
  "table(\n        'operationalDetailAttribution'",
);
assert.ok(primaryStart >= 0 && attributionStart > primaryStart);

function columnsBetween(tableStart: number, tableEnd: number) {
  const columnsStart = operationalDetail.indexOf('[', tableStart);
  const rowsStart = operationalDetail.indexOf('source.rows.map', columnsStart);
  const block = operationalDetail.slice(columnsStart, rowsStart < tableEnd ? rowsStart : tableEnd);
  return [...block.matchAll(/\{ key: '([^']+)', label: '([^']+)', type: (\w+) \}/g)].map(
    (match) => [match[1], match[2], match[3]] as const,
  );
}

const primaryColumns = columnsBetween(primaryStart, attributionStart);
const attributionColumns = columnsBetween(attributionStart, operationalDetail.length);
const attributionRowsStart = operationalDetail.indexOf(
  'source.rows.map',
  attributionStart,
);
const attributionRows = operationalDetail.slice(attributionRowsStart);

const expectedPrimaryKeys = [
  'engine', 'executionId', 'definitionItemId', 'definitionCode', 'responseId',
  'clientId', 'buildingId', 'templateId', 'templateCode', 'templateName',
  'status', 'startedAt', 'completedAt', 'sectionCode', 'sectionTitle',
  'sectionDisplayOrder', 'occurrenceIndex', 'label', 'type', 'displayOrder',
  'required', 'uomId', 'uomSymbol', 'minimumValue', 'maximumValue',
  'decimalPrecision', 'value', 'result', 'notes', 'isNa', 'naNotes',
  'optionCode', 'optionLabel', 'isNaAllowed', 'naRequiresNote',
  'responseCreatedAt', 'responseUpdatedAt', 'lastRespondedByUserId',
  'completedByUserId', 'assigneeType', 'assignedWorkforceProfileId',
  'assignedTeamId', 'assignmentSnapshotAt', 'verificationStatus',
  'verificationDecision', 'verificationReviewerUserId', 'verificationReviewedAt',
  'definitionMetadataAuthority', 'measurementMetadataAuthority', 'responseState',
];

const expectedAttributionColumns = [
  ['engine', 'Engine', 'STRING'],
  ['executionId', 'Execution ID', 'STRING'],
  ['definitionItemId', 'Definition Item ID', 'STRING'],
  ['responseId', 'Response ID', 'STRING'],
  ['occurrenceId', 'Occurrence ID', 'STRING'],
  ['completedByUserId', 'Completed By User ID', 'STRING'],
  ['completedByName', 'Completed By', 'STRING'],
  ['lastRespondedByUserId', 'Last Responded By User ID', 'STRING'],
  ['lastRespondedByName', 'Last Responded By', 'STRING'],
  ['verificationReviewerUserId', 'Verification Reviewer User ID', 'STRING'],
  ['verificationReviewerName', 'Verified By', 'STRING'],
  ['assigneeType', 'Assignee Type', 'STRING'],
  ['assignedWorkforceProfileId', 'Assigned Workforce Profile ID', 'STRING'],
  ['assignedWorkforceName', 'Assigned Workforce', 'STRING'],
  ['assignedTeamId', 'Assigned Team ID', 'STRING'],
  ['assignedTeamName', 'Assigned Team', 'STRING'],
  ['assignmentSnapshotAt', 'Assignment Snapshot At', 'DATE'],
];

describe('R09 PART 02D-E2 — attribution export table', () => {
  it('exposes exactly two tables and preserves the primary contract', () => {
    assert.equal((operationalDetail.match(/\n      table\(/g) ?? []).length, 2);
    assert.deepEqual(primaryColumns.map(([key]) => key), expectedPrimaryKeys);
    assert.equal(primaryColumns.length, 50);
    assert.equal(operationalDetail.match(/'operationalDetailAttribution'/g)?.length, 1);
    assert.match(types, /csvDefaultTableKey:\s*'operationalDetail'/);
  });

  it('defines exactly the frozen 17-column attribution contract', () => {
    assert.deepEqual(attributionColumns, expectedAttributionColumns);
    assert.equal(attributionColumns.length, 17);
    assert.ok(attributionColumns.length <= 50);
  });

  it('maps one attribution row directly from every neutral row', () => {
    assert.equal((operationalDetail.match(/source\.rows\.map\(/g) ?? []).length, 2);
    for (const [key] of expectedAttributionColumns) {
      assert.match(attributionRows, new RegExp(`${key}: row\\.${key}`));
    }
    assert.match(attributionRows, /source\.rows\.map\(\(row\) => \(\{/);
  });

  it('preserves nullable live presentation facts without fallbacks or authority reconstruction', () => {
    assert.doesNotMatch(attributionRows, /\?\?|\|\|/);
    assert.doesNotMatch(attributionRows, /COALESCE|fallback|synthetic|aggregate|dedup/i);
    assert.doesNotMatch(attributionRows, /getUser|getWorkforce|getTeam|find\(/i);
    for (const forbidden of [
      'Executor', 'Actual Executor', 'Executed By', 'Performed By',
      'Original Responder', 'Verification Decision Actor',
    ]) {
      assert.doesNotMatch(attributionRows, new RegExp(forbidden, 'i'));
    }
  });

  it('uses only safe presentation labels and keeps the E1 default untouched', () => {
    assert.match(attributionRows, /completedByName: row\.completedByName/);
    assert.match(attributionRows, /lastRespondedByName: row\.lastRespondedByName/);
    assert.match(attributionRows, /verificationReviewerName: row\.verificationReviewerName/);
    assert.match(attributionRows, /assignedWorkforceName: row\.assignedWorkforceName/);
    assert.match(attributionRows, /assignedTeamName: row\.assignedTeamName/);
    assert.match(types, /OPERATIONAL_DETAIL:[\s\S]*csvDefaultTableKey:\s*'operationalDetail'/);
  });
});
