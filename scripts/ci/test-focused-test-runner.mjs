import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(scriptDirectory, '../..');
const fixture = mkdtempSync(path.join(tmpdir(), 'asentra-focused-runner-selftest-'));

try {
  mkdirSync(path.join(fixture, 'scripts/ci'), { recursive: true });
  copyFileSync(
    path.join(repository, 'scripts/ci/run-focused-tests.mjs'),
    path.join(fixture, 'scripts/ci/run-focused-tests.mjs'),
  );
  writeFileSync(path.join(fixture, 'package.json'), '{"type":"module"}\n');
  symlinkSync(path.join(repository, 'node_modules'), path.join(fixture, 'node_modules'), 'dir');
  writeFileSync(
    path.join(fixture, 'selftest.test.js'),
    `import test from 'node:test';
import assert from 'node:assert/strict';

test('controlled runner result', (t) => {
  if (process.env.FOCUSED_RUNNER_SELFTEST_MODE === 'skip') {
    t.skip('intentional runner rejection fixture');
  }
  if (process.env.FOCUSED_RUNNER_SELFTEST_MODE === 'fail') {
    assert.fail('intentional runner rejection fixture');
  }
});
`,
  );
  writeFileSync(
    path.join(fixture, 'scripts/ci/focused-tests.json'),
    `${JSON.stringify({
      'self-test': {
        description: 'Synthetic fail-closed runner verification; not a product test lane.',
        database: 'asentra_ci_runner_selftest',
        tests: [{ file: 'selftest.test.js', pass: 1, timeoutMs: 15_000 }],
      },
    }, null, 2)}\n`,
  );

  const execute = (mode) => {
    const artifactDirectory = path.join(fixture, 'artifacts', mode);
    const result = spawnSync(
      process.execPath,
      [path.join(fixture, 'scripts/ci/run-focused-tests.mjs'), 'self-test'],
      {
        cwd: fixture,
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          PATH: process.env.PATH ?? '',
          CI: 'true',
          CI_ARTIFACT_DIR: artifactDirectory,
          DB_NAME: 'asentra_ci_runner_selftest',
          FOCUSED_RUNNER_SELFTEST_MODE: mode,
          NODE_ENV: 'test',
        },
      },
    );
    assert.equal(result.error, undefined, `Runner self-test ${mode} failed to execute`);
    assert.equal(result.signal, null, `Runner self-test ${mode} was unexpectedly terminated`);
    return {
      ...result,
      output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
      artifactDirectory,
    };
  };

  const passing = execute('pass');
  assert.equal(passing.status, 0, passing.output);
  assert.match(passing.output, /LANE_PASS \| self-test \| FILES=1 PASS=1 FAIL=0 SKIPPED=0/);

  const failing = execute('fail');
  assert.notEqual(failing.status, 0, 'A failed test must make the runner fail');
  assert.match(failing.output, /LANE_FAIL \| self-test/);
  assert.match(failing.output, /PASS=0 FAIL=1 SKIPPED=0/);

  const skipped = execute('skip');
  assert.notEqual(skipped.status, 0, 'A skipped test must make the runner fail');
  assert.match(skipped.output, /expected SKIPPED=0, actual=1/);
  assert.match(skipped.output, /PASS=0 FAIL=0 SKIPPED=1/);

  for (const result of [passing, failing, skipped]) {
    const summaryPath = path.join(result.artifactDirectory, 'summary.json');
    assert.ok(existsSync(summaryPath), `Missing runner self-test artifact: ${summaryPath}`);
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
    assert.equal(summary.results.length, 1);
  }

  console.log('RUNNER_SELFTEST_PASS | PASS_CONTROL=1 FAILURE_REJECTED=1 SKIP_REJECTED=1');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
