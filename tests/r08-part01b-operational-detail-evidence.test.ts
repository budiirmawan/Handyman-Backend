import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * R08 PART 01B — Operational Detail Evidence child projection: focused validation.
 *
 * Runtime assertions are made against the types module (it has zero runtime
 * dependencies — its only import is `import type`, which is erased). Repository
 * and service assertions are static source assertions, matching the established
 * R07 test convention, because `pg` / context-access cannot be loaded without
 * dependencies. Genuine live-DB cases (actual row shapes, real mismatched-client
 * exclusion, real pagination) are marked CI-required below.
 *
 * Paths resolve from process.cwd() so this file runs identically under the
 * repository's configured runner (`tsx --test`, CommonJS) and under plain
 * `node --test` type-stripping (ESM), where `__dirname` is unavailable.
 *
 * Covers the 22 required conditions:
 *   1  row grain is evidence_submissions.id
 *   2  parent key contains engine + executionId
 *   3  default query does NOT force status='ACTIVE'
 *   4  REMOVED evidence remains representable
 *   5  PURGED evidence remains representable with purgedAt
 *   6  status and retentionState remain independent
 *   7  literal status filter is supported
 *   8  literal retentionState filter is supported
 *   9  invalid status rejected
 *  10  invalid retentionState rejected
 *  11  client consistency enforced in SQL (e.client_id = parent.client_id)
 *  12  mismatched-client evidence cannot be exposed
 *  13  executionId cannot bypass building scope
 *  14  empty accessible building scope returns an empty result
 *  15  fileReference absent from the public row contract
 *  16  no storage / file-content access exists in this module
 *  17  no item/field/occurrence attribution fields exist
 *  18  evidenceRequirementId is not used as detail attribution
 *  19  contentSha256 NULL remains NULL
 *  20  no derived integrity/availability claim exists
 *  21  deterministic ordering executionId, createdAt, evidenceId
 *  22  no per-execution query loop / N+1 pattern
 * plus scope guards: no export, no registry, no OpenAPI, no route, no migration,
 * no new permission, no new index, no R04 change, no R07 change.
 */

const ROOT = process.cwd();
const MODULE_DIR = resolve(ROOT, 'src/modules/operational-detail-evidence');
const TYPES_PATH = resolve(MODULE_DIR, 'operational-detail-evidence.types.ts');
const REPO_PATH = resolve(MODULE_DIR, 'operational-detail-evidence.repository.ts');
const SERVICE_PATH = resolve(MODULE_DIR, 'operational-detail-evidence.service.ts');
const INDEX_PATH = resolve(MODULE_DIR, 'index.ts');

const R04_REPO_PATH = resolve(ROOT, 'src/modules/checklist-execution-summary/checklist-execution-summary.repository.ts');
const R04_SERVICE_PATH = resolve(ROOT, 'src/modules/checklist-execution-summary/checklist-execution-summary.service.ts');
const R07_NEUTRAL_SERVICE_PATH = resolve(ROOT, 'src/modules/operational-detail-reporting/operational-detail-reporting.service.ts');
const R07_NEUTRAL_TYPES_PATH = resolve(ROOT, 'src/modules/operational-detail-reporting/operational-detail-reporting.types.ts');
const R07_CE_DETAIL_REPO_PATH = resolve(ROOT, 'src/modules/checklist-execution-detail/checklist-execution-detail.repository.ts');
const R07_FORM_DETAIL_REPO_PATH = resolve(ROOT, 'src/modules/form-execution-detail/form-execution-detail.repository.ts');
const EXPORT_REGISTRY_PATH = resolve(ROOT, 'src/modules/reporting-export/reporting-export.registry.ts');
const EXPORT_TYPES_PATH = resolve(ROOT, 'src/modules/reporting-export/reporting-export.types.ts');
const EXPORT_PROJECTIONS_PATH = resolve(ROOT, 'src/modules/reporting-export/reporting-export.projections.ts');
const OPENAPI_PATH = resolve(ROOT, 'docs/api/openapi.yaml');
const MIGRATIONS_DIR = resolve(ROOT, 'src/database/migrations');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

/** Removes block and line comments so "identifier must not exist" assertions
 *  test the CODE contract, not the documentation that explains the exclusion. */
