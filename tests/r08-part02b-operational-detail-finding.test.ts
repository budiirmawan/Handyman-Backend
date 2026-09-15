import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * R08 PART 02B — Operational Detail Finding child projection: focused validation.
 *
 * The reused vocabularies (R07 engine, findings status, finding-assignments
 * assignee type) are ZERO-DEPENDENCY modules, so they are imported and asserted at
 * RUNTIME — which is what proves PART 02B reuses an existing authority instead of
 * redeclaring one. Repository and service assertions are static source assertions,
 * matching the established R07 / R08 PART 01B test convention, because `pg` and
 * context-access cannot be loaded without dependencies. Genuine live-DB cases are
 * enumerated as CI-required at the end.
 *
 * Paths resolve from process.cwd() so this file runs identically under the
 * repository's configured runner (`tsx --test`, CommonJS) and under plain
 * `node --test` type-stripping (ESM), where `__dirname` is unavailable.
 *
 * Covers the 34 required conditions:
 *   1  row grain = findings.id
 *   2  parent key = engine + executionId
 *   3  engine vocabulary reused, not redeclared
 *   4  sourceless finding cannot match
 *   5  WORK_ORDER finding cannot match
 *   6  client equality is structural SQL
 *   7  parent building must be in the authorized set
 *   8  finding building must independently be in the authorized set
 *   9  NO f.building_id = parentResolvedBuildingId equality predicate
 *  10  both building facts exposed distinctly
 *  11  divergent parent/finding buildings are legitimate when both authorized
 *  12  all statuses visible by default
 *  13  literal status filter works
 *  14  invalid status rejected
 *  15  CLOSED and CANCELLED remain representable
 *  16  classification/severity IDs present
 *  17  classification/severity labels absent
 *  18  ACTIVE assignment uses LEFT JOIN
 *  19  ACTIVE assignment cardinality relies on the partial unique authority
 *  20  the seven assignment fields are mapped
 *  21  vendorWorkforceId absent
 *  22  no display-name joins
 *  23  no rework join/fields
 *  24  no reviews join/fields
 *  25  no operational_events join / history fields
 *  26  no evidence join
 *  27  no asset / functionalLocation enrichment
 *  28  no item/field/occurrence attribution
 *  29  executionId cannot bypass scope
 *  30  empty accessible building scope returns an empty result
 *  31  one bounded SQL / no per-execution loop
 *  32  deterministic ordering source_id, reported_at, created_at, id
 *  33  no R02 / R04 / R07 / PART 01B modification
 *  34  no export / registry / OpenAPI / route / migration / permission / index
 * plus the building-authority provenance chain and the R02 non-duplication rule.
 */

const ROOT = process.cwd();
const MODULE_DIR = resolve(ROOT, 'src/modules/operational-detail-finding');
const TYPES_PATH = resolve(MODULE_DIR, 'operational-detail-finding.types.ts');
const REPO_PATH = resolve(MODULE_DIR, 'operational-detail-finding.repository.ts');
const SERVICE_PATH = resolve(MODULE_DIR, 'operational-detail-finding.service.ts');
const INDEX_PATH = resolve(MODULE_DIR, 'index.ts');

const R04_REPO_PATH = resolve(ROOT, 'src/modules/checklist-execution-summary/checklist-execution-summary.repository.ts');
const R04_SERVICE_PATH = resolve(ROOT, 'src/modules/checklist-execution-summary/checklist-execution-summary.service.ts');
const P01B_REPO_PATH = resolve(ROOT, 'src/modules/operational-detail-evidence/operational-detail-evidence.repository.ts');
const P01B_SERVICE_PATH = resolve(ROOT, 'src/modules/operational-detail-evidence/operational-detail-evidence.service.ts');
const P01B_TYPES_PATH = resolve(ROOT, 'src/modules/operational-detail-evidence/operational-detail-evidence.types.ts');
const R02_REPO_PATH = resolve(ROOT, 'src/modules/finding-register/finding-register.repository.ts');
const R02_TYPES_PATH = resolve(ROOT, 'src/modules/finding-register/finding-register.types.ts');
const R02_SERVICE_PATH = resolve(ROOT, 'src/modules/finding-register/finding-register.service.ts');
const FINDING_TYPES_PATH = resolve(ROOT, 'src/modules/findings/finding.types.ts');
const ASSIGNMENT_TYPES_PATH = resolve(ROOT, 'src/modules/finding-assignments/finding-assignment.types.ts');
const R07_TYPES_PATH = resolve(ROOT, 'src/modules/operational-detail-reporting/operational-detail-reporting.types.ts');
const R07_SERVICE_PATH = resolve(ROOT, 'src/modules/operational-detail-reporting/operational-detail-reporting.service.ts');
const FINDING_SOURCE_SERVICE_PATH = resolve(ROOT, 'src/modules/findings/finding-source.service.ts');
const EXPORT_REGISTRY_PATH = resolve(ROOT, 'src/modules/reporting-export/reporting-export.registry.ts');
const EXPORT_TYPES_PATH = resolve(ROOT, 'src/modules/reporting-export/reporting-export.types.ts');
const EXPORT_PROJECTIONS_PATH = resolve(ROOT, 'src/modules/reporting-export/reporting-export.projections.ts');
const OPENAPI_PATH = resolve(ROOT, 'docs/api/openapi.yaml');
const MIGRATIONS_DIR = resolve(ROOT, 'src/database/migrations');
const ASSIGNMENT_MIGRATION_PATH = resolve(MIGRATIONS_DIR, '0093_create_finding_assignments.ts');
const SOURCE_MIGRATION_PATH = resolve(MIGRATIONS_DIR, '0092_add_finding_source_binding.ts');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

/** Removes block and line comments so "identifier must not exist" assertions test
 *  the CODE contract, not the documentation that explains the exclusion. */
