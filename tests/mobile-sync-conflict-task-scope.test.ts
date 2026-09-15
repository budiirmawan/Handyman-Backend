import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

/**
 * STRAND-ADJ-01 FIX-01 — the TASK_EXECUTION conflict probe must not read the
 * task outside the actor's BE-02G scope.
 *
 * `loadCurrentResourceState` answers "what does the server hold right now?"
 * for whichever resource a device named by id. A stale `baseVersion` is
 * therefore a read primitive: whatever this case returns is disclosed to an
 * authenticated offline-sync actor before any write authorization is reached.
 * Before this fix TASK_EXECUTION was the ONLY case that resolved the row with
 * an unscoped `getPool()` lookup plus the unscoped `getTaskPublic()` view,
 * while CHECKLIST_RESPONSES/TASK_ASSIGNMENT/PATROL_EXECUTION all routed the
 * same decision through a scoped authoritative loader.
 *
 * These tests are non-DB (source-contract style, per
 * tests/mobile-sync-kinds-contract.test.ts) because they must pin the WIRING
 * that carries the security invariant — which loader is used, with which
 * arguments, and in what order relative to the disclosure — none of which a
 * database-level behavioural test can pin. Two independent halves:
 *
 *   PART A proves the scoped loader is now the sole row+version source for
 *   TASK_EXECUTION and that the unscoped read path is gone (A, C, D).
 *   PART B proves the reused loader is in fact the scope authority, so the
 *   fix is a real enforcement change and not a rename (B).
 */

const CONFLICT = readSource('src/modules/mobile-sync/mobile-sync-conflict.ts');
const LOADER = readSource('src/modules/task-assignments/task-assignment.service.ts');

