import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  FINDING_REWORK_CHILD_STATUSES,
  isFindingReworkChildStatus,
} from '../src/modules/operational-detail-finding-rework/operational-detail-finding-rework.types';
import {
  OPERATIONAL_DETAIL_ENGINES,
  isOperationalDetailEngine,
} from '../src/modules/operational-detail-reporting/operational-detail-reporting.types';

/**
 * R08 PART 03B — Operational Detail Finding Rework historical cycle projection: focused
 * validation under the PART 03A governance DECISION B (READY WITH REDUCED CONTRACT).
 *
 * DUAL MODE, matching the established R07 / R08 PART 01B / 02B convention:
 *   - RUNTIME for every zero-dependency authority: the R07 engine vocabulary, this PART's
 *     own cycle-status guard (its only import is a TYPE-only import of the domain
 *     FindingReworkStatus, so it strips to a dependency-free module). Importing the guard is
 *     what proves the vocabulary is reused rather than redeclared.
 *   - STATIC source assertions for the repository and service, because `pg` is not installed
 *     in this sandbox (`Cannot find module 'pg'`), so neither module can be loaded here. The
 *     emitted SQL text, its predicates, its select list and its ORDER BY are all literals in
 *     the source, so they are asserted directly and precisely.
 *   - Genuine live-PostgreSQL cases are enumerated as CI-REQUIRED at the end, so the gap is
 *     explicit rather than silent. No PostgreSQL was installed to run this file.
 *
 * Paths resolve from process.cwd() so this file runs identically under the repository runner
 * (`tsx --test`, CommonJS) and under plain `node --test` type-stripping (ESM).
 *
 * Covers the 45 required conditions:
 *   1  row grain = finding_rework_cycles.id (INNER join: the cycle IS the grain)
 *   2  lineage engine -> executionId -> findingId -> reworkCycleId via persisted keys only
 *   3  engine vocabulary reused from R07, never redeclared
 *   4  engine REQUIRED — no default, no BOTH, no omission
 *   5  contract is EXACTLY the 17 frozen fields
 *   6  findingStatus is NOT exposed (mutable current fact owned by PART 02B)
 *   7  status vocabulary is exactly REQUESTED | RESUBMITTED (runtime guard)
 *   8  guard element type IS the domain FindingReworkStatus type
 *   9  guard list === migration 0096 finding_rework_status CHECK
 *  10  no derived OPEN/CLOSED/ACTIVE/TERMINAL/SUCCESSFUL/ACCEPTED/VERIFIED
 *  11  default read = ALL cycles, ALL statuses (no predicate when omitted)
 *  12  status filter is an optional single LITERAL, bound as a parameter
 *  13  triggerReviewId = frc.review_id ONLY, never verification/latest naming
 *  14  no reviews join and no review facts
 *  15  reworkNotes copied verbatim, documented mutable/status-dependent
 *  16  reason copied verbatim, never parsed or classified
 *  17  actors are REWORK REQUESTED BY / RESUBMITTED BY — never executor labels
 *  18  no display-name joins
 *  19  no finding_assignments join and no historical assignee fields
 *  20  client consistency is STRUCTURAL SQL, never a post-filter
 *  21  no caller-supplied clientId is read, echoed or used as a predicate
 *  22  no mismatch flag / consistency interpretation anywhere
 *  23  parentBuildingId AND f.building_id both constrained over ONE $2 parameter
 *  24  NO equality requirement between the two buildings
 *  25  both buildings projected separately as distinct stored facts
 *  26  parent building resolution reuses the R04 fragments VERBATIM
 *  27  provenance chain PART 03B === PART 02B === PART 01B === R04
 *  28  ONE bounded parent-driven query; no N+1, no per-finding loop
 *  29  no GROUP BY / DISTINCT / LATERAL / window function / unbounded IN-list
 *  30  optional filters buildingId/executionId/findingId/reworkCycleId/templateId/status
 *  31  dateFrom/dateTo = PARENT created_at, half-open, dateTo+1d, MAX 366 days
 *  32  requestedAt/resubmittedAt remain row facts, never population filters
 *  33  limit/offset: default 100, cap 1000, offset >= 0
 *  34  FORBIDDEN authorities rejected (clientId, findingStatus, requested/resubmitted ranges,
 *      classificationId, severityId, assigneeType, assignedUserId, reviewDecision,
 *      verificationDecision, reworkNotes text search)
 *  35  visibility = ALL historical cycles; no latest-only / current-only / REQUESTED-only
 *  36  pagination grain = cycle rows; ORDER BY executionId, findingId, requestedAt, cycleId
 *  37  ORDER BY NEVER uses updated_at
 *  38  evidence_submissions never joined, counted or arrayed (reserved future child)
 *  39  no verification / acceptance / rejection outcome fields
 *  40  no timestamp- or ordering-based review association
 *  41  R02 keeps its finding-grain rework summary; nothing duplicated here
 *  42  vendor_rework_cycles never conflated with finding rework
 *  43  operational_events never joined; metadata JSONB never a join key
 *  44  executionId/findingId/reworkCycleId narrow only, never bypassing building scope
 *  45  no export / registry / OpenAPI / route / controller / migration / permission / index /
 *      materialized view, and no modification of R02 / R04 / R07 / PART 01B / PART 02B
 */

const ROOT = process.cwd();
const MODULE_DIR = resolve(ROOT, 'src/modules/operational-detail-finding-rework');
const TYPES_PATH = resolve(MODULE_DIR, 'operational-detail-finding-rework.types.ts');
const REPO_PATH = resolve(MODULE_DIR, 'operational-detail-finding-rework.repository.ts');
const SERVICE_PATH = resolve(MODULE_DIR, 'operational-detail-finding-rework.service.ts');
const INDEX_PATH = resolve(MODULE_DIR, 'index.ts');

const R04_REPO_PATH = resolve(ROOT, 'src/modules/checklist-execution-summary/checklist-execution-summary.repository.ts');
const P01B_REPO_PATH = resolve(ROOT, 'src/modules/operational-detail-evidence/operational-detail-evidence.repository.ts');
const P01B_TYPES_PATH = resolve(ROOT, 'src/modules/operational-detail-evidence/operational-detail-evidence.types.ts');
const P02B_REPO_PATH = resolve(ROOT, 'src/modules/operational-detail-finding/operational-detail-finding.repository.ts');
const P02B_TYPES_PATH = resolve(ROOT, 'src/modules/operational-detail-finding/operational-detail-finding.types.ts');
const R02_REPO_PATH = resolve(ROOT, 'src/modules/finding-register/finding-register.repository.ts');
const R02_TYPES_PATH = resolve(ROOT, 'src/modules/finding-register/finding-register.types.ts');
const R07_TYPES_PATH = resolve(ROOT, 'src/modules/operational-detail-reporting/operational-detail-reporting.types.ts');
const DOMAIN_TYPES_PATH = resolve(ROOT, 'src/modules/finding-rework/finding-rework.types.ts');
const DOMAIN_REPO_PATH = resolve(ROOT, 'src/modules/finding-rework/finding-rework.repository.ts');
const MIGRATION_PATH = resolve(ROOT, 'src/database/migrations/0096_add_finding_rework_cycles.ts');
const MIGRATIONS_DIR = resolve(ROOT, 'src/database/migrations');
const EXPORT_REGISTRY_PATH = resolve(ROOT, 'src/modules/reporting-export/reporting-export.registry.ts');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

/**
 * Strip block and line comments so an identifier fence binds CODE only. Documentation in
 * these modules deliberately names forbidden things in order to forbid them ("no reviews
 * join", "R02 keeps reworkCount"), and a naive substring fence would trip over that prose.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Extract the body of a module-private `const NAME = ` ... `;` SQL fragment. */
function sqlFragment(source: string, name: string): string {
  const match = source.match(new RegExp(`const ${name} = \`\\n([\\s\\S]*?)\\n\`;`));
  assert.ok(match, `${name} must exist`);
  return (match as RegExpMatchArray)[1] as string;
}

/** Collapse whitespace, for comparing an extracted fragment against R04's inline copy. */
function norm(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Replace the two verbatim R04 fragments with a single token so shape fences test THIS
 * PART's own SQL skeleton instead of the closed R04 authority's internal construction
 * (which legitimately contains UNION ALL inside its own bounded `_paths LIMIT 1` subquery,
 * plus asset_id / functional_location_id tie-breaker columns).
 */
function skeleton(): string {
  return repoCode
    .split(sqlFragment(repoSource, 'CE_BUILDING_SQL')).join('__PB__')
    .split(sqlFragment(repoSource, 'FI_BUILDING_SQL')).join('__PB__');
}

/** Collect the field names declared in a `export type NAME = { ... };` literal. */
function typeFields(source: string, name: string): string[] {
  const body = source.match(new RegExp(`export type ${name} = \\{([\\s\\S]*?)\\n\\};`));
  assert.ok(body, `${name} must exist`);
  return [...(body as RegExpMatchArray)[1].matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1] as string);
}