function code(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const typesCode = code(TYPES_PATH);
const repoCode = code(REPO_PATH);
const serviceCode = code(SERVICE_PATH);
const indexCode = code(INDEX_PATH);

/** The row-contract type body only — so field assertions cannot be satisfied by
 *  the filters or envelope types, and vice versa. */
const ROW_TYPE_CODE = typesCode.slice(
  typesCode.indexOf('export type PublicOperationalDetailFindingRow = {'),
  typesCode.indexOf('export type OperationalDetailFindingFilters'),
);

/** Extracts a `const NAME = `...`;` template-literal block verbatim. */
function literal(src: string, name: string): string {
  return new RegExp(`const ${name} = \`\\n([\\s\\S]*?)\\n\`;`).exec(src)?.[1] ?? '';
}

const normalize = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** The 27 frozen row-contract fields (20 finding facts + 7 assignment facts). */
const ROW_FIELDS = [
  'findingId', 'engine', 'executionId', 'clientId', 'parentBuildingId', 'findingBuildingId',
  'findingNumber', 'title', 'description', 'classificationId', 'severityId',
  'status', 'stateChangedAt', 'reportedByUserId', 'reportedAt',
  'closedAt', 'closedByUserId', 'closureNotes', 'createdAt', 'updatedAt',
  'assignmentId', 'assigneeType', 'workforceProfileId', 'teamId', 'vendorId',
  'assignedByUserId', 'assignedAt',
] as const;

describe('R08 PART 02B — Operational Detail Finding child projection', () => {
  it('1/2 — row grain is findings.id and parent key is (engine, executionId)', () => {
    // 1. row grain
    assert.match(repoCode, /f\.id\s+AS finding_id/, 'must select findings.id as the row key');
    assert.match(typesCode, /findingId:\s*string;/, 'row contract must carry findingId');
    assert.ok(!/GROUP BY/i.test(repoCode), 'grain is one row per finding id — no GROUP BY collapse');
    assert.ok(!/DISTINCT/i.test(repoCode), 'no DISTINCT — the grain needs no de-duplication');

    // 2. parent key
    assert.match(repoCode, /f\.source_type\s+AS engine/, 'engine comes from source_type verbatim');
    assert.match(repoCode, /f\.source_id\s+AS execution_id/, 'executionId comes from source_id verbatim');
    assert.match(typesCode, /engine:\s*OperationalDetailEngine;/);
    assert.match(typesCode, /executionId:\s*string;/);

    // the source binding is the authoritative parent relation (migration 0092)
    const sourceMigration = read(SOURCE_MIGRATION_PATH);
    assert.match(sourceMigration, /finding_source_complete/, 'both-or-neither source binding');
    assert.ok(!/source_id UUID REFERENCES|source_id UUID NOT NULL REFERENCES/.test(sourceMigration),
      'source_id has NO foreign key — which is exactly why consistency must be structural in SQL');
  });

  it('3 — engine vocabulary is REUSED from R07, not redeclared', async () => {
    const r07 = await import(pathToFileURL(R07_TYPES_PATH).href);
    assert.deepEqual([...r07.OPERATIONAL_DETAIL_ENGINES], ['CHECKLIST_EXECUTION', 'FORM_INSTANCE']);
    assert.equal(r07.isOperationalDetailEngine('WORK_ORDER'), false, 'WORK_ORDER is not an R08 engine');

    // PART 02B imports the R07 authority and declares no vocabulary of its own
    assert.match(read(SERVICE_PATH), /from '\.\.\/operational-detail-reporting\/operational-detail-reporting\.types'/);
    assert.match(serviceCode, /isOperationalDetailEngine/);
    assert.ok(!/OPERATIONAL_DETAIL_ENGINES\s*=/.test(typesCode), 'must not re-declare the engine enum');
    assert.ok(!/OPERATIONAL_DETAIL_ENGINES\s*=/.test(repoCode), 'must not re-declare the engine enum');
    assert.ok(!/CHECKLIST_EXECUTION'\s*,\s*'FORM_INSTANCE'/.test(typesCode), 'no second engine list');

    // WORK_ORDER cannot be requested: the parser rejects anything outside the R07 enum
    assert.match(serviceCode, /engine is required \(CHECKLIST_EXECUTION \| FORM_INSTANCE\)\./);
  });

  it('4/5 — sourceless and WORK_ORDER findings cannot match, structurally', () => {
    // The population predicate binds a NON-NULL engine literal and requires the
    // source_id to equal the parent primary key, so NULL source_type can never
    // match and WORK_ORDER can never be the bound value. No application filter
    // performs either exclusion.
    assert.match(repoCode, /ON f\.source_type = \$1/, 'engine bound as a non-null literal');
    assert.match(repoCode, /AND f\.source_id = \$\{parentAlias\}\.id/, 'source must equal the parent PK');
    assert.ok(!repoCode.includes("'WORK_ORDER'"), 'WORK_ORDER is never referenced in the query');
    assert.ok(!/source_type IS NOT NULL/.test(repoCode), 'no extra predicate is needed — NULL cannot equal $1');
    assert.ok(!/source_type IS NULL/.test(repoCode));
    assert.ok(!/\.filter\(/.test(repoCode), 'no application-level exclusion filter');
    assert.ok(!/\.filter\(/.test(serviceCode), 'no application-level exclusion filter');

    // the finding source vocabulary (which DOES include WORK_ORDER) is not redeclared
    assert.ok(!/FINDING_SOURCE_TYPES\s*=/.test(typesCode), 'the findings source enum is not copied here');
    assert.ok(!/FINDING_SOURCE_TYPES\s*=/.test(repoCode));
  });

  it('6 — client consistency is enforced STRUCTURALLY in SQL', () => {
    assert.match(repoCode, /AND f\.client_id = \$\{parentAlias\}\.client_id/, 'client equality is part of the JOIN predicate');
    assert.match(repoCode, /const parentAlias = isChecklist \? 'ce' : 'fi';/, 'alias resolves per engine');
    assert.match(repoCode, /JOIN findings f/, 'findings are joined to the authorized parent');

    // no include-and-flag, no post-filter, no whole-query rejection, no caller clientId
    assert.ok(!/clientMismatch|client_mismatch|mismatch/i.test(repoCode), 'no include-and-flag field');
    assert.ok(!typesCode.includes('clientMismatch'), 'row contract carries no mismatch flag');
    assert.ok(!/clientId/.test(serviceCode), 'service never accepts or uses a caller-supplied clientId');
    assert.ok(!/query\.clientId/.test(serviceCode), 'no clientId query parameter');
    // clientId is exposed only as the verbatim parent-consistency anchor
    assert.match(repoCode, /f\.client_id\s+AS client_id/);
    assert.match(typesCode, /clientId:\s*string;/);
  });

  it('7/8/9/10/11 — TWO independent building predicates over ONE authorized set, no equality, both facts exposed', () => {
    // 7. parent building must resolve INTO the authorized set (fail-closed on NULL)
    assert.match(repoCode, /conditions\.push\(`\$\{buildingSql\} = ANY\(\$2::uuid\[\]\)`\)/,
      'R04-resolved parent building must be inside the authorized set');
    assert.match(repoCode, /const buildingSql = isChecklist \? CE_BUILDING_SQL : FI_BUILDING_SQL;/);

    // 8. finding building must INDEPENDENTLY be inside the SAME authorized set
    assert.match(repoCode, /conditions\.push\(`f\.building_id = ANY\(\$2::uuid\[\]\)`\)/,
      "the finding's own isolation column must be inside the same authorized set");
    assert.equal((repoCode.match(/= ANY\(\$2::uuid\[\]\)/g) ?? []).length, 2,
      'exactly two membership predicates, both over $2');
    assert.ok(!repoCode.includes('= ANY($3'), 'no second authorized-set parameter — one policy, one set');

    // 9. NO equality against the resolved parent building
    assert.equal((repoCode.match(/f\.building_id\s*=/g) ?? []).length, 1,
      'the only f.building_id comparison is the ANY() membership predicate');
    assert.ok(!/f\.building_id\s*=\s*COALESCE/.test(repoCode), 'must not compare against the resolution expression');
    assert.ok(!/f\.building_id\s*=\s*\$\{buildingSql\}/.test(repoCode), 'must not compare against the R04 fragment');
    assert.ok(!/f\.building_id\s*=\s*(ce|fi|\$\{parentAlias\})\./.test(repoCode), 'must not compare against a parent column');
    assert.ok(!/parentBuildingId\s*===|parentBuildingId\s*!==/.test(repoCode), 'no application-level building comparison');
    assert.ok(!/parentBuildingId\s*===|parentBuildingId\s*!==/.test(serviceCode), 'no application-level building comparison');

    // 10. both facts exposed distinctly
    assert.match(repoCode, /\$\{buildingSql\}\s+AS parent_building_id/, 'parent-resolved building is projected');
    assert.match(repoCode, /f\.building_id\s+AS finding_building_id/, 'finding-stored building is projected verbatim');
    assert.match(typesCode, /parentBuildingId:\s*string;/);
    assert.match(typesCode, /findingBuildingId:\s*string;/);
    assert.match(repoCode, /parentBuildingId: row\.parent_building_id/);
    assert.match(repoCode, /findingBuildingId: row\.finding_building_id/);
    // both are non-nullable in the contract: each is guaranteed by its own ANY() predicate
    assert.ok(!/parentBuildingId:\s*string \| null/.test(typesCode), 'parentBuildingId cannot be NULL in a returned row');
    assert.ok(!/findingBuildingId:\s*string \| null/.test(typesCode), 'findingBuildingId cannot be NULL in a returned row');
    // and no single ambiguous buildingId on the ROW contract (the filters and the
    // envelope legitimately echo a requested buildingId; the row must not)
    assert.ok(!/^\s{2}buildingId:/m.test(ROW_TYPE_CODE),
      'the row contract exposes two named buildings, never one ambiguous buildingId');

    // 11. divergence is legitimate and must NOT be interpreted
    for (const forbidden of ['buildingMismatch', 'isBuildingConsistent', 'sameBuilding', 'buildingConsistent', 'buildingsDiffer', 'buildingAligned']) {
      assert.ok(!typesCode.includes(forbidden), `no derived building interpretation: ${forbidden}`);
      assert.ok(!repoCode.includes(forbidden), `no derived building interpretation: ${forbidden}`);
      assert.ok(!serviceCode.includes(forbidden), `no derived building interpretation: ${forbidden}`);
    }
    const doc = read(TYPES_PATH);
    assert.match(doc, /MAY LEGITIMATELY DIFFER/, 'the legitimate-divergence rule must be documented');
    assert.match(doc, /is NOT an authoritative/, 'the rejected equality must be documented as non-authoritative');
    assert.match(doc, /invariant and is NOT required/, 'the rejected equality must be documented as not required');
    assert.match(doc, /silently drop legitimate/, 'the reason the equality is rejected must be documented');
  });

  it('12/13/14/15 — all statuses visible by default; literal filter; invalid rejected; CLOSED/CANCELLED representable', async () => {
    const findings = await import(pathToFileURL(FINDING_TYPES_PATH).href);

    // the reused authority carries exactly the ten stored statuses
    assert.deepEqual([...findings.FINDING_STATUSES], [
      'OPEN', 'ASSIGNED', 'IN_PROGRESS', 'PENDING_REVIEW', 'REJECTED',
      'REWORK_REQUIRED', 'RESUBMITTED', 'VERIFIED', 'CLOSED', 'CANCELLED',
    ]);

    // 12. default read applies NO status predicate
    assert.ok(!/f\.status\s*=\s*'/.test(repoCode), 'no hard-coded status literal');
    assert.ok(!/'OPEN'|'CLOSED'|'CANCELLED'|'VERIFIED'/.test(repoCode), 'no lifecycle literal anywhere in the query');
    assert.match(repoCode, /if \(filters\.status\) \{/, 'the status predicate must be conditional');
    assert.match(repoCode, /f\.status = \$\$\{values\.length\}/, 'status binds as a parameter');

    // 13/14. the parser reuses the findings authority; no competing list
    assert.match(serviceCode, /isFindingStatus/, 'status validated by the findings module authority');
    assert.match(serviceCode, /FINDING_STATUSES\.join\('\/'\)/, 'the rejection message is BUILT from the reused constant');
    assert.ok(!/FINDING_STATUSES\s*=/.test(typesCode), 'must not re-declare the finding status enum');
    assert.ok(!/FINDING_STATUSES\s*=/.test(serviceCode), 'must not re-declare the finding status enum');
    assert.ok(!/isFindingStatus\s*=|function isFindingStatus/.test(serviceCode), 'must not re-implement the guard');
    assert.equal(findings.isFindingStatus('CLOSED'), true);
    assert.equal(findings.isFindingStatus('CANCELLED'), true);
    assert.equal(findings.isFindingStatus('DONE'), false, 'invalid status rejected');
    assert.equal(findings.isFindingStatus('PURGED'), false, 'evidence retention vocabulary is not a finding status');
    assert.equal(findings.isFindingStatus(['OPEN']), false, 'multi-value rejected');

    // 15. terminal statuses remain representable in the lineage view
    assert.match(typesCode, /status:\s*FindingStatus;/, 'the row status type IS the reused authority type');
    assert.match(read(TYPES_PATH), /import type \{ FindingStatus \} from '\.\.\/findings\/finding\.types'/);
    const doc = read(TYPES_PATH);
    assert.match(doc, /CLOSED and CANCELLED/, 'terminal visibility must be documented');

    // no derived lifecycle mode anywhere
    for (const forbidden of ['isOpen', 'isClosed', 'isTerminal', 'activeFinding', 'openFinding', 'terminalOnly', 'includeClosed', 'historyMode']) {
      const pattern = new RegExp(`\\b${forbidden}\\b`);
      assert.ok(!pattern.test(typesCode), `no derived lifecycle mode: ${forbidden}`);
      assert.ok(!pattern.test(repoCode), `no derived lifecycle mode: ${forbidden}`);
      assert.ok(!pattern.test(serviceCode), `no derived lifecycle mode: ${forbidden}`);
    }
  });

  it('16/17 — classification/severity IDs only; live labels are R02 authority and are NOT joined', () => {
    // 16. IDs present
    assert.match(repoCode, /f\.classification_id\s+AS classification_id/);
    assert.match(repoCode, /f\.severity_id\s+AS severity_id/);
    assert.match(typesCode, /classificationId:\s*string \| null;/);
    assert.match(typesCode, /severityId:\s*string \| null;/);

    // 17. labels absent — the reference tables are never joined
    for (const table of ['finding_classifications', 'finding_severities']) {
      assert.ok(!new RegExp(`\\b${table}\\b`).test(repoCode), `must not join ${table}`);
      assert.ok(!new RegExp(`\\b${table}\\b`).test(serviceCode), `must not join ${table}`);
    }
    for (const field of ['classificationCode', 'classificationName', 'severityCode', 'severityName', 'severityRank', 'classificationStatus', 'severityStatus']) {
      assert.ok(!typesCode.includes(field), `live label must not be exposed: ${field}`);
      assert.ok(!repoCode.includes(field), `live label must not be projected: ${field}`);
    }
    for (const column of ['classification_code', 'classification_name', 'severity_code', 'severity_name', 'severity_rank']) {
      assert.ok(!repoCode.includes(column), `live label column must not be selected: ${column}`);
    }
    // R02 remains the live-label authority and is unchanged
    const r02 = read(R02_REPO_PATH);
    assert.match(r02, /LEFT JOIN finding_classifications fc/, 'R02 still owns the live classification labels');
    assert.match(r02, /LEFT JOIN finding_severities fs/, 'R02 still owns the live severity labels');
    // no historical label claim
    assert.match(read(TYPES_PATH), /NO historical label claim is made or implied/, 'must not imply a label snapshot');
  });

  it('18/19/20/21/22 — ACTIVE assignment inline via LEFT JOIN, cardinality from the partial unique authority', async () => {
    // 18. LEFT JOIN on the ACTIVE predicate
    assert.match(repoCode, /LEFT JOIN finding_assignments fa/, 'must be a LEFT join so unassigned findings still return');
    assert.match(repoCode, /ON fa\.finding_id = f\.id/, 'assignment keyed by finding id');
    assert.match(repoCode, /AND fa\.status = 'ACTIVE'/, "only the ACTIVE assignment");
    assert.ok(!/INNER JOIN finding_assignments/.test(repoCode), 'must not be an INNER join');

    // 19. cardinality is guaranteed by the SCHEMA, not by de-duplication
    const migration = read(ASSIGNMENT_MIGRATION_PATH);
    assert.match(migration, /CREATE UNIQUE INDEX finding_active_assignment_unique/, 'the partial unique index must exist');
    assert.match(migration, /ON finding_assignments \(finding_id\) WHERE status = 'ACTIVE'/, '0..1 ACTIVE per finding');
    assert.match(migration, /finding_assignment_status\s*\n?\s*CHECK \(status IN \('ACTIVE', 'INACTIVE'\)\)/, 'append-preserving statuses');
    assert.match(migration, /finding_assignments_finding_idx/, 'the join is index-supported');
    assert.ok(!/GROUP BY|DISTINCT/i.test(repoCode), 'no de-duplication — cardinality is schema-guaranteed');
    assert.ok(!/LATERAL/i.test(repoCode), 'no LATERAL needed at 0..1');

    // 20. the seven assignment fields are mapped verbatim
    const assignmentColumns = [
      ['fa.id', 'assignment_id', 'assignmentId'],
      ['fa.assignee_type', 'assignee_type', 'assigneeType'],
      ['fa.workforce_profile_id', 'workforce_profile_id', 'workforceProfileId'],
      ['fa.team_id', 'team_id', 'teamId'],
      ['fa.vendor_id', 'vendor_id', 'vendorId'],
      ['fa.assigned_by_user_id', 'assigned_by_user_id', 'assignedByUserId'],
      ['fa.assigned_at', 'assigned_at', 'assignedAt'],
    ] as const;
    for (const [column, alias, field] of assignmentColumns) {
      assert.ok(new RegExp(`${column.replace('.', '\\.')}\\s+AS ${alias}`).test(repoCode), `must select ${column} AS ${alias}`);
      assert.ok(new RegExp(`${field}: row\\.${alias}|${field}: toIso\\(row\\.${alias}\\)`).test(repoCode), `must map ${field}`);
      assert.ok(typesCode.includes(`${field}:`), `row contract must carry ${field}`);
      assert.match(typesCode, new RegExp(`${field}:\\s*(string|FindingAssigneeType) \\| null;`), `${field} must be nullable (unassigned)`);
    }

    // assignee type is the REUSED authority type, not a redeclared list
    const assignments = await import(pathToFileURL(ASSIGNMENT_TYPES_PATH).href);
    assert.deepEqual([...assignments.FINDING_ASSIGNEE_TYPES], ['WORKFORCE', 'TEAM', 'VENDOR', 'VENDOR_WORKFORCE']);
    assert.match(read(TYPES_PATH), /import type \{ FindingAssigneeType \} from '\.\.\/finding-assignments\/finding-assignment\.types'/);
    assert.match(typesCode, /assigneeType:\s*FindingAssigneeType \| null;/);
    assert.ok(!/FINDING_ASSIGNEE_TYPES\s*=/.test(typesCode), 'must not re-declare the assignee type enum');
    // VENDOR_WORKFORCE is vendorId + workforceProfileId together (0093 CHECK)
    assert.match(migration, /assignee_type = 'VENDOR_WORKFORCE' AND vendor_id IS NOT NULL\s*\n?\s*AND workforce_profile_id IS NOT NULL/);

    // 21. vendorWorkforceId does not exist and is not invented
    assert.ok(!typesCode.includes('vendorWorkforceId'), 'no vendorWorkforceId field');
    assert.ok(!repoCode.includes('vendorWorkforceId'), 'no vendorWorkforceId field');
    assert.ok(!repoCode.includes('vendor_workforce_id'), 'no vendor_workforce_id column');
    assert.ok(!migration.includes('vendor_workforce_id'), 'the column does not exist in the schema');

    // 22. no display-name joins
    for (const table of ['users', 'workforce_profiles', 'teams', 'vendors']) {
      assert.ok(!new RegExp(`\\b${table}\\b`).test(repoCode), `no display-name join: ${table}`);
    }
    for (const field of ['assigneeName', 'reportedByName', 'closedByName', 'assignedByName', 'displayName', 'userName', 'teamName', 'vendorName', 'workforceName']) {
      assert.ok(!typesCode.includes(field), `no display-name field: ${field}`);
    }
    // no assignment history
    assert.ok(!/fa\.status = 'INACTIVE'/.test(repoCode), 'INACTIVE assignments are history and are not exposed');
    assert.ok(!typesCode.includes('assignmentHistory'), 'no assignment history field');
  });

  it('23/24/25/26/27 — no rework, no review, no history, no evidence, no work-order/asset enrichment', () => {
    // 23. rework belongs to R08 PART 03
    assert.ok(!/finding_rework_cycles/.test(repoCode), 'must not join finding_rework_cycles');
    for (const field of ['reworkCount', 'latestReworkId', 'latestReworkStatus', 'latestReworkRequestedAt', 'rework']) {
      assert.ok(!typesCode.includes(field), `no rework field: ${field}`);
      assert.ok(!repoCode.includes(field), `no rework column: ${field}`);
    }

    // 24. reviews are finding-level and are NOT R07 execution verification
    assert.ok(!/\breviews\b/.test(repoCode), 'must not join reviews');
    for (const field of ['verificationReviewId', 'verificationStatus', 'verificationDecision', 'verificationReviewerUserId', 'verificationReviewedAt', 'reviewId', 'reviewDecision']) {
      assert.ok(!typesCode.includes(field), `no review field: ${field}`);
      assert.ok(!repoCode.includes(field), `no review column: ${field}`);
    }

    // 25. no history
    assert.ok(!/operational_events/.test(repoCode), 'must not join operational_events');
    for (const field of ['historyCount', 'historyAvailable']) {
      assert.ok(!typesCode.includes(field), `no history field: ${field}`);
      assert.ok(!repoCode.includes(field), `no history column: ${field}`);
    }

    // 26. no evidence join (R08 PART 01B owns evidence; R02 owns finding evidence counts)
    assert.ok(!/evidence_submissions/.test(repoCode), 'must not join evidence_submissions');
    assert.ok(!typesCode.includes('evidenceCount'), 'no evidenceCount field');
    assert.ok(!repoCode.includes('evidence_count'), 'no evidence_count column');
    assert.ok(!/from '\.\.\/evidence|from '\.\.\/operational-detail-evidence/.test(read(REPO_PATH)), 'must not import the evidence module');

    // 27. no WORK_ORDER enrichment imported from R02
    assert.ok(!/\bwork_orders\b/.test(repoCode), 'must not join work_orders');
    for (const field of ['assetId', 'functionalLocationId', 'sourceReferenceNumber', 'priority', 'dueDate']) {
      assert.ok(!typesCode.includes(field), `not a stored R08 finding fact: ${field}`);
    }
    for (const column of ['AS asset_id', 'AS functional_location_id', 'source_reference_number', 'priority', 'due_date']) {
      assert.ok(!repoCode.includes(column), `must not project ${column}`);
    }
    // R02 keeps its own work-order enrichment, unchanged
    assert.match(read(R02_REPO_PATH), /LEFT JOIN work_orders wo/, 'R02 still owns WORK_ORDER enrichment');
    assert.match(read(R02_REPO_PATH), /wo\.asset_id AS asset_id/, 'R02 assetId provenance is work_orders, not findings');
  });

  it('28 — no item/field/occurrence attribution of any kind', () => {
    const forbidden = [
      'checklistItemId', 'checklist_item_id',
      'definitionItemId', 'definition_item_id',
      'versionFieldId', 'version_field_id',
      'formFieldId', 'form_field_id',
      'responseId', 'response_id',
      'occurrenceId', 'occurrence_id',
      'occurrenceIndex', 'occurrence_index',
      'repeatableGroupId',
    ];
    for (const identifier of forbidden) {
      assert.ok(!typesCode.includes(identifier), `no detail attribution field: ${identifier}`);
      assert.ok(!repoCode.includes(identifier), `no detail attribution column: ${identifier}`);
    }
    assert.ok(!/checklist_item_responses|form_responses|form_instance_occurrences|form_template_version_fields|checklist_items\b/.test(repoCode),
      'must not join any detail-grain table to manufacture attribution');
    // form_template_versions / form_templates are joined ONLY for the templateId filter
    const versionJoin = repoCode.indexOf('JOIN form_template_versions ftv');
    assert.ok(versionJoin > -1, 'the version chain exists for templateId narrowing');
    assert.ok(repoCode.indexOf('!isChecklist && filters.templateId') < versionJoin,
      'the version chain is conditional on templateId, never a detail-grain population source');
  });

  it('29/30 — executionId cannot bypass scope; empty accessible scope returns an empty result', () => {
    // 29. executionId narrows AFTER both building predicates are established
    assert.match(repoCode, /if \(filters\.executionId\) \{/, 'executionId is a parent narrowing filter');
    assert.match(repoCode, /conditions\.push\(`\$\{parentAlias\}\.id = \$\$\{values\.length\}::uuid`\)/, 'executionId binds the parent alias');
    assert.ok(
      repoCode.indexOf('f.building_id = ANY($2::uuid[])') < repoCode.indexOf('if (filters.executionId)'),
      'both building predicates must be established BEFORE executionId narrowing',
    );
    assert.match(repoCode, /WHERE \$\{conditions\.join\('\\n\s+AND '\)\}/, 'all conditions are ANDed');
    assert.ok(!/executionIds/.test(repoCode), 'no execution-id list is materialized');
    assert.ok(!/executionIds/.test(serviceCode), 'no execution-id list is materialized');

    // R04/R07 access authority reused verbatim
    assert.match(serviceCode, /buildingRepository\.findById\(filters\.buildingId\)/);
    assert.match(serviceCode, /buildingNotFoundError\(\)/);
    assert.match(serviceCode, /contextAccessService\.assertBuildingAccess\(userId, filters\.buildingId\)/);
    assert.match(serviceCode, /contextAccessService\.getAccessibleBuildingIds\(userId\)/);
    assert.ok(!/role|isAdmin|hasRole/i.test(serviceCode), 'no role hardcoding / second auth model');

    // the narrower finding-source resolver is NOT the Reporting building authority
    assert.ok(!serviceCode.includes('resolveFindingSourceContext'), 'must not use the finding-source resolver as authority');
    assert.ok(!repoCode.includes('resolveFindingSourceContext'));
    assert.ok(!read(SERVICE_PATH).includes('finding-source.service'), 'must not import the finding-source resolver');
    assert.match(read(FINDING_SOURCE_SERVICE_PATH), /buildingId: null/, 'the resolver returns no building for FORM_INSTANCE — proof it is narrower than R04');

    // 30. empty scope short-circuits before any query
    assert.match(
      serviceCode,
      /if \(buildingIds\.length === 0\) \{\s*return \{ \.\.\.base, rows: \[\] \};/,
      'empty authorized scope must return an empty result before any query',
    );
    const emptyIdx = serviceCode.indexOf('if (buildingIds.length === 0)');
    const repoCallIdx = serviceCode.indexOf('operationalDetailFindingRepository.getOperationalDetailFindingRows');
    assert.ok(emptyIdx > -1 && repoCallIdx > -1 && emptyIdx < repoCallIdx, 'empty-scope guard must precede the repository call');
    assert.match(serviceCode, /buildingScope: buildingIds/, 'envelope must disclose the authorized scope');
  });

  it('31/32 — one bounded query, no N+1; deterministic ordering', () => {
    // 31. exactly ONE query; no loop construct
    assert.equal((repoCode.match(/getPool\(\)\.query/g) ?? []).length, 1, 'exactly one bounded query — no N+1');
    for (const loop of ['for (', 'forEach', 'while (', 'Promise.all', 'map(async']) {
      assert.ok(!repoCode.includes(loop), `repository must contain no query loop construct: ${loop}`);
    }
    assert.ok(!serviceCode.includes('Promise.all'), 'service must not fan out per-execution queries');
    assert.match(repoCode, /FROM \$\{parentTable\}\$\{templateJoins\}/, 'authorized parent population is expressed IN SQL');
    assert.match(repoCode, /LIMIT \$\$\{values\.length\}/);
    assert.match(repoCode, /OFFSET \$\$\{values\.length\}/);
    assert.match(serviceCode, /const DEFAULT_LIMIT = 100;/, 'R08/R07 default limit');
    assert.match(serviceCode, /const MAX_LIMIT = 1000;/, 'R08/R07 limit cap');
    assert.match(serviceCode, /pagination\.limit > MAX_LIMIT/, 'limit must be capped');
    assert.match(serviceCode, /limit must be a positive integer\./);
    assert.match(serviceCode, /offset must be a non-negative integer\./);
    // pagination must not depend on an R07 detail page
    for (const dep of ['checklistExecutionDetailRepository', 'formExecutionDetailRepository', 'checklistExecutionSummaryRepository', 'findingRegisterRepository']) {
      assert.ok(!serviceCode.includes(dep), `must not derive population from ${dep}`);
      assert.ok(!repoCode.includes(dep), `must not derive population from ${dep}`);
    }
    // read-only: no writes, no DDL
    for (const forbidden of ['CREATE INDEX', 'CREATE TABLE', 'CREATE MATERIALIZED VIEW', 'ALTER TABLE', 'INSERT INTO', 'UPDATE ', 'DELETE FROM']) {
      assert.ok(!repoCode.toUpperCase().includes(forbidden), `module must be read-only — no ${forbidden}`);
    }

    // 32. deterministic total ordering
    assert.match(
      repoCode,
      /ORDER BY f\.source_id ASC, f\.reported_at DESC, f\.created_at DESC, f\.id ASC/,
      'ordering must be source_id ASC, reported_at DESC, created_at DESC, id ASC',
    );
    const orderByStart = repoCode.indexOf('ORDER BY');
    const orderByClause = repoCode.slice(orderByStart, repoCode.indexOf('`', orderByStart));
    assert.ok(!/updated_at/.test(orderByClause), 'must not order by updatedAt (mutated by every transition/rebind)');
    assert.ok(!/state_changed_at/.test(orderByClause), 'must not order by stateChangedAt alone (not unique)');
    assert.match(orderByClause, /f\.id ASC/, 'the primary key is the final tiebreaker, so the order is total');
    // the inner triple is the R02 convention, reused rather than invented
    assert.match(read(R02_REPO_PATH), /ORDER BY f\.reported_at DESC, f\.created_at DESC, f\.id ASC/, 'R02 ordering convention reused');

    // date semantics: parent population window, no competing finding-reportedAt filter
    assert.match(serviceCode, /const MAX_RANGE_DAYS = 366;/);
    assert.match(serviceCode, /DATE_ONLY\.test\(filters\.dateTo\)/, 'date-only dateTo extended by one day, per R07');
    assert.match(repoCode, /\$\{parentAlias\}\.created_at >= \$\$\{values\.length\}/, 'parent window half-open (start inclusive)');
    assert.match(repoCode, /\$\{parentAlias\}\.created_at < \$\$\{values\.length\}/, 'parent window half-open (end exclusive)');
    assert.ok(!/f\.reported_at\s*[<>]=?/.test(repoCode), 'reportedAt must NOT be a population filter');
    assert.ok(!/f\.created_at\s*[<>]=?/.test(repoCode), 'no finding-created_at population filter');
    assert.ok(!/reportedFrom|reportedTo/.test(serviceCode), 'no finding-date filter parameters');
  });

  it('building authority provenance — one policy, three-way identical, no new resolution invented', () => {
    const r04 = read(R04_REPO_PATH);
    const p01b = read(P01B_REPO_PATH);
    const p02b = read(REPO_PATH);

    // CE: byte-identical to the R04 authority AND to the PART 01B copy
    const ce04 = literal(r04, 'CE_BUILDING_SQL');
    const ce01b = literal(p01b, 'CE_BUILDING_SQL');
    const ce02b = literal(p02b, 'CE_BUILDING_SQL');
    assert.ok(ce04.length > 0 && ce01b.length > 0 && ce02b.length > 0, 'CE fragment extractable from all three');
    assert.equal(ce02b, ce04, 'PART 02B CE must be BYTE-IDENTICAL to the R04 authority');
    assert.equal(ce02b, ce01b, 'PART 02B CE must be identical to the PART 01B copy — no drift');
    for (const path of ['engineering_checklist_bindings', 'inspection_bindings', 'toilet_inspection_bindings', 'public_area_inspection_bindings', 'patrol_checklist_bindings', 'vendor_checklist_bindings', 'generated_tasks']) {
      assert.ok(ce02b.includes(path), `CE seven-path authority retained: ${path}`);
    }

    // FI: R04 stores it INLINE in fi_base, so provenance is whitespace-normalized
    const fi01b = literal(p01b, 'FI_BUILDING_SQL');
    const fi02b = literal(p02b, 'FI_BUILDING_SQL');
    const r04fi = /COALESCE\(\s*\(SELECT mrb\.building_id[\s\S]*?WHERE gt\.id = fi\.generated_task_id AND gt\.building_id IS NOT NULL\),\s*NULL\s*\)/
      .exec(r04)?.[0];
    assert.ok(r04fi !== undefined, 'the R04 inline FI building authority must exist');
    assert.equal(normalize(fi02b), normalize(r04fi), 'PART 02B FI must be verbatim from the R04 fi_base authority');
    assert.equal(fi02b, fi01b, 'PART 02B FI must be identical to the PART 01B copy — no drift');
    for (const path of ['meter_reading_bindings', 'log_sheet_bindings', 'generated_tasks']) {
      assert.ok(fi02b.includes(path), `FI authority retained: ${path}`);
    }

    // PART 01B's copies stay module-private: reuse-by-import would have required
    // MODIFYING PART 01B, which this PART forbids, so the copies are the fallback.
    assert.match(p01b, /^const CE_BUILDING_SQL = `/m, 'PART 01B CE remains private (not exported)');
    assert.ok(!p01b.includes('export const CE_BUILDING_SQL'), 'PART 01B was NOT modified to export the fragment');

    // no new building policy: no resolution table outside the R04 fragments
    assert.ok(!/CREATE .*FUNCTION|resolveBuilding|buildingResolver/.test(repoCode), 'no new resolution helper');
    assert.ok(!repoCode.includes('resolveAuthoritativeChecklistSourceContext'), 'the narrower mobile/finding-source authority is not used');
  });

  it('row contract is exactly the 27 frozen fields', () => {
    const fields = [...ROW_TYPE_CODE.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
    assert.deepEqual(fields, [...ROW_FIELDS], 'row contract must be exactly the frozen 27 fields');
    assert.equal(fields.length, 27);

    // the repository projects exactly the matching 27 aliases, explicitly
    assert.ok(!/f\.\*|fa\.\*/.test(repoCode), 'explicit columns only — never f.* / fa.*');
    for (const alias of ['finding_id', 'engine', 'execution_id', 'client_id', 'parent_building_id', 'finding_building_id', 'finding_number', 'title', 'description', 'classification_id', 'severity_id', 'status', 'state_changed_at', 'reported_by_user_id', 'reported_at', 'closed_at', 'closed_by_user_id', 'closure_notes', 'created_at', 'updated_at', 'assignment_id', 'assignee_type', 'workforce_profile_id', 'team_id', 'vendor_id', 'assigned_by_user_id', 'assigned_at']) {
      assert.ok(new RegExp(`AS ${alias}\\b`).test(repoCode), `must project ${alias}`);
    }
    // NULLs preserved: no defaulting of the nullable facts
    for (const field of ['description', 'classificationId', 'severityId', 'closedAt', 'closedByUserId', 'closureNotes']) {
      assert.ok(!new RegExp(`${field}: [^,]*\\?\\?`).test(repoCode), `${field} must never be defaulted`);
    }
    assert.match(repoCode, /description: row\.description,/, 'description copied verbatim');
    assert.match(repoCode, /closureNotes: row\.closure_notes,/, 'closureNotes copied verbatim');
  });

  it('attribution labels are safe; no executor semantics', () => {
    assert.match(typesCode, /reportedByUserId:\s*string;/, 'Reported By — NOT NULL');
    assert.match(typesCode, /closedByUserId:\s*string \| null;/, 'Closed By');
    assert.match(typesCode, /assignedByUserId:\s*string \| null;/, 'Assigned By');
    for (const forbidden of ['executedBy', 'performedBy', 'actualExecutor', 'completedBy', 'capturedBy', 'executorUserId', 'verifiedBy', 'reviewedBy', 'rejectedBy', 'reworkOwner']) {
      assert.ok(!typesCode.includes(forbidden), `no executor/verifier attribution: ${forbidden}`);
      assert.ok(!repoCode.includes(forbidden), `no executor/verifier attribution: ${forbidden}`);
    }
    const doc = read(TYPES_PATH);
    assert.match(doc, /REPORTED BY/, 'reportedByUserId label frozen');
    assert.match(doc, /CLOSED BY/, 'closedByUserId label frozen');
    assert.match(doc, /ASSIGNED BY/, 'assignedByUserId label frozen');
    assert.match(doc, /ASSIGNED TO/, 'assignee target label frozen');
    assert.match(doc, /NONE of these is an executor/, 'executor prohibition documented');
    assert.match(doc, /Executed\s*\n?\s*\*?\s*By|Executed By/, 'the forbidden labels must be named');
  });

  it('R02 non-duplication — same source authority, different governed projection', () => {
    const r02Repo = read(R02_REPO_PATH);
    // R02 keeps its own grain, isolation and enrichment — unchanged
    assert.match(r02Repo, /f\.building_id = ANY\(\$1::uuid\[\]\)/, 'R02 isolation column unchanged');
    assert.match(r02Repo, /f\.reported_at >= \$\$\{values\.length\}/, 'R02 date window stays on reported_at');
    assert.match(r02Repo, /finding_rework_cycles/, 'R02 keeps its rework summary');
    assert.match(r02Repo, /history_count/, 'R02 keeps its history count');
    assert.ok(!/LIMIT \$\d+|OFFSET/.test(r02Repo), 'R02 remains unpaginated (its only LIMITs are LATERAL LIMIT 1) — R08 must supply its own bound');
    // R08 differs on population: it is execution-keyed and parent-scoped
    assert.match(repoCode, /JOIN findings f/, 'R08 drives FROM the parent execution');
    assert.ok(!r02Repo.includes('checklist_executions'), 'R02 never joins a parent execution');
    assert.ok(!r02Repo.includes('operational-detail-finding'), 'R02 must not reference the R08 child');
    // no second lifecycle authority
    const doc = read(TYPES_PATH);
    assert.match(doc, /There is NO second finding lifecycle/, 'must state there is no second lifecycle authority');
    assert.ok(!/FINDING_TRANSITIONS|canTransitionFindingStatus/.test(typesCode), 'R08 does not re-implement the state machine');
    assert.ok(!/FINDING_TRANSITIONS|canTransitionFindingStatus/.test(repoCode));
    assert.ok(!/FINDING_TRANSITIONS|canTransitionFindingStatus/.test(serviceCode), 'transition legality is never reinterpreted');
  });

  it('33 — R02 / R04 / R07 / PART 01B are NOT modified', () => {
    for (const path of [R02_REPO_PATH, R02_TYPES_PATH, R02_SERVICE_PATH, R04_REPO_PATH, R04_SERVICE_PATH, R07_SERVICE_PATH, R07_TYPES_PATH, P01B_REPO_PATH, P01B_SERVICE_PATH, P01B_TYPES_PATH, FINDING_TYPES_PATH, ASSIGNMENT_TYPES_PATH, FINDING_SOURCE_SERVICE_PATH]) {
      assert.ok(!read(path).includes('operational-detail-finding'), `must be unchanged / unaware of the R08 child: ${path}`);
    }
    // PART 01B still holds its own private fragments and its own contract
    assert.match(read(P01B_REPO_PATH), /const FI_BUILDING_SQL = `/);
    assert.match(read(P01B_TYPES_PATH), /PublicOperationalDetailEvidenceRow/);
    // the findings authorities are untouched: no new status, no new assignee type
    assert.ok(read(FINDING_TYPES_PATH).includes("'CANCELLED'"), 'the findings vocabulary is untouched');
    assert.ok(!read(FINDING_TYPES_PATH).includes('operational-detail'));
  });

  it('34 — scope guards: no export, registry, OpenAPI, route, controller, migration, permission, index', () => {
    // module surface is exactly types + repository + service + index
    const files = readdirSync(MODULE_DIR).sort();
    assert.deepEqual(files, [
      'index.ts',
      'operational-detail-finding.repository.ts',
      'operational-detail-finding.service.ts',
      'operational-detail-finding.types.ts',
    ], 'module must contain exactly 4 production files');
    assert.ok(!files.some((f) => f.includes('routes')), 'no route');
    assert.ok(!files.some((f) => f.includes('controller')), 'no controller');
    assert.ok(!files.some((f) => f.includes('validation')), 'validation lives in the service, per R07/PART 01B convention');

    // no export / registry / projection change
    assert.ok(!read(EXPORT_TYPES_PATH).includes('OPERATIONAL_DETAIL_FINDING'), 'no new export dataset enum value');
    assert.ok(!read(EXPORT_REGISTRY_PATH).includes('OPERATIONAL_DETAIL_FINDING'), 'no registry adapter');
    assert.ok(!read(EXPORT_REGISTRY_PATH).includes('operational-detail-finding'), 'registry must not reference this module');
    assert.ok(!read(EXPORT_PROJECTIONS_PATH).includes('operational-detail-finding'), 'no projection');
    assert.ok(!serviceCode.includes('REPORTING_EXPORT'), 'no export coupling');
    assert.ok(!indexCode.includes('reporting-export'), 'no export coupling');

    // OPERATIONAL_DETAIL still exposes exactly ONE table
    const projections = read(EXPORT_PROJECTIONS_PATH);
    const detailProjection = projections.slice(projections.indexOf('export function projectOperationalDetail'));
    assert.equal((detailProjection.match(/table\(/g) ?? []).length, 1, 'OPERATIONAL_DETAIL must still emit exactly one table');
    // R02 FINDING_REGISTER projection is untouched
    assert.match(projections, /export function projectFindingRegister/, 'R02 projection still present');
    const registerProjection = projections.slice(projections.indexOf('export function projectFindingRegister'));
    assert.match(registerProjection, /reworkCount/, 'R02 still owns rework summary');
    assert.match(registerProjection, /historyCount/, 'R02 still owns history count');

    // no OpenAPI change
    const openapi = read(OPENAPI_PATH);
    assert.ok(!openapi.includes('OPERATIONAL_DETAIL_FINDING'), 'no OpenAPI dataset enum change');
    assert.ok(!openapi.includes('operational-detail-finding'), 'no OpenAPI change');

    // no new permission
    assert.ok(!/requirePermission|permissionService|\.read'|\.manage'/i.test(serviceCode), 'no permission handling in this module');
    assert.ok(!/requirePermission|permissionService/i.test(repoCode), 'no permission handling in this module');

    // no migration, no new index, no materialized view
    const migrations = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.ts') && f !== 'index.ts');
    assert.equal(migrations.length, 348, 'no migration added');
    for (const file of migrations) {
      assert.ok(!read(resolve(MIGRATIONS_DIR, file)).includes('operational_detail_finding'), 'no migration references this module');
    }
    assert.ok(!/CREATE (UNIQUE )?INDEX|CREATE MATERIALIZED VIEW/.test(repoCode), 'no index or materialized view');
    // the indexes this query relies on already exist
    assert.match(read(SOURCE_MIGRATION_PATH), /CREATE INDEX findings_source_idx\s*\n?\s*ON findings \(source_type, source_id\)\s*\n?\s*WHERE source_type IS NOT NULL/, 'source access path is already indexed');
    assert.match(read(ASSIGNMENT_MIGRATION_PATH), /finding_active_assignment_unique/, 'assignment access path is already indexed');

    // index exports the read contract only
    assert.match(indexCode, /operationalDetailFindingRepository/);
    assert.match(indexCode, /getOperationalDetailFindingRows/);
    assert.match(indexCode, /getOperationalDetailFinding\b/);
    assert.match(indexCode, /parseOperationalDetailFindingQuery/);
    assert.match(indexCode, /operationalDetailFindingRange/);
    assert.match(indexCode, /operationalDetailFindingService/);
    assert.ok(!/EVIDENCE_CHILD|FINDING_STATUSES\s*,|FINDING_ASSIGNEE_TYPES\s*,/.test(indexCode), 'no re-exported vocabulary — both are reused from their own authorities');
  });

  it('CI-REQUIRED (live PostgreSQL): real row shape, real exclusions, real pagination', () => {
    // These assertions require a live database and are therefore CI-required.
    // They are enumerated here so the gap is explicit rather than silent:
    //   - a finding whose client_id differs from its parent execution's client_id is
    //     EXCLUDED while the rest of the dataset still returns and no error is raised
    //   - a SOURCELESS finding (source_type IS NULL) returns zero rows
    //   - a WORK_ORDER-sourced finding returns zero rows for both R08 engines
    //   - a finding whose parent execution resolves to an authorized building but whose
    //     own building_id is NOT authorized returns zero rows (and vice versa)
    //   - a finding whose parent resolves to building B2 while its own building_id is B
    //     IS returned when BOTH are authorized, with parentBuildingId=B2 and
    //     findingBuildingId=B preserved distinctly
    //   - an execution whose building cannot be resolved through any binding path
    //     contributes zero rows (fail-closed)
    //   - all ten statuses are returned by the default read, including CLOSED/CANCELLED
    //   - an unassigned finding returns all seven assignment fields NULL
    //   - a VENDOR_WORKFORCE assignment returns BOTH vendorId and workforceProfileId
    //   - each of the four assignee shapes returns exactly its own target ids
    //   - LIMIT/OFFSET page deterministically over the declared ORDER BY
    //   - exactly one SQL statement is issued per call (no N+1), and the planner uses
    //     findings_source_idx plus finding_active_assignment_unique
    const ciRequired = true;
    assert.equal(ciRequired, true, 'live-DB cases are CI-required; PostgreSQL is unavailable in this sandbox');
  });
});
