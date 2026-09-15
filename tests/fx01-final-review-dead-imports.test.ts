import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { describe, it } from 'node:test';

/**
 * CR-BE-FX-01 FINAL REVIEW — dead-import guard.
 *
 * `npm run typecheck` cannot run in this environment (no `node_modules`, no
 * `tsc`), so the failure mode it would normally catch — an imported symbol that
 * is never used — has no other coverage. The FINAL REVIEW found exactly one such
 * defect: `contextAccessService` was imported by
 * `currency-reporting/reporting-currency-read-model.ts` but never called, which
 * was misleading because it implied an access check the file does not itself
 * perform. This test pins the fix.
 *
 * It is scoped to the FX-01 file set on purpose: it is a review guard for this
 * CR, not a repository-wide lint, and other modules are out of scope.
 */

const FX_FILES = [
  ...readdirSync(resolve('src/modules/fx-rates'))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => resolve('src/modules/fx-rates', f)),
  resolve('src/modules/currency-reporting/reporting-currency-read-model.ts'),
];

/** Returns the imported identifiers of a module, with `type` modifiers stripped. */
function importedNames(source: string): string[] {
  const names: string[] = [];
  for (const m of source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'[^']+'/g)) {
    for (const raw of m[1]!.split(',')) {
      let n = raw.trim();
      if (!n) continue;
      // NOTE: `[-1]` is undefined in JavaScript; `.at(-1)` is required.
      n = n.split(' as ').at(-1)!.trim();
      if (n.startsWith('type ')) n = n.slice(5).trim();
      if (n) names.push(n);
    }
  }
  for (const m of source.matchAll(/import\s+([A-Za-z_$][\w$]*)\s*from\s*'[^']+'/g)) {
    names.push(m[1]!);
  }
  return names;
}

/**
 * The module body with every import statement removed AND comments stripped.
 *
 * Stripping comments matters: without it a symbol mentioned only inside a
 * comment counts as "used", which is exactly how the defect this test exists to
 * catch would hide. Verified by mutation: re-adding the dead
 * `contextAccessService` import fails this suite.
 */
function bodyWithoutImports(source: string): string {
  return source
    .replace(/import\s+(?:type\s+)?\{[^}]*\}\s*from\s*'[^']+';?/g, '')
    .replace(/import\s+[A-Za-z_$][\w$]*\s*from\s*'[^']+';?/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .map((line) => line.replace(/\s\/\/.*$/, ''))
    .join('\n');
}

describe('CR-BE-FX-01 FINAL REVIEW — no dead imports in the FX-01 file set', () => {
  it('scans the expected files', () => {
    assert.ok(FX_FILES.length >= 14, `expected the FX file set, found ${FX_FILES.length}`);
    assert.ok(
      FX_FILES.some((f) => f.endsWith('reporting-currency-read-model.ts')),
      'the PART 04 adapter must be in scope',
    );
  });

  it('uses every symbol it imports', () => {
    const dead: string[] = [];
    for (const file of FX_FILES) {
      const source = readFileSync(file, 'utf8');
      const body = bodyWithoutImports(source);
      for (const name of importedNames(source)) {
        if (!new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`).test(body)) {
          dead.push(`${file.split(`${sep}modules${sep}`)[1]} -> ${name}`);
        }
      }
    }
    assert.deepEqual(dead, [], 'every imported symbol must be used');
  });

  it('does not re-import contextAccessService into the reporting adapter', () => {
    const source = readFileSync(resolve('src/modules/currency-reporting/reporting-currency-read-model.ts'), 'utf8');
    // Code only: the delegation is explained in a comment that legitimately
    // names the service, so comments are stripped before the negative check.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*)/.test(line))
      .join('\n');
    assert.doesNotMatch(code, /contextAccessService/,
      'authorization is delegated to the CUR-01 seam; do not import the service unused');
    // And the delegation is documented, so the security posture stays explicit.
    assert.match(source, /assertBuildingAccess\(actorUserId, buildingId\)/);
    assert.match(source, /getOperationalCurrencySummary\(buildingId, actorUserId\)/);
  });
});