function readSource(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

/** The TASK_EXECUTION case body only — so assertions cannot pass on a sibling case. */
function taskExecutionCase(source: string): string {
  const start = source.indexOf("case 'TASK_EXECUTION':");
  assert.notEqual(start, -1, 'TASK_EXECUTION conflict case must exist');
  // Comments are stripped before slicing: the block is prose-heavy and the
  // literal text `case` inside a comment must not be mistaken for the next
  // switch clause. Assertions below therefore describe CODE, not narration.
  const body = source
    .slice(start)
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  const end = body.indexOf('case ', 'case'.length + 1);
  assert.notEqual(end, -1, 'TASK_EXECUTION case must be followed by another case');
  return body.slice(0, end);
}

describe('FIX-01 PART A — TASK_EXECUTION conflict read is scoped and never pre-reads', () => {
  const scope = taskExecutionCase(CONFLICT);

  it('resolves the task through the one existing scoped loader, for the acting user', () => {
    assert.match(
      scope,
      /loadTaskAssignmentTask\(\s*operation\.resourceId,\s*userId\s*\)/,
      'A.1 the conflict probe must use the existing BE-02G scoped loader with the actor',
    );
  });

  it('performs no unscoped read of the resource row before the access decision', () => {
    // D + the removal half of A. The defect was resolving the row (and its
    // version) directly off the pool, ahead of any scope check. Authorization
    // must be the FIRST statement, with no pool access preceding it.
    const authorityAt = scope.indexOf('loadTaskAssignmentTask(');
    const poolAt = scope.indexOf('getPool()');
    assert.notEqual(authorityAt, -1, 'A.2 the scoped loader must be present');
    assert.ok(
      poolAt === -1 || authorityAt < poolAt,
      'A.3 no unscoped pool read may precede the scope decision',
    );
    assert.doesNotMatch(
      scope,
      /SELECT\s+updated_at\s+FROM\s+generated_tasks/,
      'A.4 the dedicated unscoped version pre-read must be gone',
    );
    assert.doesNotMatch(
      scope.slice(0, authorityAt),
      /getTaskPublic|getTaskRecord/,
      'A.5 the public view must not be reachable before the scope decision',
    );
  });

  it('returns no current payload when the scope decision throws', () => {
    // D — the disclosure sits strictly after the authority call, and the case
    // keeps no null/empty-state branch that could carry `current` forward from
    // an unauthorised read.
    const authorityAt = scope.indexOf('loadTaskAssignmentTask(');
    const payloadAt = scope.indexOf('current:');
    assert.ok(
      authorityAt !== -1 && payloadAt !== -1 && authorityAt < payloadAt,
      'A.6 the scoped authority must run before any current payload is built',
    );
    assert.doesNotMatch(
      scope,
      /return\s+null\s*;/,
      'A.7 no silent null-path may bypass the loader and mask a scope refusal',
    );
  });

  it('preserves the version contract: updatedAt is still generated_tasks.updated_at', () => {
    // A — conflict protocol/version semantics are unchanged. PublicTask.updatedAt
    // is the same generated_tasks.updated_at value the previous SELECT returned,
    // so baseVersion comparison behaves identically for authorised callers.
    assert.match(
      scope,
      /updatedAt:\s*task\.updatedAt/,
      'A.8 the conflict version must be the authoritative task updatedAt',
    );
    assert.match(
      readSource('src/modules/task-execution/task-execution.service.ts'),
      /updatedAt:\s*row\.updated_at\.toISOString\(\)/,
      'A.9 PublicTask.updatedAt remains generated_tasks.updated_at',
    );
  });

  it('leaves the sibling conflict cases untouched', () => {
    // Scope-of-change guard: FIX-01 must not drift into unrelated resources.
    assert.match(CONFLICT, /case 'CHECKLIST_RESPONSES':[\s\S]*loadChecklistExecutionRow\(/, 'A.10');
    assert.match(CONFLICT, /case 'PATROL_EXECUTION':[\s\S]*getPatrolExecutionById\(/, 'A.11');
    assert.match(CONFLICT, /case 'METER_READING':[\s\S]*resolveMeterReadingContext\(/, 'A.12');
    assert.match(CONFLICT, /case 'TASK_ASSIGNMENT':[\s\S]*loadTaskAssignmentTask\(/, 'A.13');
  });
});

describe('FIX-01 PART B — the reused loader is the actual BE-02G authority', () => {
  it('enforces Building/Client accessibility and fails closed', () => {
    const fn = loaderFunction(LOADER, 'loadTaskAssignmentTask');
    // B — proves classification B rather than a cosmetic change: this loader
    // resolves accessibility from the ACTOR and throws on refusal.
    assert.match(
      fn,
      /getAccessibleBuildingIds\(\s*userId\s*\)/,
      'B.1 scope must be resolved from the acting user',
    );
    assert.match(
      fn,
      /getAccessibleClientIds\(\s*userId\s*\)/,
      'B.2 client-level tasks must fall back to client access',
    );
    assert.match(
      fn,
      /throw\s+buildingAccessDeniedError\(\)/,
      'B.3 an out-of-scope actor must be refused (BUILDING_ACCESS_DENIED)',
    );
    assert.match(
      fn,
      /throw\s+AppError\.notFound\('Task not found\.'\)/,
      'C.1 an unknown task id must keep the canonical NOT_FOUND',
    );
  });

  it('authorises from the row itself, never from request input', () => {
    const fn = loaderFunction(LOADER, 'loadTaskAssignmentTask');
    assert.match(fn, /row\.building_id\s*&&\s*buildingIds\.includes\(/, 'B.4');
    assert.match(
      fn,
      /!row\.building_id\s*&&\s*row\.client_id\s*&&\s*clientIds\.includes\(/,
      'B.5 building-less tasks are authorised on client access',
    );
  });

  it('keeps exactly one task-scope implementation for the conflict surface', () => {
    // Instruction guard: no second scope implementation was introduced.
    const conflict = readSource('src/modules/mobile-sync/mobile-sync-conflict.ts');
    assert.doesNotMatch(
      conflict,
      /getAccessibleBuildingIds|assertBuildingAccess|contextAccessService\./,
      'B.6 the conflict module must delegate scope rather than re-implement it',
    );
  });
});

function loaderFunction(source: string, name: string): string {
  const decl = `export async function ${name}`;
  const start = source.indexOf(decl);
  assert.notEqual(start, -1, `${decl} must exist in current main`);
  const next = source.indexOf('\nexport ', start + decl.length);
  return source.slice(start, next === -1 ? source.length : next);
}