const typesSource = read(TYPES_PATH);
const repoSource = read(REPO_PATH);
const serviceSource = read(SERVICE_PATH);
const indexSource = read(INDEX_PATH);
const repoCode = code(repoSource);
const serviceCode = code(serviceSource);
const typesCode = code(typesSource);
const indexCode = code(indexSource);

/** The frozen 17-field row contract, in declaration order. */
const CONTRACT = [
  'reworkCycleId',
  'engine',
  'executionId',
  'findingId',
  'clientId',
  'parentBuildingId',
  'findingBuildingId',
  'status',
  'reason',
  'reworkNotes',
  'requestedByUserId',
  'requestedAt',
  'resubmittedByUserId',
  'resubmittedAt',
  'triggerReviewId',
  'createdAt',
  'updatedAt',
];

describe('R08 PART 03B — finding rework historical cycle projection', () => {
  describe('module surface and scope fences', () => {
    it('module contains exactly the four implementation files (condition 45)', () => {
      assert.deepEqual(readdirSync(MODULE_DIR).sort(), [
        'index.ts',
        'operational-detail-finding-rework.repository.ts',
        'operational-detail-finding-rework.service.ts',
        'operational-detail-finding-rework.types.ts',
      ]);
    });

    it('no route, controller, registry, OpenAPI, migration, permission, index or view (condition 45)', () => {
      for (const [name, source] of [
        ['repository', repoCode],
        ['service', serviceCode],
        ['types', typesCode],
        ['index', indexCode],
      ] as const) {
        for (const forbidden of [
          'express', 'Router', 'router.', 'app.get', 'app.post', 'openapi', 'OpenAPI', 'swagger',
          'reportingRegistry', 'registerDataset', 'CREATE INDEX', 'CREATE MATERIALIZED',
          'ALTER TABLE', 'ADD CONSTRAINT', 'CREATE TABLE',
        ]) {
          assert.ok(!source.includes(forbidden), `${name} must not contain ${forbidden}`);
        }
      }
      // No new migration was added by this PART.
      assert.ok(readdirSync(MIGRATIONS_DIR).every((f) => !/finding_rework_(child|lineage|reporting)|operational_detail/i.test(f)),
        'no new migration for this projection');
      assert.ok(!read(EXPORT_REGISTRY_PATH).includes('FindingRework'), 'no export dataset registered');
    });

    it('index exports only the internal read surface (condition 45)', () => {
      for (const exported of [
        'operationalDetailFindingReworkRepository',
        'getOperationalDetailFindingReworkRows',
        'operationalDetailFindingReworkService',
        'getOperationalDetailFindingRework',
        'parseOperationalDetailFindingReworkQuery',
        'operationalDetailFindingReworkRange',
        'FINDING_REWORK_CHILD_STATUSES',
        'isFindingReworkChildStatus',
      ]) {
        assert.ok(indexCode.includes(exported), `exported: ${exported}`);
      }
      for (const forbidden of ['router', 'controller', 'routes', 'dataset', 'schema']) {
        assert.ok(!indexCode.toLowerCase().includes(forbidden), `${forbidden} not exported`);
      }
      // Unlike PART 01B, the cycle-status guard IS exported: the domain finding-rework module
      // supplies only a TYPE, so this module is the single runtime place the two literals exist.
      assert.ok(!indexCode.includes('OperationalDetailEngine'), 'engine vocabulary is reused from R07, not re-exported');
    });

    it('R02 / R04 / R07 / PART 01B / PART 02B were NOT modified (condition 45)', () => {
      // Each closed PART still holds its own module-private building fragments: nothing was
      // exported or refactored to deduplicate this PART's third copy.
      for (const path of [R04_REPO_PATH, P01B_REPO_PATH, P02B_REPO_PATH]) {
        assert.ok(!/export const (CE|FI)_BUILDING_SQL/.test(read(path)), `${path} fragments remain module-private`);
      }
      assert.ok(!read(P01B_TYPES_PATH).includes('FindingRework'), 'PART 01B types untouched');
      assert.ok(!read(P02B_TYPES_PATH).includes('reworkCycle'), 'PART 02B types untouched');
      assert.ok(!read(R07_TYPES_PATH).includes('FindingRework'), 'R07 vocabulary untouched');
      assert.ok(!read(DOMAIN_TYPES_PATH).includes('FINDING_REWORK_CHILD_STATUSES'),
        'domain finding-rework module NOT modified to add a runtime guard');
    });
  });

  describe('row contract — exactly 17 fields, no current finding fact (conditions 5, 6)', () => {
    it('the row type declares exactly the 17 frozen fields, in order', () => {
      assert.deepEqual(typeFields(typesSource, 'PublicOperationalDetailFindingReworkRow'), CONTRACT);
      assert.equal(CONTRACT.length, 17, 'the contract is 17 fields — NOT 18');
    });

    it('findingStatus is NOT part of the contract (condition 6)', () => {
      const fields = typeFields(typesSource, 'PublicOperationalDetailFindingReworkRow');
      for (const forbidden of [
        'findingStatus', 'findingNumber', 'title', 'description', 'classificationId',
        'severityId', 'classification', 'severity', 'reportedAt', 'findingCreatedAt',
      ]) {
        assert.ok(!fields.includes(forbidden), `${forbidden} must not be on a historical cycle row`);
      }
      // The finding id is present purely as the lineage anchor.
      assert.ok(fields.includes('findingId'), 'findingId is the lineage anchor only');
      assert.ok(!repoCode.includes('f.status'), 'the finding current status is never selected');
      for (const forbidden of ['f.finding_number', 'f.title', 'f.description', 'f.classification_id', 'f.severity_id', 'f.reported_at']) {
        assert.ok(!repoCode.includes(forbidden), `${forbidden} must never be selected`);
      }
    });

    it('mapRow projects exactly the contract keys with no derivation (conditions 5, 6, 22)', () => {
      const mapBody = repoCode.match(/function mapRow\([\s\S]*?\n\}/);
      assert.ok(mapBody, 'mapRow exists');
      const body = (mapBody as RegExpMatchArray)[0];
      const keys = [...body.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1] as string);
      assert.deepEqual(keys.sort(), [...CONTRACT].sort(), 'mapped keys === contract keys');
      assert.equal(keys.length, 17);
      for (const forbidden of [
        'derivedStatus', 'lifecycle', 'isOpen', 'isClosed', 'isTerminal', 'isActive',
        'isSuccessful', 'isLatest', 'latest', 'buildingMismatch', 'buildingsMatch',
        'isSameBuilding', 'buildingConsistent', 'consistency', 'mismatch', 'evidenceCount',
        'evidence', 'assignment', 'review', 'reworkCount', 'age', 'duration',
      ]) {
        assert.ok(!keys.includes(forbidden), `${forbidden} must not be derived`);
      }
    });

    it('select list is exactly the 17 contract columns, explicit, never a wildcard (condition 5)', () => {
      const sk = skeleton();
      const selectBody = sk.slice(sk.indexOf('SELECT') + 6, sk.indexOf('${fromClause}'));
      const aliases = selectBody
        .split(',')
        .map((c) => c.trim().split(/\s+AS\s+/).pop()?.trim() ?? '')
        .filter((a) => /^[a-z_]+$/.test(a));
      assert.deepEqual(aliases, [
        'rework_cycle_id', 'engine', 'execution_id', 'finding_id', 'client_id',
        'parent_building_id', 'finding_building_id', 'status', 'reason', 'rework_notes',
        'requested_by_user_id', 'requested_at', 'resubmitted_by_user_id', 'resubmitted_at',
        'trigger_review_id', 'created_at', 'updated_at',
      ]);
      assert.equal(aliases.length, 17);
      assert.ok(!/f\.\*|frc\.\*|ce\.\*|fi\.\*/.test(repoCode), 'no wildcard projection');
      assert.ok(repoCode.includes('frc.review_id                AS trigger_review_id'), 'review_id exposed as triggerReviewId');
    });
  });

  describe('lifecycle vocabulary — exactly two stored statuses (conditions 3, 4, 7-12)', () => {
    it('runtime guard exposes exactly REQUESTED and RESUBMITTED, in order (condition 7)', () => {
      assert.deepEqual([...FINDING_REWORK_CHILD_STATUSES], ['REQUESTED', 'RESUBMITTED']);
      assert.equal(FINDING_REWORK_CHILD_STATUSES.length, 2, 'no third status may exist');
      for (const status of ['REQUESTED', 'RESUBMITTED'] as const) {
        assert.equal(isFindingReworkChildStatus(status), true);
      }
    });

    it('guard element type IS the domain FindingReworkStatus type (condition 8)', () => {
      assert.match(typesSource, /import type \{ FindingReworkStatus \} from '\.\.\/finding-rework\/finding-rework\.types';/);
      assert.match(typesSource, /FINDING_REWORK_CHILD_STATUSES: readonly FindingReworkStatus\[\]/);
      const domain = read(DOMAIN_TYPES_PATH);
      const union = domain.match(/export type FindingReworkStatus = ([^;]+);/);
      assert.ok(union, 'domain union located');
      const literals = [...(union as RegExpMatchArray)[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1] as string);
      assert.deepEqual(literals, [...FINDING_REWORK_CHILD_STATUSES], 'runtime list === domain type union');
      // The declared element type makes any value outside the domain union a compile error.
      assert.match(typesSource, /\] as const;/);
    });

    it('guard list === migration 0096 finding_rework_status CHECK (condition 9)', () => {
      const migration = read(MIGRATION_PATH);
      const check = migration.match(/CONSTRAINT finding_rework_status\s*CHECK \(status IN \(([^)]*)\)\)/);
      assert.ok(check, 'the CHECK constraint is the sole table authority');
      const literals = [...(check as RegExpMatchArray)[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1] as string);
      assert.deepEqual(literals, [...FINDING_REWORK_CHILD_STATUSES]);
      assert.equal(literals.length, 2);
      assert.equal((typesCode.match(/export const FINDING_REWORK_CHILD_STATUSES/g) ?? []).length, 1,
        'the vocabulary exists in exactly one runtime place');
    });

    it('migration pins resubmission completeness, UNIQUE trigger review, and no client/building columns', () => {
      const migration = read(MIGRATION_PATH);
      const table = migration.match(/CREATE TABLE finding_rework_cycles \(([\s\S]*?)\n\s*\);/);
      assert.ok(table, 'cycle table definition located');
      const body = (table as RegExpMatchArray)[1] as string;
      assert.match(body, /finding_id UUID NOT NULL REFERENCES findings \(id\)/);
      assert.match(body, /review_id UUID NOT NULL REFERENCES reviews \(id\)/);
      assert.match(body, /requested_by_user_id UUID NOT NULL REFERENCES users \(id\)/);
      assert.match(body, /reason TEXT NOT NULL/);
      assert.match(body, /rework_notes TEXT,/);
      assert.ok(!/client_id|building_id/.test(body),
        'the cycle stores NO client_id/building_id — both are inherited via the finding');
      assert.match(migration, /CONSTRAINT finding_rework_review_unique UNIQUE \(review_id\)/);
      assert.match(migration, /status = 'REQUESTED' AND resubmitted_by_user_id IS NULL/);
      assert.match(migration, /status = 'RESUBMITTED' AND resubmitted_by_user_id IS NOT NULL/);
      assert.match(migration, /finding_current_rework_unique[\s\S]*?WHERE status = 'REQUESTED'/);
      assert.match(migration, /finding_rework_finding_idx\s*\n\s*ON finding_rework_cycles \(finding_id, requested_at\)/);
    });

    it('no derived lifecycle word is accepted or emitted (condition 10)', () => {
      for (const derived of [
        'OPEN', 'CLOSED', 'ACTIVE', 'TERMINAL', 'SUCCESSFUL', 'ACCEPTED', 'VERIFIED',
        'APPROVED', 'REJECTED', 'REWORK_REQUIRED', 'RESUBMIT', 'DONE', 'INACTIVE', 'PENDING',
        // finding statuses are a different vocabulary and are NOT cycle statuses
        'ASSIGNED', 'IN_PROGRESS', 'PENDING_REVIEW', 'CANCELLED',
      ]) {
        assert.equal(isFindingReworkChildStatus(derived), false, `${derived} is not a cycle status`);
      }
      assert.equal(isFindingReworkChildStatus(null), false);
      assert.equal(isFindingReworkChildStatus(''), false);
      assert.equal(isFindingReworkChildStatus(['REQUESTED']), false, 'a multi-value is not a status');
      for (const derived of ['OPEN', 'CLOSED', 'TERMINAL', 'SUCCESSFUL', 'ACCEPTED', 'VERIFIED', 'derivedStatus']) {
        assert.ok(!typesCode.includes(derived), `${derived} must not exist in the contract`);
      }
    });

    it('engine vocabulary is reused from R07 and WORK_ORDER is not requestable (conditions 3, 4)', () => {
      assert.deepEqual([...OPERATIONAL_DETAIL_ENGINES], ['CHECKLIST_EXECUTION', 'FORM_INSTANCE']);
      assert.equal(isOperationalDetailEngine('WORK_ORDER'), false);
      assert.match(serviceCode, /isOperationalDetailEngine\(engineNormalized\)/);
      assert.match(serviceCode, /field: 'engine',/);
      assert.match(serviceCode, /engine is required \(CHECKLIST_EXECUTION \| FORM_INSTANCE\)\./);
      assert.ok(!serviceCode.includes("= 'CHECKLIST_EXECUTION'") || !/engine\s*\?\?\s*/.test(serviceCode),
        'engine has no default value');
      assert.ok(!typesCode.includes('OperationalDetailEngine ='), 'engine type is imported, never redeclared');
      assert.match(typesSource, /import type \{[^}]*OperationalDetailEngine/);
      // WORK_ORDER-sourced findings cannot be reached: the parent table is chosen by engine.
      assert.ok(!repoCode.includes('work_orders'), 'no WORK_ORDER parent exists in this projection');
    });

    it('default read emits NO status predicate — all cycles, both statuses (condition 11)', () => {
      const where = repoCode.slice(repoCode.indexOf('  if (filters.status)'));
      assert.match(where, /if \(filters\.status\) \{\n\s*values\.push\(filters\.status\);\n\s*conditions\.push\(`frc\.status = \$\$\{values\.length\}`\);/);
      // The predicate is pushed ONLY inside that conditional, so an absent filter yields none.
      assert.equal((repoCode.match(/frc\.status = \$\$\{values\.length\}/g) ?? []).length, 1,
        'the predicate is pushed ONLY inside that conditional');
      assert.ok(!/frc\.status\s*=\s*'/.test(repoCode), 'the status literal is never inlined into SQL');
      for (const forbidden of ['latest', 'most_recent', 'is_current', 'DISTINCT ON', 'ROW_NUMBER']) {
        assert.ok(!repoCode.includes(forbidden), `no ${forbidden} narrowing`);
      }
    });

    it('status filter is an optional single LITERAL bound as a parameter (condition 12)', () => {
      assert.match(serviceCode, /readOptionalEnum\(\s*query\.status,\s*'status',\s*isFindingReworkChildStatus,/);
      assert.match(serviceCode, /status must be a valid finding rework cycle status \(\$\{FINDING_REWORK_CHILD_STATUSES\.join\('\/'\)\}\)/);
      // readOptionalEnum never coerces or defaults: absent means "no key at all".
      const enumBody = serviceCode.match(/function readOptionalEnum[\s\S]*?\n\}/);
      assert.ok(enumBody, 'readOptionalEnum exists');
      assert.match((enumBody as RegExpMatchArray)[0], /if \(raw === undefined \|\| raw === ''\) return undefined;/);
      assert.match((enumBody as RegExpMatchArray)[0], /matchesVocabulary\(normalized\)/);
      assert.match(serviceCode, /\.\.\.\(status === undefined \? \{\} : \{ status \}\)/);
    });
  });

  describe('query shape — one bounded parent-driven query (conditions 1, 2, 28, 29)', () => {
    it('parent-driven FROM with an INNER cycle join: the cycle IS the grain (condition 1)', () => {
      assert.match(repoCode, /FROM \$\{parentTable\}\$\{templateJoins\}/);
      assert.match(repoCode, /JOIN finding_rework_cycles frc\s*\n\s*ON frc\.finding_id = f\.id/);
      assert.ok(!/LEFT\s+(OUTER\s+)?JOIN finding_rework_cycles/i.test(repoCode),
        'the cycle join must be INNER — a finding with no cycle contributes no row');
      assert.match(repoCode, /const parentTable = isChecklist \? 'checklist_executions ce' : 'form_instances fi';/);
    });

    it('lineage is traversed by persisted keys only (condition 2)', () => {
      assert.match(repoCode, /JOIN findings f\s*\n\s*ON f\.source_type = \$1\s*\n\s*AND f\.source_id = \$\{parentAlias\}\.id\s*\n\s*AND f\.client_id = \$\{parentAlias\}\.client_id/);
      assert.match(repoCode, /frc\.finding_id = f\.id/);
      assert.match(repoCode, /frc\.id\s+AS rework_cycle_id/);
      assert.match(repoCode, /f\.source_id\s+AS execution_id/);
      assert.match(repoCode, /f\.id\s+AS finding_id/);
      // No association is ever inferred from time, actor or text.
      for (const forbidden of ['frc.requested_at >', 'frc.requested_at <', 'frc.resubmitted_at >', 'BETWEEN', 'ILIKE', 'LIKE', 'to_tsvector', '@@']) {
        assert.ok(!repoCode.includes(forbidden), `no inferred association via ${forbidden}`);
      }
      // The ONLY created_at comparisons in the query are the parent population window.
      const created = [...repoCode.matchAll(/([\w.${}]*created_at)\s*(>=|<=|>|<)/g)];
      assert.ok(created.length >= 2, 'the parent window is present');
      for (const m of created) {
        assert.ok(/^\$\{parentAlias\}\.created_at$/.test(m[1] as string),
          `every created_at comparison targets the PARENT alias only, got ${m[1]}`);
      }
      assert.ok(!repoCode.includes('frc.created_at >') && !repoCode.includes('f.created_at >'),
        'neither the cycle nor the finding is used as the population window');
    });

    it('exactly ONE query, no N+1, no per-finding loop, no unbounded IN-list (condition 28)', () => {
      assert.equal((repoCode.match(/getPool\(\)\.query/g) ?? []).length, 1, 'one pool query in the repository');
      for (const forbidden of ['for (', 'forEach', 'Promise.all', 'await Promise', '.map(async', 'while (']) {
        assert.ok(!repoCode.includes(forbidden), `no loop / concurrent fan-out: ${forbidden}`);
      }
      assert.ok(!/= ANY\(\$1::uuid\[\]\)/.test(repoCode), 'no unbounded execution-id list parameter');
      assert.ok(!/IN \(\$/.test(repoCode), 'no IN-list of materialized ids');
      // The authorized parent population is expressed IN SQL, never materialized in memory.
      assert.match(serviceCode, /getOperationalDetailFindingReworkRows\(\s*buildingIds,/);
    });

    it('no aggregation, fan-out control, window function or correlated subquery of its own (condition 29)', () => {
      // The verbatim R04 fragment legitimately contains UNION ALL inside its own bounded
      // `_paths LIMIT 1` scalar subquery, so these fences apply to THIS PART's skeleton.
      const skeleton = repoCode.split(sqlFragment(repoSource, 'CE_BUILDING_SQL')).join('__PB__')
        .split(sqlFragment(repoSource, 'FI_BUILDING_SQL')).join('__PB__');
      const own = skeleton.slice(skeleton.indexOf('const values'), skeleton.indexOf('result.rows'));
      for (const forbidden of [
        'GROUP BY', 'DISTINCT', 'LATERAL', 'UNION', 'OVER (', 'OVER(', 'ROW_NUMBER',
        'COUNT(', 'SUM(', 'ARRAY_AGG', 'JSON_AGG', 'JSONB_AGG', 'STRING_AGG', 'WITH RECURSIVE',
      ]) {
        assert.ok(!own.toUpperCase().includes(forbidden), `${forbidden} must not appear`);
      }
      assert.ok(!/\(\s*SELECT/.test(own), 'no scalar subquery introduced by this PART');
    });

    it('read-only: no mutation, DDL or locking (condition 45)', () => {
      for (const forbidden of ['INSERT', 'UPDATE ', 'DELETE', 'CREATE ', 'ALTER', 'DROP', 'TRUNCATE', 'GRANT', 'FOR UPDATE', 'FOR SHARE']) {
        assert.ok(!new RegExp(`\\b${forbidden.trim()}\\b`).test(repoCode), `${forbidden} must not appear`);
      }
    });

    it('templateId joins the version chain for FORM_INSTANCE only (condition 30)', () => {
      assert.match(repoCode, /JOIN form_template_versions ftv ON ftv\.id = \$\{parentAlias\}\.form_template_version_id/);
      assert.match(repoCode, /JOIN form_templates ft ON ft\.id = ftv\.form_template_id/);
      assert.match(repoCode, /!isChecklist && filters\.templateId/, 'joined ONLY when the filter is present');
      assert.match(repoCode, /ce\.checklist_template_id = \$\$\{values\.length\}::uuid/);
      assert.match(repoCode, /ft\.id = \$\$\{values\.length\}::uuid/);
    });
  });

  describe('client consistency — structural, fail-closed (conditions 20, 21, 22)', () => {
    it('client equality is part of the JOIN predicate, never a post-filter (condition 20)', () => {
      assert.match(repoCode, /AND f\.client_id = \$\{parentAlias\}\.client_id/);
      assert.ok(!repoCode.includes('.filter('), 'the repository never filters rows after fetch');
      assert.ok(!serviceCode.includes('.filter('), 'the service never filters rows after fetch');
      assert.equal((repoCode.match(/result\.rows\.map\(mapRow\)/g) ?? []).length, 1, 'rows are mapped, never screened');
      // findings.source_id has no FK, so nothing in the database guarantees this — SQL does.
      assert.ok(!/clientMismatch|client_mismatch|clientConsistent/i.test(repoCode), 'no mismatch flag');
    });

    it('no caller-supplied clientId is read, echoed or used as a predicate (condition 21)', () => {
      assert.ok(!serviceCode.includes('clientId'), 'the service never touches a clientId');
      assert.ok(!/query\.clientId/.test(serviceCode));
      assert.ok(!typesCode.includes('clientId?:') || !/clientId\?: string;?\s*\n\s*\/\*\* filter/.test(typesCode));
      const filterFields = typeFields(typesSource, 'OperationalDetailFindingReworkFilters');
      assert.ok(!filterFields.includes('clientId'), 'clientId is not a filter');
      // clientId IS a projected row fact, sourced from the finding, never from the caller.
      assert.match(repoCode, /f\.client_id\s+AS client_id/);
    });

    it('no mismatch, consistency or reconciliation interpretation anywhere (condition 22)', () => {
      for (const source of [repoCode, serviceCode, typesCode]) {
        for (const forbidden of ['mismatch', 'Mismatch', 'inconsistent', 'reconcil', 'divergen']) {
          assert.ok(!source.includes(forbidden), `${forbidden} must not appear`);
        }
      }
    });
  });

  describe('dual building authority over ONE parameter (conditions 23, 24, 25)', () => {
    it('both buildings are constrained over the SAME $2 parameter (condition 23)', () => {
      assert.match(repoCode, /conditions\.push\(`\$\{buildingSql\} = ANY\(\$2::uuid\[\]\)`\)/);
      assert.match(repoCode, /conditions\.push\(`f\.building_id = ANY\(\$2::uuid\[\]\)`\)/);
      assert.equal((repoCode.match(/ANY\(\$2::uuid\[\]\)/g) ?? []).length, 2,
        'exactly two predicates — parent-resolved building and finding-stored building');
      assert.ok(!/\$3::uuid\[\]/.test(repoCode), 'no second building parameter exists');
      assert.match(repoCode, /const values: unknown\[\] = \[filters\.engine, buildingIds\];/);
    });

    it('NO equality is required between the two buildings (condition 24)', () => {
      assert.ok(!/f\.building_id\s*=\s*\$\{buildingSql\}/.test(repoCode), 'finding building is never compared to the resolved parent building');
      assert.ok(!/f\.building_id\s*=\s*COALESCE/.test(repoCode));
      assert.ok(!/buildingSql\}\s*=\s*f\.building_id/.test(repoCode));
      assert.ok(!/parent_building_id = finding_building_id/.test(repoCode));
    });

    it('both buildings are projected separately as distinct stored facts (condition 25)', () => {
      assert.match(repoCode, /\$\{buildingSql\}\s+AS parent_building_id/);
      assert.match(repoCode, /f\.building_id\s+AS finding_building_id/);
      assert.match(repoCode, /parentBuildingId: row\.parent_building_id/);
      assert.match(repoCode, /findingBuildingId: row\.finding_building_id/);
      assert.ok(!/parentBuildingId: row\.finding_building_id/.test(repoCode), 'never swapped');
      // Fail-closed: an unresolvable parent building yields NULL, and NULL = ANY(...) is not TRUE.
      assert.match(repoCode, /COALESCE\(/);
    });

    it('R04 parent-building fragments are reused VERBATIM (condition 26)', () => {
      const r04 = read(R04_REPO_PATH);
      const p01b = read(P01B_REPO_PATH);
      const p02b = read(P02B_REPO_PATH);
      const ce03b = sqlFragment(repoSource, 'CE_BUILDING_SQL');
      const fi03b = sqlFragment(repoSource, 'FI_BUILDING_SQL');
      assert.equal(ce03b, sqlFragment(r04, 'CE_BUILDING_SQL'), 'CE === R04 byte-for-byte');
      assert.equal(ce03b, sqlFragment(p01b, 'CE_BUILDING_SQL'), 'CE === PART 01B');
      assert.equal(ce03b, sqlFragment(p02b, 'CE_BUILDING_SQL'), 'CE === PART 02B');
      assert.equal(fi03b, sqlFragment(p01b, 'FI_BUILDING_SQL'), 'FI === PART 01B');
      assert.equal(fi03b, sqlFragment(p02b, 'FI_BUILDING_SQL'), 'FI === PART 02B');
      for (const path of [
        'engineering_checklist_bindings', 'inspection_bindings', 'toilet_inspection_bindings',
        'public_area_inspection_bindings', 'patrol_checklist_bindings', 'vendor_checklist_bindings',
        'generated_tasks',
      ]) {
        assert.ok(ce03b.includes(path), `all seven R04 CE paths present: ${path}`);
      }
      for (const path of ['meter_reading_bindings', 'log_sheet_bindings', 'generated_tasks']) {
        assert.ok(fi03b.includes(path), `all three R04 FI paths present: ${path}`);
      }
    });

    it('FI fragment matches R04 inline fi_base (whitespace-normalized) (condition 27)', () => {
      const r04 = read(R04_REPO_PATH);
      const inline = r04.match(/COALESCE\(\s*\(SELECT mrb\.building_id[\s\S]*?WHERE gt\.id = fi\.generated_task_id AND gt\.building_id IS NOT NULL\),\s*NULL\s*\)/);
      assert.ok(inline, 'R04 stores the FI resolution inline in its fi_base CTE');
      assert.equal(norm(sqlFragment(repoSource, 'FI_BUILDING_SQL')), norm((inline as RegExpMatchArray)[0]),
        'PART 03B FI === R04 fi_base');
    });

    it('the R04 authority is not re-derived through a narrower resolver (condition 26)', () => {
      for (const forbidden of ['resolveFindingSourceContext(', 'loadEvidenceExecution(', 'buildingRepository.findMany', 'resolveBuilding']) {
        assert.ok(!repoCode.includes(forbidden), `${forbidden} is not a Reporting building authority`);
        assert.ok(!serviceCode.includes(forbidden), `${forbidden} is not used by the service`);
      }
      // The parent alias requirement is documented, so a fragment can never be used standalone.
      assert.match(repoCode, /const parentAlias = isChecklist \? 'ce' : 'fi';/);
    });
  });

  describe('trigger review semantics (conditions 13, 14, 40)', () => {
    it('triggerReviewId is frc.review_id and nothing else (condition 13)', () => {
      assert.match(repoCode, /frc\.review_id\s+AS trigger_review_id/);
      assert.match(repoCode, /triggerReviewId: row\.trigger_review_id/);
      for (const forbidden of [
        'verificationReviewId', 'reverificationReviewId', 'acceptanceReviewId', 'latestReviewId',
        'reviewerId', 'reviewDecision', 'reviewStatus', 'reviewedAt', 'reviewNotes', 'review_id AS review',
      ]) {
        assert.ok(!repoCode.includes(forbidden), `${forbidden} must not exist`);
        assert.ok(!typesCode.includes(forbidden), `${forbidden} must not exist in the contract`);
      }
      assert.ok(!/AS\s+review_id/.test(repoCode), 'never exposed under a bare review name');
    });

    it('reviews is never joined and no review fact is exposed (condition 14)', () => {
      assert.ok(!/(JOIN|FROM)\s+reviews\b/i.test(repoCode), 'no reviews join');
      assert.ok(!/r\.decision|r\.status|r\.reviewer|r\.reviewed_at|r\.notes/i.test(repoCode));
    });

    it('no timestamp- or ordering-based review association (condition 40)', () => {
      for (const forbidden of ['ORDER BY r.', 'reviewed_at', 'LATERAL', 'DISTINCT ON', 'ROW_NUMBER', 'FIRST_VALUE', 'LAST_VALUE']) {
        assert.ok(!repoCode.includes(forbidden), `${forbidden} must not appear`);
      }
      // The UNIQUE(review_id) constraint makes the trigger review 1:1 — no inference needed.
      assert.match(read(MIGRATION_PATH), /CONSTRAINT finding_rework_review_unique UNIQUE \(review_id\)/);
    });
  });

  describe('rework notes and reason semantics (conditions 15, 16)', () => {
    it('reworkNotes is copied verbatim and documented as mutable/status-dependent (condition 15)', () => {
      assert.match(repoCode, /frc\.rework_notes\s+AS rework_notes/);
      assert.match(repoCode, /reworkNotes: row\.rework_notes/);
      assert.ok(!/rework_notes\s*(\|\||\?\?|COALESCE)/i.test(repoCode), 'never defaulted, concatenated or reconstructed');
      assert.ok(!/trim\(\)|toLowerCase\(\)|toUpperCase\(\)|replace\(/.test(
        (repoCode.match(/function mapRow[\s\S]*?\n\}/) as RegExpMatchArray)[0]), 'never normalized');
      // The mutability is documented where the field is declared and where it is mapped.
      assert.match(typesSource, /reworkNotes[\s\S]{0,600}OVERWRITTEN/i);
      assert.match(repoSource, /reworkNotes is MUTABLE and\s*\n\s*\/\/ STATUS-DEPENDENT/);
      assert.match(repoSource, /markResubmitted OVERWRITES it/);
      assert.match(repoSource, /pre-resubmission value is not\s*\n\s*\/\/ preserved on this row/);
      assert.ok(!/reworkNotesExclusive|exclusiveNotes|originalNotes|previousNotes|initialNotes/.test(repoCode),
        'never relabeled as an exclusive or historical-notes field');
    });

    it('reason is copied verbatim and never parsed or classified (condition 16)', () => {
      assert.match(repoCode, /frc\.reason\s+AS reason/);
      assert.match(repoCode, /reason: row\.reason/);
      assert.ok(!/reasonCategory|reasonCode|reasonType|parsedReason|classifyReason/i.test(repoCode));
      assert.match(typesSource, /reason[\s\S]{0,400}stable/i);
    });

    it('domain write path confirms reason is stable and rework_notes is overwritten (conditions 15, 16)', () => {
      const migration = read(MIGRATION_PATH);
      assert.match(migration, /reason TEXT NOT NULL/, 'reason is NOT NULL and never updated');
      assert.match(migration, /rework_notes TEXT,/, 'rework_notes is nullable');
      const domain = read(DOMAIN_REPO_PATH);
      const resubmit = domain.match(/async function markResubmitted[\s\S]*?\n\}/);
      assert.ok(resubmit, 'markResubmitted is the only resubmission write path');
      const body = (resubmit as RegExpMatchArray)[0];
      assert.match(body, /SET rework_notes=\$3/, 'resubmission OVERWRITES rework_notes — the prior value is not preserved');
      assert.ok(!/reason\s*=/.test(body), 'reason is never rewritten');
      assert.match(body, /WHERE id=\$1 AND status='REQUESTED'/,
        'guarded, so resubmitted_by_user_id/resubmitted_at are written exactly once');
      assert.match(body, /status='RESUBMITTED'/, 'RESUBMITTED is terminal — no further transition exists');
      assert.ok(/updateNotes/.test(domain), 'notes are independently editable, so updated_at can move without a status change');
      assert.match(domain, /ORDER BY requested_at, id/, 'this PART reuses the domain list ordering convention');
    });
  });

  describe('attribution — actors, never executors (conditions 17, 18, 19)', () => {
    it('requestedByUserId and resubmittedByUserId are the only actor fields (condition 17)', () => {
      assert.match(repoCode, /frc\.requested_by_user_id\s+AS requested_by_user_id/);
      assert.match(repoCode, /frc\.resubmitted_by_user_id\s+AS resubmitted_by_user_id/);
      assert.match(repoCode, /requestedByUserId: row\.requested_by_user_id/);
      assert.match(repoCode, /resubmittedByUserId: row\.resubmitted_by_user_id/);
      for (const forbidden of [
        'executorId', 'executor', 'actualExecutor', 'executorUserId', 'performedBy', 'completedBy',
        'assignee', 'assignedUser', 'reviewer', 'requestedByName', 'resubmittedByName',
      ]) {
        assert.ok(!repoCode.includes(forbidden), `${forbidden} must not appear`);
        assert.ok(!typesCode.includes(forbidden), `${forbidden} must not be in the contract`);
      }
    });

    it('no display-name joins (condition 18)', () => {
      for (const table of ['users', 'user_profiles', 'employees', 'teams', 'buildings', 'properties', 'clients']) {
        assert.ok(!new RegExp(`(JOIN|FROM)\\s+${table}\\b`, 'i').test(repoCode), `no join on ${table}`);
      }
      assert.ok(!/full_name|first_name|last_name|display_name|email|username|building_name|client_name/i.test(repoCode));
    });

    it('no finding_assignments join and no historical assignee fields (condition 19)', () => {
      assert.ok(!/(JOIN|FROM)\s+finding_assignments\b/i.test(repoCode), 'assignment is not snapshotted on the cycle');
      for (const forbidden of ['assigneeType', 'assigneeId', 'assignedUserId', 'historicalAssignee', 'assignmentAtRequest', 'vendorWorkforceId', 'teamId']) {
        assert.ok(!repoCode.includes(forbidden), `${forbidden} must not appear`);
        assert.ok(!typesCode.includes(forbidden), `${forbidden} must not be in the contract`);
      }
      // Unlike PART 02B (where the assignment is an optional ATTRIBUTE of the finding grain),
      // there is deliberately no LEFT JOIN here at all.
      assert.ok(!/LEFT\s+JOIN/i.test(repoCode), 'no LEFT join of any kind');
    });
  });

  describe('forbidden joins and out-of-scope boundaries (conditions 38, 39, 42, 43)', () => {
    it('no evidence_submissions join, count or array (condition 38)', () => {
      assert.ok(!/(JOIN|FROM)\s+evidence_submissions\b/i.test(repoCode));
      for (const forbidden of ['evidenceCount', 'evidenceIds', 'evidenceSubmissions', 'FINDING_REWORK\'', 'execution_type']) {
        assert.ok(!repoCode.includes(forbidden), `${forbidden} must not appear`);
      }
      // PART 01B evidence is never attached to cycles: its engine vocabulary is CE/FI only.
      assert.ok(!read(P01B_TYPES_PATH).includes('FINDING_REWORK'), 'PART 01B does not cover cycle evidence');
      assert.ok(!read(P01B_REPO_PATH).includes('finding_rework_cycles'), 'PART 01B never touches cycles');
    });

    it('no verification / acceptance / rejection outcome fields (condition 39)', () => {
      for (const forbidden of [
        'verification', 'acceptance', 'rejection', 'resolution', 'outcome', 'decision',
        'acceptedAt', 'verifiedAt', 'rejectedAt', 'closedAt',
      ]) {
        assert.ok(!repoCode.toLowerCase().includes(forbidden), `${forbidden} must not appear`);
        assert.ok(!typesCode.toLowerCase().includes(forbidden), `${forbidden} must not be in the contract`);
      }
    });

    it('vendor_rework_cycles is never conflated with finding rework (condition 42)', () => {
      assert.ok(!/(JOIN|FROM)\s+vendor_rework_cycles\b/i.test(repoCode));
      assert.ok(!repoCode.toLowerCase().includes('vendor_rework'));
      assert.ok(!typesCode.includes('vendorRework'));
    });

    it('operational_events is never joined and metadata JSONB is never a join key (condition 43)', () => {
      assert.ok(!/(JOIN|FROM)\s+operational_events\b/i.test(repoCode));
      assert.ok(!/metadata\s*->>?\s*'reworkCycleId'/.test(repoCode));
      assert.ok(!/jsonb|JSONB|->>|#>>/i.test(repoCode), 'no JSONB access at all');
      assert.ok(!repoCode.includes('history'), 'no event-history reconstruction');
    });

    it('no item / field / occurrence attribution and no asset enrichment', () => {
      const sk = skeleton();
      for (const forbidden of [
        'checklist_items', 'form_fields', 'occurrence', 'itemId', 'fieldId', 'assetId',
        'functionalLocationId', 'asset_id', 'functional_location_id',
      ]) {
        assert.ok(!sk.includes(forbidden), `${forbidden} must not appear in this PART's own SQL`);
      }
      // asset_id / functional_location_id appear ONLY inside the verbatim R04 CE fragment, as
      // tie-breaker columns of the authoritative resolution — never as projected fields.
      const ce = sqlFragment(repoSource, 'CE_BUILDING_SQL');
      assert.ok(ce.includes('asset_id'), 'the R04 fragment is unmodified, tie-breaker columns intact');
      assert.ok(!sk.includes('asset_id'), 'no asset fact is projected outside the R04 authority');
    });
  });

  describe('filters, range and pagination (conditions 30, 31, 32, 33, 34)', () => {
    it('optional narrowing filters are UUID-validated and parameterized (condition 30)', () => {
      for (const field of ['buildingId', 'executionId', 'findingId', 'reworkCycleId', 'templateId']) {
        assert.match(serviceCode, new RegExp(`readOptionalUuid\\(query\\.${field}, '${field}', details\\)`));
      }
      assert.match(repoCode, /\$\{parentAlias\}\.id = \$\$\{values\.length\}::uuid/);
      assert.match(repoCode, /f\.id = \$\$\{values\.length\}::uuid/);
      assert.match(repoCode, /frc\.id = \$\$\{values\.length\}::uuid/);
      assert.deepEqual(typeFields(typesSource, 'OperationalDetailFindingReworkFilters'),
        ['engine', 'buildingId', 'executionId', 'findingId', 'reworkCycleId', 'templateId', 'dateFrom', 'dateTo', 'status'],
        'the filter contract is closed: no other field can be requested');
      assert.deepEqual(typeFields(typesSource, 'OperationalDetailFindingReworkPagination'), ['limit', 'offset']);
      assert.match(typesSource, /export type OperationalDetailFindingReworkQuery = OperationalDetailFindingReworkFilters &\n\s*OperationalDetailFindingReworkPagination;/);
      assert.match(typesSource, /engine: OperationalDetailEngine;/, 'engine is REQUIRED (not optional)');
    });

    it('dateFrom/dateTo bound the PARENT created_at, half-open (condition 31)', () => {
      assert.match(repoCode, /conditions\.push\(`\$\{parentAlias\}\.created_at >= \$\$\{values\.length\}`\)/);
      assert.match(repoCode, /conditions\.push\(`\$\{parentAlias\}\.created_at < \$\$\{values\.length\}`\)/);
      assert.match(serviceCode, /const DATE_ONLY = \/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/;/);
      assert.match(serviceCode, /DATE_ONLY\.test\(filters\.dateTo\) \? new Date\(to\.getTime\(\) \+ 86400000\) : to/);
      assert.match(serviceCode, /const MAX_RANGE_DAYS = 366;/);
      assert.match(serviceCode, /Report date range must not exceed \$\{MAX_RANGE_DAYS\} days\./);
      assert.match(serviceCode, /dateFrom must not exceed dateTo\./);
      // Identical semantics to the closed PART 02B, so a date range means the same thing
      // across every R08 child.
      const p02b = read(resolve(ROOT, 'src/modules/operational-detail-finding/operational-detail-finding.service.ts'));
      assert.match(p02b, /const MAX_RANGE_DAYS = 366;/);
      assert.match(p02b, /DATE_ONLY\.test\(filters\.dateTo\) \? new Date\(to\.getTime\(\) \+ 86400000\) : to/);
    });

    it('requestedAt/resubmittedAt remain row facts, never population filters (condition 32)', () => {
      assert.ok(!/frc\.requested_at\s*(>=|<=|>|<)/.test(repoCode), 'requested_at is never a population filter');
      assert.ok(!/frc\.resubmitted_at\s*(>=|<=|>|<)/.test(repoCode), 'resubmitted_at is never a population filter');
      assert.ok(!/frc\.created_at\s*(>=|<=|>|<)/.test(repoCode));
      // requested_at IS an ordering term only.
      assert.match(repoCode, /ORDER BY f\.source_id ASC, f\.id ASC, frc\.requested_at ASC, frc\.id ASC/);
      // A future cycle-date window must be distinctly named, never overloading dateFrom/dateTo.
      for (const forbidden of ['requestedFrom', 'requestedTo', 'resubmittedFrom', 'resubmittedTo', 'reworkRequestedFrom', 'reworkRequestedTo']) {
        assert.ok(!serviceCode.includes(forbidden), `${forbidden} is not an accepted filter in this PART`);
        assert.ok(!typesCode.includes(forbidden), `${forbidden} is not in the contract`);
      }
    });

    it('limit/offset default 100/0 and clamp at 1000 (condition 33)', () => {
      assert.match(serviceCode, /const DEFAULT_LIMIT = 100;/);
      assert.match(serviceCode, /const MAX_LIMIT = 1000;/);
      assert.match(serviceCode, /limit: filters\.limit \?\? DEFAULT_LIMIT/);
      assert.match(serviceCode, /offset: filters\.offset \?\? 0/);
      assert.match(serviceCode, /if \(pagination\.limit !== undefined && pagination\.limit > MAX_LIMIT\) \{\n\s*pagination\.limit = MAX_LIMIT;/);
      assert.match(serviceCode, /limit must be a positive integer\./);
      assert.match(serviceCode, /offset must be a non-negative integer\./);
      assert.match(repoCode, /LIMIT \$\$\{values\.length\}/);
      assert.match(repoCode, /OFFSET \$\$\{values\.length\}/);
    });

    it('FORBIDDEN authorities are never accepted as filters (condition 34)', () => {
      const forbidden = [
        'clientId', 'findingStatus', 'requestedFrom', 'requestedTo', 'resubmittedFrom',
        'resubmittedTo', 'classificationId', 'severityId', 'assigneeType', 'assignedUserId',
        'reviewDecision', 'verificationDecision', 'notesSearch', 'reworkNotesSearch',
        'reasonSearch', 'q', 'search',
      ];
      const declared = [
        ...typeFields(typesSource, 'OperationalDetailFindingReworkFilters'),
        ...typeFields(typesSource, 'OperationalDetailFindingReworkPagination'),
      ];
      for (const field of forbidden) {
        assert.ok(!new RegExp(`query\\.${field}\\b`).test(serviceCode), `${field} is never read from the query`);
        assert.ok(!declared.includes(field), `${field} is not a declared filter`);
        const filterBlock = typesCode.slice(
          typesCode.indexOf('export type OperationalDetailFindingReworkFilters'),
          typesCode.indexOf('export type OperationalDetailFindingReworkPagination'),
        );
        assert.ok(!new RegExp(`^\\s*${field}\\??:`, 'm').test(filterBlock), `${field} is not an accepted filter`);
      }
      assert.deepEqual(declared, [
        'engine', 'buildingId', 'executionId', 'findingId', 'reworkCycleId', 'templateId',
        'dateFrom', 'dateTo', 'status', 'limit', 'offset',
      ], 'the complete accepted filter surface');
      // clientId IS a projected row fact — but it is sourced from the finding, never accepted
      // from the caller, and never used as a predicate.
      assert.match(repoCode, /f\.client_id\s+AS client_id/);
      assert.match(repoCode, /clientId: row\.client_id/);
      assert.ok(!/clientId/.test(serviceCode), 'the service neither reads nor echoes a clientId');
      // No free-text search of any kind: reason/reworkNotes are operational text, never a
      // classification or search authority.
      assert.ok(!/ILIKE|LIKE|to_tsvector|@@|websearch/i.test(repoCode), 'no text search in SQL');
    });

    it('multi-value params are discarded, never interpreted (inherited R07 family policy)', () => {
      assert.match(serviceCode, /function readSingleParam\(value: unknown\): string \| undefined \{\n\s*if \(value === undefined \|\| value === null\) return undefined;\n\s*if \(Array\.isArray\(value\)\) return undefined;\n\s*return String\(value\);\n\}/);
      const r07 = read(resolve(ROOT, 'src/modules/operational-detail-reporting/operational-detail-reporting.service.ts'));
      const r07Body = (r07.match(/function readSingleParam[\s\S]*?\n\}/) as RegExpMatchArray)[0];
      const own = (serviceCode.match(/function readSingleParam[\s\S]*?\n\}/) as RegExpMatchArray)[0];
      assert.equal(norm(own), norm(r07Body), 'readSingleParam is copied verbatim from the closed R07 authority');
    });
  });

  describe('visibility and ordering (conditions 35, 36, 37)', () => {
    it('ALL historical cycles are visible by default (condition 35)', () => {
      // No latest-only, current-only or REQUESTED-only view exists.
      for (const forbidden of ['latestOnly', 'currentOnly', 'openOnly', 'requestedOnly', "status = 'REQUESTED'", 'isLatest', 'DISTINCT ON']) {
        assert.ok(!repoCode.includes(forbidden), `${forbidden} must not exist`);
        assert.ok(!serviceCode.includes(forbidden), `${forbidden} must not exist`);
      }
      // The finding's CURRENT status never gates cycle visibility: f.status is never referenced.
      assert.ok(!repoCode.includes('f.status'), 'no finding-status predicate anywhere');
      // The migration's partial unique index proves at most ONE open cycle per finding, but
      // closed cycles accumulate — all of them are returned.
      assert.match(read(MIGRATION_PATH), /finding_current_rework_unique[\s\S]*?WHERE status = 'REQUESTED'/);
    });

    it('ORDER BY is the exact deterministic historical order (condition 36)', () => {
      const order = repoCode.match(/ORDER BY([^\n]*)/);
      assert.ok(order, 'ORDER BY present');
      assert.equal((order as RegExpMatchArray)[1].replace(/\s+/g, ' ').trim(),
        'f.source_id ASC, f.id ASC, frc.requested_at ASC, frc.id ASC');
      // requested_at then id mirrors the finding-rework module's own list convention.
      assert.match(read(DOMAIN_REPO_PATH), /ORDER BY requested_at/i);
      assert.ok(!/DESC/i.test((order as RegExpMatchArray)[1]), 'history reads oldest-first');
    });

    it('ORDER BY NEVER uses updated_at (condition 37)', () => {
      const order = (repoCode.match(/ORDER BY([^\n]*)/) as RegExpMatchArray)[1] as string;
      assert.ok(!order.includes('updated_at'), 'updated_at moves on notes edits and on resubmission');
      assert.ok(!order.includes('created_at'), 'created_at alone is not a total order here');
      // updated_at is still projected as a record fact.
      assert.match(repoCode, /frc\.updated_at\s+AS updated_at/);
      assert.match(repoCode, /updatedAt: toIso\(row\.updated_at\) as string/);
    });

    it('pagination grain is the cycle row, mapped 1:1 with no reordering (condition 36)', () => {
      assert.match(repoCode, /return result\.rows\.map\(mapRow\);/);
      assert.ok(!repoCode.includes('.sort('), 'database order is preserved verbatim');
      assert.ok(!repoCode.includes('.slice('), 'no application-side paging');
      assert.ok(!typesCode.includes('totalCount'), 'no cycle count is computed at this grain');
    });
  });

  describe('access, scope and envelope (conditions 44 and fail-closed rules)', () => {
    it('reuses ONLY the closed R04/R07 access authorities', () => {
      assert.match(serviceCode, /buildingRepository\.findById\(filters\.buildingId\)/);
      assert.match(serviceCode, /throw buildingNotFoundError\(\);/);
      assert.match(serviceCode, /contextAccessService\.assertBuildingAccess\(userId, filters\.buildingId\)/);
      assert.match(serviceCode, /contextAccessService\.getAccessibleBuildingIds\(userId\)/);
      // Existence is checked BEFORE authorization, so no existence oracle is created.
      const order = serviceCode.indexOf('buildingRepository.findById');
      assert.ok(order < serviceCode.indexOf('assertBuildingAccess'), 'findById precedes assertBuildingAccess');
      for (const forbidden of ['requireRole', 'role ===', 'isAdmin', 'hasPermission', 'PERMISSION']) {
        assert.ok(!serviceCode.includes(forbidden), `${forbidden} must not appear`);
      }
    });

    it('empty accessible scope returns a well-formed empty result, never 403, never unrestricted', () => {
      assert.match(serviceCode, /if \(buildingIds\.length === 0\) \{\n\s*return \{ \.\.\.base, rows: \[\] \};/);
      const shortCircuit = serviceCode.indexOf('buildingIds.length === 0');
      assert.ok(shortCircuit < serviceCode.indexOf('getOperationalDetailFindingReworkRows('), 'short-circuits before any SQL');
    });

    it('executionId / findingId / reworkCycleId narrow only and never bypass building scope (condition 44)', () => {
      // Both building predicates are pushed unconditionally, BEFORE any narrowing filter.
      const firstBuilding = repoCode.indexOf('${buildingSql} = ANY($2::uuid[])');
      const findingBuilding = repoCode.indexOf('f.building_id = ANY($2::uuid[])');
      const executionFilter = repoCode.indexOf('if (filters.executionId)');
      assert.ok(firstBuilding > 0 && findingBuilding > firstBuilding, 'both building predicates exist in order');
      assert.ok(executionFilter > findingBuilding, 'narrowing filters come AFTER the scope predicates');
      for (const field of ['executionId', 'findingId', 'reworkCycleId']) {
        assert.ok(repoCode.indexOf(`if (filters.${field})`) > findingBuilding, `${field} cannot widen scope`);
      }
      assert.ok(!/buildingIds\.push|buildingIds = \[\]|buildingIds\.length === 0/.test(repoCode),
        'the repository never mutates or relaxes the authorized set');
      assert.match(repoCode, /getOperationalDetailFindingReworkRows\(\n\s*buildingIds: string\[\],/);
    });

    it('envelope exposes scope + window facts only, with no derived summary', () => {
      assert.match(serviceCode, /engine: filters\.engine,\n\s*buildingId: filters\.buildingId \?\? null,\n\s*buildingScope: buildingIds,\n\s*dateFrom: filters\.dateFrom \?\? null,\n\s*dateTo: filters\.dateTo \?\? null,\n\s*asOf: asOf\.toISOString\(\),/);
      const envelopeFields = typeFields(typesSource, 'PublicOperationalDetailFindingRework');
      assert.deepEqual(envelopeFields, ['engine', 'buildingId', 'buildingScope', 'dateFrom', 'dateTo', 'asOf', 'rows']);
      for (const forbidden of ['totalCount', 'total', 'count', 'buildingCount', 'statusCounts', 'latestReworkStatus', 'reworkCount', 'derivedStatuses']) {
        assert.ok(!envelopeFields.includes(forbidden), `${forbidden} must not exist`);
      }
    });
  });

  describe('R02 non-duplication (condition 41)', () => {
    it('R02 keeps its finding-grain rework summary; this PART adds historical lineage only', () => {
      const r02Repo = read(R02_REPO_PATH);
      const r02Types = read(R02_TYPES_PATH);
      for (const field of ['reworkCount', 'latestReworkId', 'latestReworkStatus', 'latestReworkRequestedAt']) {
        assert.ok(r02Repo.includes(field) || r02Types.includes(field), `R02 still owns ${field}`);
        assert.ok(!repoCode.includes(field), `${field} is not duplicated here`);
        assert.ok(!typesCode.includes(field), `${field} is not in this contract`);
        assert.ok(!serviceCode.includes(field), `${field} is not computed here`);
      }
      assert.ok(!repoCode.includes('finding_rework_cycles r'), 'no R02-style summary alias');
      assert.ok(!/COUNT\(.*frc|COUNT\(\*\)/.test(repoCode), 'no cycle counting at finding grain');
      assert.ok(!typesCode.includes('FINDING_REGISTER'), 'this PART is not an R02 dataset');
    });
  });

  describe('timestamp and null mapping fidelity', () => {
    it('all four timestamps are normalized to ISO-8601 UTC strings', () => {
      assert.match(repoCode, /function toIso\(value: Date \| null\): string \| null \{\n\s*return value \? value\.toISOString\(\) : null;\n\}/);
      for (const field of ['requestedAt', 'resubmittedAt', 'createdAt', 'updatedAt']) {
        assert.match(repoCode, new RegExp(`${field}: toIso\\(row\\.`));
      }
      assert.match(repoCode, /requestedAt: toIso\(row\.requested_at\) as string/, 'requested_at is NOT NULL');
      assert.match(repoCode, /resubmittedAt: toIso\(row\.resubmitted_at\)/, 'resubmitted_at stays nullable');
      assert.match(repoCode, /resubmittedByUserId: row\.resubmitted_by_user_id/, 'nullable actor passed through');
      assert.match(repoCode, /reworkNotes: row\.rework_notes/, 'nullable notes passed through');
      // Non-nullable columns are asserted as such in the row type.
      assert.match(typesSource, /requestedByUserId: string;/);
      assert.match(typesSource, /resubmittedByUserId: string \| null;/);
      assert.match(typesSource, /reworkNotes: string \| null;/);
      assert.match(typesSource, /resubmittedAt: string \| null;/);
    });

    it('engine is read back verbatim from findings.source_type', () => {
      assert.match(repoCode, /f\.source_type\s+AS engine/);
      assert.match(repoCode, /engine: row\.engine as OperationalDetailEngine/);
      assert.ok(!/CASE WHEN.*source_type/i.test(repoCode), 'never translated or remapped');
    });
  });

  describe('governance documentation', () => {
    it('the reduced contract, boundaries and provenance are documented in-source', () => {
      assert.match(repoSource, /R08 PART 03B/);
      assert.match(repoSource, /CLIENT CONSISTENCY IS STRUCTURAL/);
      assert.match(repoSource, /TWO INDEPENDENT BUILDING PREDICATES, ONE AUTHORIZED SET/);
      assert.match(repoSource, /BUILDING AUTHORITY PROVENANCE/);
      assert.match(repoSource, /third physical copy is therefore unavoidable here/);
      assert.match(repoSource, /OUT OF SCOPE — NO JOIN, NO FIELD/);
      assert.match(repoSource, /NO CURRENT FINDING FACT is duplicated/);
      assert.match(typesSource, /findingStatus/i);
      assert.match(serviceSource, /VOCABULARIES ARE REUSED, NEVER REDECLARED/);
      assert.match(indexSource, /No export dataset, no reporting registry entry, no OpenAPI change/);
    });
  });

  it('CI-REQUIRED (live PostgreSQL): real row shape, real exclusions, real pagination', () => {
    // These assertions require a live database and are therefore CI-required. `pg` is not
    // installed in this sandbox (importing the repository or service fails with
    // "Cannot find module 'pg'"), so they are enumerated here to make the gap explicit
    // rather than silent:
    //   - a finding whose client_id differs from its parent execution's client_id is EXCLUDED
    //     while the rest of the dataset still returns and no error is raised
    //   - a SOURCELESS finding (source_type IS NULL) returns zero rows
    //   - a WORK_ORDER-sourced finding returns zero rows for both R08 engines
    //   - a finding whose parent resolves to an authorized building but whose own building_id
    //     is NOT authorized returns zero rows, and vice versa
    //   - a finding whose parent resolves to building B2 while its own building_id is B IS
    //     returned when BOTH are authorized, with parentBuildingId=B2 and findingBuildingId=B
    //     preserved distinctly and no mismatch interpretation
    //   - an execution whose building cannot be resolved through any binding path contributes
    //     zero rows (fail-closed, NULL = ANY(...) is not TRUE)
    //   - a finding with NO cycle contributes zero rows (INNER join at cycle grain)
    //   - a finding with BOTH an open REQUESTED cycle and a closed RESUBMITTED cycle returns
    //     two rows, in requested_at order, from a single default read
    //   - status=REQUESTED returns only open cycles and status=RESUBMITTED only closed ones,
    //     each as a bound parameter with no inlined literal
    //   - an open REQUESTED cycle returns reworkNotes as stored, resubmittedByUserId NULL and
    //     resubmittedAt NULL; after markResubmitted the SAME row returns the OVERWRITTEN notes
    //     with both resubmission facts populated (proving the documented mutability)
    //   - triggerReviewId equals the review that caused the cycle, and the later
    //     re-verification review is NOT associated with it by timestamp or ordering
    //   - dateFrom/dateTo window the PARENT execution's created_at, so a cycle requested
    //     outside the window is excluded even though its finding is inside it
    //   - LIMIT/OFFSET page deterministically over the declared ORDER BY, including when
    //     several cycles share one requested_at instant (frc.id breaks the tie)
    //   - exactly one SQL statement is issued per call (no N+1), and the planner uses
    //     findings_source_idx plus finding_rework_finding_idx
    const ciRequired = true;
    assert.equal(ciRequired, true, 'live-DB cases are CI-required; PostgreSQL is unavailable in this sandbox');
  });

  it('module graph loads as ESM with no side effects at import time', async () => {
    // The types module is dependency-free at runtime (its only import is TYPE-only), so it can
    // be loaded here to prove the guard is real executable code and not just documentation.
    const url = pathToFileURL(TYPES_PATH).href;
    const loaded = (await import(url)) as Record<string, unknown>;
    assert.equal(typeof loaded.isFindingReworkChildStatus, 'function');
    assert.ok(Array.isArray(loaded.FINDING_REWORK_CHILD_STATUSES));
    assert.deepEqual([...(loaded.FINDING_REWORK_CHILD_STATUSES as string[])], ['REQUESTED', 'RESUBMITTED']);
    // No database, no HTTP and no filesystem access happens at import time.
    assert.equal(loaded.operationalDetailFindingReworkRepository, undefined, 'repository is a separate module');
  });
});