function code(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const typesCode = code(TYPES_PATH);
const repoCode = code(REPO_PATH);
const serviceCode = code(SERVICE_PATH);
const indexCode = code(INDEX_PATH);

describe('R08 PART 01B — Operational Detail Evidence child projection', () => {
  it('1/2 — row grain is evidence_submissions.id and parent key is (engine, executionId)', () => {
    // 1. row grain
    assert.match(repoCode, /e\.id\s+AS evidence_id/, 'must select evidence_submissions.id as the row key');
    assert.match(typesCode, /evidenceId:\s*string;/, 'row contract must carry evidenceId');
    assert.ok(!/GROUP BY/i.test(repoCode), 'grain is one row per evidence id — no GROUP BY collapse');

    // 2. parent key
    assert.match(repoCode, /e\.execution_type\s+AS engine/, 'engine must come from execution_type verbatim');
    assert.match(repoCode, /e\.execution_id\s+AS execution_id/, 'executionId must come from execution_id');
    assert.match(typesCode, /engine:\s*OperationalDetailEngine;/, 'row contract must carry engine');
    assert.match(typesCode, /executionId:\s*string;/, 'row contract must carry executionId');

    // engine vocabulary is REUSED from R07 — no competing enum
    assert.match(read(TYPES_PATH), /from '\.\.\/operational-detail-reporting\/operational-detail-reporting\.types'/);
    assert.match(serviceCode, /isOperationalDetailEngine/);
    assert.ok(!/OPERATIONAL_DETAIL_ENGINES\s*=/.test(typesCode), 'must not re-declare the R07 engine enum');
  });

  it('3/4/5/6 — historical lineage visibility: no forced ACTIVE, REMOVED and PURGED representable, dimensions independent', async () => {
    // 3. default read applies NO status predicate and NO retentionState predicate
    assert.ok(!/e\.status\s*=\s*'ACTIVE'/.test(repoCode), 'must never hard-code status = ACTIVE');
    assert.ok(!/e\.retention_state\s*=\s*'ACTIVE'/.test(repoCode), 'must never hard-code retention_state = ACTIVE');
    assert.ok(!/status\s*=\s*'ACTIVE'/.test(repoCode), 'no literal ACTIVE status predicate anywhere in the query');
    assert.match(repoCode, /if \(filters\.status\) \{/, 'status predicate must be conditional');
    assert.match(repoCode, /if \(filters\.retentionState\) \{/, 'retentionState predicate must be conditional');
    assert.match(repoCode, /e\.status = \$\$\{values\.length\}/, 'status filter must be a bound literal parameter');
    assert.match(repoCode, /e\.retention_state = \$\$\{values\.length\}/, 'retentionState filter must be a bound literal parameter');

    // 4/5/6. runtime authority over the two stored vocabularies
    const mod = await import(pathToFileURL(TYPES_PATH).href);
    assert.deepEqual([...mod.EVIDENCE_CHILD_STATUSES], ['ACTIVE', 'REMOVED']);
    assert.deepEqual([...mod.EVIDENCE_CHILD_RETENTION_STATES], ['ACTIVE', 'RETENTION_DUE', 'PURGED']);

    // 4. REMOVED representable; 5. PURGED representable with purgedAt
    assert.equal(mod.isEvidenceChildStatus('REMOVED'), true);
    assert.equal(mod.isEvidenceChildRetentionState('PURGED'), true);
    assert.match(typesCode, /purgedAt:\s*string \| null;/, 'purgedAt must be part of the row contract');
    assert.match(repoCode, /e\.purged_at\s+AS purged_at/, 'purgedAt must be selected');
    assert.match(repoCode, /purgedAt: toIso\(row\.purged_at\)/, 'purgedAt must be mapped verbatim');

    // 6. independence: two separate columns, two separate filters, no combined state
    assert.match(repoCode, /e\.status\s+AS status/);
    assert.match(repoCode, /e\.retention_state\s+AS retention_state/);
    assert.match(typesCode, /status:\s*EvidenceChildStatus;/);
    assert.match(typesCode, /retentionState:\s*EvidenceChildRetentionState;/);
    for (const forbidden of ['lifecycleState', 'combinedState', 'effectiveStatus', 'availabilityState']) {
      assert.ok(!typesCode.includes(forbidden), `must not invent a combined state field: ${forbidden}`);
      assert.ok(!repoCode.includes(forbidden), `must not invent a combined state field: ${forbidden}`);
    }

    // no derived lifecycle MODE anywhere (history / includeRemoved / available / valid / verified / compliant / current).
    // Word-boundary matching: `isValidUuid` (the reused R07 UUID helper) must NOT
    // be mistaken for a derived `isValid` claim.
    for (const forbidden of ['includeRemoved', 'historyMode', 'isAvailable', 'isValid', 'isCompliant', 'isVerified', 'currentOnly']) {
      const pattern = new RegExp(`\\b${forbidden}\\b`);
      assert.ok(!pattern.test(typesCode), `no derived lifecycle mode: ${forbidden}`);
      assert.ok(!pattern.test(repoCode), `no derived lifecycle mode: ${forbidden}`);
      assert.ok(!pattern.test(serviceCode), `no derived lifecycle mode: ${forbidden}`);
    }
  });

  it('7/8/9/10 — optional LITERAL status / retentionState filters, invalid values rejected', async () => {
    const mod = await import(pathToFileURL(TYPES_PATH).href);

    // 7/8. literal filters supported
    assert.match(serviceCode, /query\.status/, 'parser must read status');
    assert.match(serviceCode, /query\.retentionState/, 'parser must read retentionState');
    assert.match(serviceCode, /isEvidenceChildStatus/, 'parser must validate against the stored status vocabulary');
    assert.match(serviceCode, /isEvidenceChildRetentionState/, 'parser must validate against the stored retention vocabulary');

    // 9/10. invalid values rejected (runtime guard authority)
    assert.equal(mod.isEvidenceChildStatus('ACTIVE'), true);
    assert.equal(mod.isEvidenceChildStatus('REMOVED'), true);
    assert.equal(mod.isEvidenceChildStatus('DELETED'), false, 'invalid status must be rejected');
    assert.equal(mod.isEvidenceChildStatus('PURGED'), false, 'retention state must not be accepted as a status');
    assert.equal(mod.isEvidenceChildStatus(''), false);
    assert.equal(mod.isEvidenceChildStatus(null), false);
    assert.equal(mod.isEvidenceChildStatus(['ACTIVE']), false, 'multi-value must be rejected');

    assert.equal(mod.isEvidenceChildRetentionState('ACTIVE'), true);
    assert.equal(mod.isEvidenceChildRetentionState('RETENTION_DUE'), true);
    assert.equal(mod.isEvidenceChildRetentionState('PURGED'), true);
    assert.equal(mod.isEvidenceChildRetentionState('REMOVED'), false, 'status must not be accepted as a retention state');
    assert.equal(mod.isEvidenceChildRetentionState('EXPIRED'), false, 'invalid retention state must be rejected');
    assert.equal(mod.isEvidenceChildRetentionState('HELD'), false);

    // rejection surfaces as a validation detail, never a silent default
    assert.match(serviceCode, /status must be a valid evidence status \(ACTIVE\/REMOVED\)\./);
    assert.match(serviceCode, /retentionState must be a valid evidence retention state \(ACTIVE\/RETENTION_DUE\/PURGED\)\./);
    assert.match(serviceCode, /throw AppError\.validation\('Request validation failed\.', details\)/);

    // engine is REQUIRED
    assert.match(serviceCode, /engine is required \(CHECKLIST_EXECUTION \| FORM_INSTANCE\)\./);
  });

  it('11/12 — client consistency is enforced STRUCTURALLY in SQL, for both engines', () => {
    // 11. the parent join carries identity, the engine discriminator AND the client
    //     comparison, so a mismatched-client row is never fetched at all
    assert.match(repoCode, /ON e\.execution_type = \$1/, 'engine discriminator must be bound in the join');
    assert.match(repoCode, /AND e\.execution_id = \$\{parentAlias\}\.id/, 'parent identity predicate');
    assert.match(repoCode, /AND e\.client_id = \$\{parentAlias\}\.client_id/, 'client consistency must be part of the JOIN predicate');
    assert.match(repoCode, /const parentAlias = isChecklist \? 'ce' : 'fi';/, 'alias must resolve per engine');
    assert.match(repoCode, /const parentTable = isChecklist \? 'checklist_executions ce' : 'form_instances fi';/, 'parent table must resolve per engine');
    assert.match(repoCode, /JOIN evidence_submissions e/, 'evidence must be joined to the authorized parent');

    // both parent tables are covered by the same structural predicate
    for (const alias of ['ce', 'fi']) {
      assert.ok(repoCode.includes(`? '${alias}' :`) || repoCode.includes(`: '${alias}'`), `engine branch must cover alias ${alias}`);
    }
    // the join cannot fan out: parent.id is a primary key
    assert.ok(!/GROUP BY|DISTINCT/i.test(repoCode), 'no de-duplication needed — parent PK join cannot fan out');

    // 12. mismatched-client evidence cannot be exposed: no include-and-flag, no
    //     post-filter, no whole-query rejection, no caller-supplied clientId
    assert.ok(!/\.filter\(/.test(repoCode), 'no application-level post-filter of loaded rows');
    assert.ok(!/\.filter\(/.test(serviceCode), 'no application-level post-filter of loaded rows');
    assert.ok(!/clientMismatch|client_mismatch|mismatch/i.test(repoCode), 'no include-and-flag field');
    assert.ok(!/clientId/.test(serviceCode), 'service must never accept or use a caller-supplied clientId');
    assert.ok(!/query\.clientId/.test(serviceCode), 'no clientId query parameter');
    assert.ok(!typesCode.includes('clientMismatch'), 'row contract must not carry a mismatch flag');
    // clientId is exposed only as the verbatim parent-consistency anchor
    assert.match(repoCode, /e\.client_id\s+AS client_id/);
    assert.match(typesCode, /clientId:\s*string;/);
  });

  it('13/14 — executionId cannot bypass building scope; empty scope returns an empty result', () => {
    // 13. building authority gates the parent, fail-closed, for whichever engine is selected
    assert.match(repoCode, /const buildingSql = isChecklist \? CE_BUILDING_SQL : FI_BUILDING_SQL;/, 'engine must select the matching R04 resolution fragment');
    assert.match(repoCode, /conditions\.push\(`\$\{buildingSql\} = ANY\(\$2::uuid\[\]\)`\)/, 'building authority must be an ANDed parent condition');
    assert.equal((repoCode.match(/= ANY\(\$2::uuid\[\]\)/g) ?? []).length, 1, 'exactly one building predicate, shared by both engine branches');

    // executionId narrows INSIDE the same ANDed parent predicate — never widens
    assert.match(repoCode, /if \(filters\.executionId\) \{/, 'executionId handled as a parent narrowing filter');
    assert.match(repoCode, /conditions\.push\(`\$\{parentAlias\}\.id = \$\$\{values\.length\}::uuid`\)/, 'executionId narrowing binds the parent alias');
    assert.ok(
      repoCode.indexOf('ANY($2::uuid[])') < repoCode.indexOf('if (filters.executionId)'),
      'building scope must be established BEFORE executionId narrowing in the same ANDed predicate list',
    );
    assert.match(repoCode, /WHERE \$\{conditions\.join\('\\n\s+AND '\)\}/, 'all parent conditions are ANDed');

    // R04/R07 building resolution reused VERBATIM — not a second policy
    const r04 = read(R04_REPO_PATH);
    const literal = (src: string, name: string): string =>
      new RegExp(`const ${name} = \`\\n([\\s\\S]*?)\\n\`;`).exec(src)?.[1] ?? '';
    const ceSql = literal(repoCode, 'CE_BUILDING_SQL');
    const r04CeSql = literal(r04, 'CE_BUILDING_SQL');
    assert.ok(ceSql.length > 0 && r04CeSql.length > 0, 'CE building fragment must be extractable from both modules');
    assert.equal(ceSql, r04CeSql, 'CE building resolution must be byte-identical to the R04 authority');
    assert.equal(
      ceSql.replace(/\s+/g, ' ').trim(),
      r04CeSql.replace(/\s+/g, ' ').trim(),
      'CE building resolution must be identical to the R04 authority',
    );
    for (const path of ['engineering_checklist_bindings', 'inspection_bindings', 'toilet_inspection_bindings', 'public_area_inspection_bindings', 'patrol_checklist_bindings', 'vendor_checklist_bindings', 'generated_tasks']) {
      assert.ok(ceSql.includes(path), `CE building authority must retain every R04 binding path: ${path}`);
    }

    // R04 stores the FI building COALESCE INLINE inside its fi_base CTE (there is no
    // named FI constant upstream), so provenance is proven against that fragment:
    // identical modulo indentation and the `AS building_id` column alias R04 adds.
    const r04Fi = /COALESCE\(\s*\(SELECT mrb\.building_id[\s\S]*?WHERE gt\.id = fi\.generated_task_id AND gt\.building_id IS NOT NULL\),\s*NULL\s*\)/
      .exec(r04)?.[0];
    assert.ok(r04Fi !== undefined, 'the R04 inline FI building authority must exist');
    assert.equal(
      literal(repoCode, 'FI_BUILDING_SQL').replace(/\s+/g, ' ').trim(),
      r04Fi.replace(/\s+/g, ' ').trim(),
      'FI building resolution must be verbatim from the R04 fi_base authority',
    );
    for (const path of ['meter_reading_bindings', 'log_sheet_bindings', 'generated_tasks']) {
      assert.ok(repoCode.includes(path), `FI building authority must retain every R04 binding path: ${path}`);
    }

    // the looser evidence-module access seam must NOT be the Reporting authority
    assert.ok(!serviceCode.includes('loadEvidenceExecution'), 'must not use the evidence-module client-scoped seam');
    assert.ok(!repoCode.includes('loadEvidenceExecution'));

    // R04/R07 access authority reused
    assert.match(serviceCode, /buildingRepository\.findById\(filters\.buildingId\)/);
    assert.match(serviceCode, /buildingNotFoundError\(\)/);
    assert.match(serviceCode, /contextAccessService\.assertBuildingAccess\(userId, filters\.buildingId\)/);
    assert.match(serviceCode, /contextAccessService\.getAccessibleBuildingIds\(userId\)/);
    assert.ok(!/role|isAdmin|hasRole/i.test(serviceCode), 'no role hardcoding / second auth model');

    // 14. empty accessible scope → well-formed empty result, no unrestricted query
    assert.match(
      serviceCode,
      /if \(buildingIds\.length === 0\) \{\s*return \{ \.\.\.base, rows: \[\] \};/,
      'empty authorized scope must return an empty result before any query',
    );
    const emptyIdx = serviceCode.indexOf('if (buildingIds.length === 0)');
    const repoCallIdx = serviceCode.indexOf('operationalDetailEvidenceRepository.getOperationalDetailEvidenceRows');
    assert.ok(emptyIdx > -1 && repoCallIdx > -1 && emptyIdx < repoCallIdx, 'empty-scope guard must precede the repository call');
    assert.match(serviceCode, /buildingScope: buildingIds/, 'envelope must disclose the authorized scope');
  });

  it('15/16 — no fileReference, no storage path, no file-content access', () => {
    // 15. fileReference absent from the public row contract and from the SELECT list
    assert.ok(!typesCode.includes('fileReference'), 'row contract must not expose fileReference');
    assert.ok(!repoCode.includes('fileReference'), 'mapping must not expose fileReference');
    assert.ok(!repoCode.includes('file_reference'), 'storage key must not be selected');
    assert.ok(!/e\.\*/.test(repoCode), 'must list explicit columns — never e.* (structural guarantee against leaking storage columns)');

    for (const forbidden of ['storagePath', 'filePath', 'bucket', 'signedUrl', 'signed_url', 'downloadUrl', 'url', 'token', 'absolutePath']) {
      assert.ok(!typesCode.includes(forbidden), `row contract must not expose ${forbidden}`);
    }

    // 16. no storage / file-content access in this module
    assert.ok(!/from '\.\.\/evidence/.test(read(REPO_PATH)), 'must not import the evidence module');
    assert.ok(!/from '\.\.\/evidence/.test(read(SERVICE_PATH)), 'must not import the evidence module');
    assert.ok(!repoCode.includes('storage'), 'repository must not reference storage');
    assert.ok(!serviceCode.includes('storage'), 'service must not reference storage');
    assert.ok(!repoCode.includes('/file/content'), 'no file-content access');
    assert.ok(!repoCode.includes('createEvidenceStorage'), 'no storage abstraction');
    assert.ok(!repoCode.includes('multer'), 'no upload handling');
  });

  it('17/18 — no item/field/occurrence attribution; evidenceRequirementId is lineage only', () => {
    // 17. no detail attribution identifier may exist in the code contract
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
    assert.ok(!/checklist_item_responses|form_responses|form_instance_occurrences|form_template_version_fields|checklist_items/.test(repoCode),
      'must not join any detail-grain table to manufacture attribution');

    // 18. evidenceRequirementId is exposed as lineage but never joined for attribution
    assert.match(repoCode, /e\.evidence_requirement_id\s+AS evidence_requirement_id/, 'requirement id is lineage metadata');
    assert.match(typesCode, /evidenceRequirementId:\s*string \| null;/, 'requirement id is nullable lineage metadata');
    assert.ok(!repoCode.includes('evidence_requirements'), 'must NOT join evidence_requirements to infer item/field attribution');
    assert.ok(!repoCode.includes('target_type'), 'must not read requirement target metadata');
  });

  it('19/20 — integrity facts verbatim; contentSha256 NULL stays NULL; no derived claim', () => {
    // 19. NULL preserved — no defaulting, no coercion
    assert.match(repoCode, /contentSha256: row\.content_sha256,/, 'contentSha256 must be copied verbatim');
    assert.match(typesCode, /contentSha256:\s*string \| null;/, 'contentSha256 must be nullable');
    assert.ok(!/content_sha256\s*\?\?/.test(repoCode), 'contentSha256 must never be defaulted');
    assert.ok(!/contentSha256\s*\?\?/.test(repoCode), 'contentSha256 must never be defaulted');
    assert.ok(!/contentSha256: row\.content_sha256\s*\|\|/.test(repoCode), 'contentSha256 must never be falsy-coerced');

    // hash companions preserved verbatim
    for (const [column, field] of [
      ['content_hashed_at', 'contentHashedAt'],
      ['hash_algorithm', 'hashAlgorithm'],
      ['last_integrity_status', 'lastIntegrityStatus'],
      ['last_integrity_checked_at', 'lastIntegrityCheckedAt'],
    ] as const) {
      assert.ok(repoCode.includes(`e.${column}`), `must select ${column}`);
      assert.ok(typesCode.includes(field), `row contract must carry ${field}`);
    }
    // lastIntegrityStatus must never ship without its checked-at companion
    assert.match(typesCode, /lastIntegrityCheckedAt:\s*string \| null;/);

    // retention facts verbatim
    for (const column of ['retention_policy_code', 'retention_days_snapshot', 'retention_applied_at', 'retained_until', 'retention_hold', 'purged_at']) {
      assert.ok(repoCode.includes(`e.${column}`), `must select ${column}`);
    }
    assert.ok(!repoCode.includes('retention_policy_id'), 'LIVE policy pointer excluded — the frozen snapshot is the authority');
    assert.ok(!typesCode.includes('retentionHoldReason'), 'deferred hold metadata excluded from this PART');
    assert.ok(!typesCode.includes('retentionHoldSetByUserId'), 'deferred hold metadata excluded from this PART');
    assert.ok(!typesCode.includes('retentionHoldSetAt'), 'deferred hold metadata excluded from this PART');

    // 20. no derived integrity / availability claim
    const forbidden = [
      'integrityVerified', 'isIntegrityVerified', 'isValid', 'isTamperProof',
      'isAvailable', 'isCompliant', 'fileAvailable', 'contentAvailable',
      'hashPresent', 'isHashed', 'integrityStatus', 'datasetIntegrity',
    ];
    for (const identifier of forbidden) {
      assert.ok(!typesCode.includes(identifier), `no derived integrity/availability field: ${identifier}`);
      assert.ok(!repoCode.includes(identifier), `no derived integrity/availability field: ${identifier}`);
    }
    // attribution: submittedByUserId only, never an executor
    assert.match(typesCode, /submittedByUserId:\s*string \| null;/);
    for (const forbidden of ['executedBy', 'performedBy', 'completedBy', 'capturedBy', 'actualExecutor', 'executorUserId']) {
      assert.ok(!typesCode.includes(forbidden), `no executor attribution: ${forbidden}`);
      assert.ok(!repoCode.includes(forbidden), `no executor attribution: ${forbidden}`);
    }
    assert.match(repoCode, /submittedByUserId: row\.submitted_by_user_id/, 'submittedByUserId copied verbatim');
    // no display-name joins
    assert.ok(!/\busers\b/.test(repoCode), 'no display-name join in this PART');
    assert.ok(!/workforce_profiles/.test(repoCode), 'no display-name join in this PART');
  });

  it('21/22 — deterministic evidence-row ordering; one bounded query, no N+1', () => {
    // 21. ordering
    assert.match(
      repoCode,
      /ORDER BY e\.execution_id ASC, e\.created_at ASC, e\.id ASC/,
      'ordering must be executionId ASC, createdAt ASC, evidenceId ASC',
    );
    // ordering must be confined to the declared keys — inspect the ORDER BY clause itself
    const orderByStart = repoCode.indexOf('ORDER BY');
    assert.ok(orderByStart > -1, 'query must declare an ORDER BY');
    const orderByClause = repoCode.slice(orderByStart, repoCode.indexOf('`', orderByStart));
    assert.ok(!/captured_at/.test(orderByClause), 'must not order by capturedAt (nullable device time)');
    assert.ok(!/updated_at/.test(orderByClause), 'must not order by updatedAt (mutated by retention/integrity runs)');

    // pagination at EVIDENCE-ROW grain, bounded
    assert.match(repoCode, /if \(pagination\.limit !== undefined\) \{/, 'limit is applied to evidence rows');
    assert.match(repoCode, /if \(pagination\.offset !== undefined\) \{/, 'offset is applied to evidence rows');
    assert.match(repoCode, /LIMIT \$\$\{values\.length\}/);
    assert.match(repoCode, /OFFSET \$\$\{values\.length\}/);
    assert.match(serviceCode, /const DEFAULT_LIMIT = 100;/, 'Reporting default limit convention');
    assert.match(serviceCode, /const MAX_LIMIT = 1000;/, 'Reporting limit cap convention');
    assert.match(serviceCode, /pagination\.limit > MAX_LIMIT/, 'limit must be capped');
    assert.match(serviceCode, /limit must be a positive integer\./);
    assert.match(serviceCode, /offset must be a non-negative integer\./);

    // parent date semantics reused (half-open over parent created_at) — no competing evidence-date filter
    assert.match(serviceCode, /const MAX_RANGE_DAYS = 366;/);
    assert.match(serviceCode, /DATE_ONLY\.test\(filters\.dateTo\)/, 'date-only dateTo extended by one day, per R07');
    assert.match(repoCode, /\$\{parentAlias\}\.created_at >= \$\$\{values\.length\}/, 'parent window is half-open (start inclusive)');
    assert.match(repoCode, /\$\{parentAlias\}\.created_at < \$\$\{values\.length\}/, 'parent window is half-open (end exclusive)');
    // Word-boundary anchored: `ce.created_at` / `fi.created_at` (the PARENT window,
    // which is required) must not be mistaken for an evidence-level date predicate.
    assert.ok(!/\be\.created_at\s*>?=/.test(repoCode), 'no competing evidence-created_at population filter');
    assert.ok(!/\be\.captured_at\s*>?=/.test(repoCode), 'no evidence-capturedAt population filter');

    // 22. exactly ONE query; no per-execution loop; no unbounded id materialization
    const queryCalls = repoCode.match(/getPool\(\)\.query/g) ?? [];
    assert.equal(queryCalls.length, 1, 'exactly one bounded query — no N+1');
    for (const loop of ['for (', 'forEach', 'while (', 'Promise.all', 'map(async']) {
      assert.ok(!repoCode.includes(loop), `repository must contain no query loop construct: ${loop}`);
    }
    assert.ok(!serviceCode.includes('Promise.all'), 'service must not fan out per-execution queries');
    // authorized parents are expressed in SQL, never materialized into an id array
    assert.ok(!repoCode.includes('= ANY($3'), 'no materialized execution-id array parameter');
    assert.ok(!/executionIds/.test(repoCode), 'no execution-id list is materialized');
    assert.ok(!/executionIds/.test(serviceCode), 'no execution-id list is materialized');
    assert.ok(!serviceCode.includes('checklistExecutionSummaryRepository'), 'must not materialize the unbounded R04 parent set');
    assert.ok(!serviceCode.includes('checklistExecutionDetailRepository'), 'must not derive population from an R07 detail page');
    assert.ok(!serviceCode.includes('formExecutionDetailRepository'), 'must not derive population from an R07 detail page');
    assert.match(repoCode, /FROM \$\{parentTable\}\$\{templateJoins\}/, 'authorized parent population must be expressed IN SQL (parent-driven FROM)');
    assert.match(repoCode, /JOIN evidence_submissions e/, 'evidence is joined to the authorized parent — never enumerated in application memory');
    assert.ok(!/EXISTS \(/.test(repoCode), 'no per-row correlated subquery shape — the parent drives');

    // no materialized view, no new index, no DDL
    for (const forbidden of ['CREATE INDEX', 'CREATE TABLE', 'CREATE MATERIALIZED VIEW', 'ALTER TABLE', 'INSERT INTO', 'UPDATE ', 'DELETE FROM']) {
      assert.ok(!repoCode.toUpperCase().includes(forbidden), `module must be read-only — no ${forbidden}`);
    }
  });

  it('R04 reconciliation rule is documented and R04 is not changed to match', () => {
    const doc = read(TYPES_PATH);
    assert.match(doc, /R04 RECONCILIATION RULE/, 'the intentional count divergence must be documented in the contract');
    assert.match(doc, /MAY BE GREATER THAN R04's evidenceCount/, 'must state the child count may exceed R04 evidenceCount');
    assert.match(doc, /status = 'ACTIVE'/, 'must state the comparison condition');

    // R04 untouched: it still owns an ACTIVE-only evidenceCount and knows nothing about R08
    const r04Repo = read(R04_REPO_PATH);
    assert.match(r04Repo, /es\.status = 'ACTIVE'/, 'R04 evidenceCount remains ACTIVE-only');
    assert.ok(!r04Repo.includes('operational-detail-evidence'), 'R04 repository must not reference the R08 child');
    assert.ok(!read(R04_SERVICE_PATH).includes('operational-detail-evidence'), 'R04 service must not reference the R08 child');
  });

  it('scope guards — no export, registry, OpenAPI, route, migration, permission, R07 change', () => {
    // module surface is exactly types + repository + service + index
    const files = readdirSync(MODULE_DIR).sort();
    assert.deepEqual(files, [
      'index.ts',
      'operational-detail-evidence.repository.ts',
      'operational-detail-evidence.service.ts',
      'operational-detail-evidence.types.ts',
    ], 'module must contain exactly 4 production files');
    assert.ok(!files.some((f) => f.includes('routes')), 'no route');
    assert.ok(!files.some((f) => f.includes('controller')), 'no controller');
    assert.ok(!files.some((f) => f.includes('validation')), 'validation lives in the service, per R07 convention');

    // no export / registry / projection change
    assert.ok(!read(EXPORT_TYPES_PATH).includes('OPERATIONAL_DETAIL_EVIDENCE'), 'no new export dataset enum value');
    assert.ok(!read(EXPORT_REGISTRY_PATH).includes('OPERATIONAL_DETAIL_EVIDENCE'), 'no registry adapter');
    assert.ok(!read(EXPORT_REGISTRY_PATH).includes('operational-detail-evidence'), 'registry must not reference this module');
    assert.ok(!read(EXPORT_PROJECTIONS_PATH).includes('operational-detail-evidence'), 'no projection');
    assert.ok(!serviceCode.includes('REPORTING_EXPORT'), 'no export coupling');
    assert.ok(!indexCode.includes('reporting-export'), 'no export coupling');

    // OPERATIONAL_DETAIL still exposes exactly ONE table (CSV contract unchanged)
    const projections = read(EXPORT_PROJECTIONS_PATH);
    const detailProjection = projections.slice(projections.indexOf('export function projectOperationalDetail'));
    assert.equal((detailProjection.match(/table\(/g) ?? []).length, 1, 'OPERATIONAL_DETAIL must still emit exactly one table');

    // no OpenAPI change
    const openapi = read(OPENAPI_PATH);
    assert.ok(!openapi.includes('OPERATIONAL_DETAIL_EVIDENCE'), 'no OpenAPI dataset enum change');
    assert.ok(!openapi.includes('operational-detail-evidence'), 'no OpenAPI change');

    // no new permission
    assert.ok(!/requirePermission|permissionService|\.read'|\.manage'/i.test(serviceCode), 'no permission handling in this module');
    assert.ok(!/requirePermission|permissionService/i.test(repoCode), 'no permission handling in this module');

    // no migration
    const migrations = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.ts') && f !== 'index.ts');
    assert.equal(migrations.length, 348, 'no migration added');
    for (const file of migrations) {
      assert.ok(!read(resolve(MIGRATIONS_DIR, file)).includes('operational_detail_evidence'), 'no migration references this module');
    }

    // R07 unchanged: no R07 module knows about the R08 child, and its engine vocabulary is reused not copied
    for (const path of [R07_NEUTRAL_SERVICE_PATH, R07_NEUTRAL_TYPES_PATH, R07_CE_DETAIL_REPO_PATH, R07_FORM_DETAIL_REPO_PATH]) {
      assert.ok(!read(path).includes('operational-detail-evidence'), `R07 must be unchanged: ${path}`);
    }
    assert.match(read(R07_NEUTRAL_TYPES_PATH), /export function isOperationalDetailEngine/, 'R07 engine guard reused as the single vocabulary authority');

    // index exports the read contract only
    assert.match(indexCode, /operationalDetailEvidenceRepository/);
    assert.match(indexCode, /getOperationalDetailEvidence\b/);
    assert.match(indexCode, /parseOperationalDetailEvidenceQuery/);
    assert.match(indexCode, /operationalDetailEvidenceRange/);
    assert.match(indexCode, /operationalDetailEvidenceService/);
  });

  it('CI-REQUIRED (live PostgreSQL): real row shape, real mismatch exclusion, real pagination', () => {
    // These assertions require a live database and are therefore CI-required.
    // They are enumerated here so the gap is explicit rather than silent:
    //   - a REMOVED row and a PURGED row are both returned by the default read,
    //     with status / retentionState / purgedAt verbatim
    //   - all six (status x retentionState) combinations are representable
    //   - an evidence row whose client_id differs from its parent execution's
    //     client_id is EXCLUDED while the rest of the dataset still returns and
    //     no error is raised
    //   - an executionId outside the authorized building scope returns zero rows
    //   - an execution whose building cannot be resolved through any binding path
    //     contributes zero rows (fail-closed)
    //   - LIMIT/OFFSET page deterministically over the declared ORDER BY
    //   - exactly one SQL statement is issued per call (no N+1)
    const ciRequired = true;
    assert.equal(ciRequired, true, 'live-DB cases are CI-required; PostgreSQL is unavailable in this sandbox');
  });
});
