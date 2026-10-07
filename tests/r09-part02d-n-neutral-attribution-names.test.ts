import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * R09 PART 02D-N — Neutral Attribution Name Propagation focused validation
 *
 * Static source assertions only. The neutral adapter must copy the five
 * already-authoritative physical presentation names without performing any
 * lookup, fallback, or authority reconstruction.
 */

const ROOT = process.cwd();
const TYPES_PATH = resolve(ROOT, 'src/modules/operational-detail-reporting/operational-detail-reporting.types.ts');
const SERVICE_PATH = resolve(ROOT, 'src/modules/operational-detail-reporting/operational-detail-reporting.service.ts');

const read = (path: string): string => readFileSync(path, 'utf8');
const types = read(TYPES_PATH);
const service = read(SERVICE_PATH);
const serviceCode = service
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');

function mapperSlice(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0, `${startMarker} must exist`);
  assert.ok(end > start, `${endMarker} must follow ${startMarker}`);
  return source.slice(start, end);
}

const checklistMapper = mapperSlice(
  service,
  'function mapChecklistRowToNeutral(',
  'function mapFormRowToNeutral(',
);
const formMapper = mapperSlice(
  service,
  'function mapFormRowToNeutral(',
  'export async function getOperationalDetail(',
);

const names = [
  'completedByName',
  'lastRespondedByName',
  'verificationReviewerName',
  'assignedWorkforceName',
  'assignedTeamName',
] as const;

const assignmentFacts = [
  'assigneeType',
  'assignedWorkforceProfileId',
  'assignedTeamId',
  'assignmentSnapshotAt',
] as const;

describe('R09 PART 02D-N — Neutral Attribution Name Propagation', () => {
  it('01 adds exactly five nullable neutral presentation fields', () => {
    for (const name of names) {
      assert.match(types, new RegExp(`${name}: string \\| null;`));
      assert.doesNotMatch(types, new RegExp(`${name}: string;`));
    }
  });

  it('02 preserves adjacent actor, assignment, and reviewer identity fields', () => {
    assert.match(
      types,
      /lastRespondedByUserId: string \| null;[\s\S]*lastRespondedByName: string \| null;/,
    );
    assert.match(
      types,
      /completedByUserId: string \| null;[\s\S]*completedByName: string \| null;/,
    );
    assert.match(
      types,
      /assignedWorkforceProfileId: string \| null;[\s\S]*assignedWorkforceName: string \| null;[\s\S]*assignedTeamId: string \| null;[\s\S]*assignedTeamName: string \| null;[\s\S]*assignmentSnapshotAt: string \| null;/,
    );
    assert.match(
      types,
      /verificationReviewerUserId: string \| null;[\s\S]*verificationReviewerName: string \| null;/,
    );
  });

  it('03 checklist mapper directly copies all five physical names', () => {
    for (const name of names) {
      assert.match(checklistMapper, new RegExp(`${name}: row\\.${name},`));
    }
  });

  it('04 form mapper directly copies all five physical names', () => {
    for (const name of names) {
      assert.match(formMapper, new RegExp(`${name}: row\\.${name},`));
    }
  });

  it('05 preserves existing actor IDs and assignment snapshot facts in both mappers', () => {
    for (const mapper of [checklistMapper, formMapper]) {
      assert.match(mapper, /lastRespondedByUserId: row\.lastRespondedByUserId,/);
      assert.match(mapper, /completedByUserId: row\.completedByUserId,/);
      assert.match(mapper, /verificationReviewerUserId: row\.verificationReviewerUserId,/);
      for (const fact of assignmentFacts) {
        assert.match(mapper, new RegExp(`${fact}: row\\.${fact},`));
      }
    }
  });

  it('06 contains no fallback, synthesis, or lookup in either mapper', () => {
    for (const mapper of [checklistMapper, formMapper]) {
      assert.doesNotMatch(mapper, /COALESCE|\|\||\?\?/);
      assert.doesNotMatch(mapper, /\+\s*row\.|String\(|concat|join\(/i);
      assert.doesNotMatch(mapper, /email|display_name|full_name|teams?\.|organizations?\./i);
    }
  });

  it('07 neutral service performs no SQL or authority lookup', () => {
    assert.doesNotMatch(serviceCode, /getPool|\bSELECT\b|COALESCE|LEFT JOIN|JOIN\s/);
    assert.doesNotMatch(serviceCode, /workforce_profiles|organizations|teams\b|users\b/i);
    assert.doesNotMatch(serviceCode, /operationalDetailAttribution|csvDefaultTableKey|reporting-export/);
  });

  it('08 preserves neutral grain and physical occurrence semantics', () => {
    for (const mapper of [checklistMapper, formMapper]) {
      assert.match(mapper, /executionId:/);
      assert.match(mapper, /definitionItemId:/);
      assert.match(mapper, /responseId:/);
      assert.match(mapper, /occurrenceId:/);
      assert.match(mapper, /occurrenceIndex:/);
    }
    assert.match(service, /rows: rows\.map\(mapChecklistRowToNeutral\)/);
    assert.match(service, /rows: rows\.map\(mapFormRowToNeutral\)/);
    assert.doesNotMatch(service, /DISTINCT|GROUP BY|ROW_NUMBER|\.filter\(/);
  });

  it('09 preserves existing neutral identification, UOM, response, and verification mapping', () => {
    for (const mapper of [checklistMapper, formMapper]) {
      assert.match(mapper, /definitionCode: row\.definitionCode,/);
      assert.match(mapper, /templateId: row\.(?:templateId|formTemplateId),/);
      assert.match(mapper, /templateCode: row\.templateCode,/);
      assert.match(mapper, /templateName: row\.templateName,/);
      assert.match(mapper, /uomId: row\.uomId,/);
      assert.match(mapper, /uomName: row\.uomName,/);
      assert.match(mapper, /uomSymbol: row\.uomSymbol,/);
      assert.match(mapper, /responseCreatedAt: row\.responseCreatedAt,/);
      assert.match(mapper, /responseUpdatedAt: row\.responseUpdatedAt,/);
      assert.match(mapper, /verificationStatus: row\.verificationStatus,/);
      assert.match(mapper, /verificationDecision: row\.verificationDecision,/);
    }
  });

  it('10 documents all names as current live presentation metadata', () => {
    for (const name of names) {
      const line = types.split('\n').find((candidate) => candidate.includes(`${name}:`)) ?? '';
      assert.match(line, /CURRENT LIVE FACT/);
      assert.match(line, /NOT (?:a )?historical(?: assignment)? snapshot/);
    }
    assert.match(types, /R09 PART 02D-N attribution presentation/);
    assert.match(types, /propagated verbatim from physical/);
  });

  it('11 documents assignment names as assignment targets, not executor facts', () => {
    assert.match(types, /Assigned Workforce/);
    assert.match(types, /Assigned Team/);
    assert.match(types, /not executor or performed-by facts/);
    assert.match(types, /NOT an actual executor/);
  });

  it('12 keeps export architecture completely out of the neutral layer', () => {
    assert.doesNotMatch(types, /reporting-export|operationalDetailAttribution|csvDefaultTableKey/);
    assert.doesNotMatch(service, /reporting-export|operationalDetailAttribution|csvDefaultTableKey/);
  });
});
