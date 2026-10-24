#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repository = process.cwd();
const manifestPath = path.join(repository, 'scripts/ci/focused-tests.json');
const runbookPath = path.join(repository, 'docs/HANDYMAN_CI_SOURCE_CERTIFICATION.md');
const runnerPath = path.join(repository, 'scripts/ci/run-focused-tests.mjs');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const runbook = readFileSync(runbookPath, 'utf8');
const runner = readFileSync(runnerPath, 'utf8');

const expectedLanes = {
  'static-contracts': { files: 3, pass: 28 },
  'catalog-commerce': { files: 12, pass: 123 },
  'core-lifecycle': { files: 31, pass: 254 },
  'notification-security': { files: 11, pass: 210 },
  'migration-recovery': { files: 1, pass: 6 },
};

assert.deepEqual(
  Object.keys(manifest).sort(),
  Object.keys(expectedLanes).sort(),
  'The manual certification manifest must contain exactly the five approved lanes',
);

const workflowsDirectory = path.join(repository, '.github/workflows');
const workflowFiles = existsSync(workflowsDirectory)
  ? readdirSync(workflowsDirectory).filter((file) => /\.ya?ml$/i.test(file))
  : [];
assert.deepEqual(
  workflowFiles,
  [],
  'CR Owner policy: GitHub Actions workflow files are deliberately not adopted',
);
assert.ok(!existsSync(path.join(workflowsDirectory, 'ci.yml')));

for (const requiredText of [
  'Node.js **22**',
  'PostgreSQL **18**',
  '621 PASS / 0 FAIL / 0 SKIPPED',
  'Manual release approval',
  'run-metadata.txt',
  'git rev-parse HEAD',
  'DELIBERATELY NOT ADOPTED',
]) {
  assert.ok(runbook.includes(requiredText), `Manual certification runbook lacks: ${requiredText}`);
}
assert.ok(!runbook.includes('Settings → Rules → Rulesets'));
assert.ok(!runbook.includes('GITHUB_STEP_SUMMARY'));
assert.ok(!runner.includes('GITHUB_STEP_SUMMARY'));
assert.match(runner, /counts\.pass !== test\.pass/, 'PASS count drift must remain fatal');
assert.match(runner, /counts\.tests !== test\.pass/, 'TESTS count drift must remain fatal');
assert.match(runner, /'fail', 'cancelled', 'skipped', 'todo'/, 'Failure/skip rejection must remain enabled');
assert.ok(existsSync(path.join(repository, 'package-lock.json')), 'Locked npm installation requires package-lock.json');

let fileCount = 0;
let expectedResults = 0;
let filteredCount = 0;
const globalFiles = new Set();
for (const [laneName, expectation] of Object.entries(expectedLanes)) {
  const lane = manifest[laneName];
  assert.ok(lane && Array.isArray(lane.tests) && lane.tests.length > 0);
  assert.ok(Number.isInteger(lane.timeoutMs) && lane.timeoutMs > 0);
  assert.ok(lane.timeoutMs <= 1_800_000, `${laneName} timeout exceeds the approved bound`);

  const laneFiles = new Set();
  let lanePass = 0;
  for (const test of lane.tests) {
    assert.match(test.file, /^tests\/.+\.test\.ts$/);
    assert.ok(existsSync(path.join(repository, test.file)), `Missing ${test.file}`);
    assert.ok(!laneFiles.has(test.file), `Duplicate ${test.file} in ${laneName}`);
    assert.ok(!globalFiles.has(test.file), `Duplicate cross-lane coverage for ${test.file}`);
    laneFiles.add(test.file);
    globalFiles.add(test.file);
    assert.ok(Number.isInteger(test.pass) && test.pass > 0);
    assert.ok(!(test.namePattern && test.skipPattern), `Conflicting filters for ${test.file}`);
    if (test.namePattern || test.skipPattern) {
      assert.match(test.selectionReason ?? '', /BA-\d{2}/, 'Filtered tests need a registered reason');
      filteredCount += 1;
    } else {
      assert.equal(test.selectionReason, undefined);
    }
    lanePass += test.pass;
  }
  assert.equal(laneFiles.size, expectation.files, `${laneName} file-count drift`);
  assert.equal(lanePass, expectation.pass, `${laneName} expected-result drift`);
  fileCount += laneFiles.size;
  expectedResults += lanePass;
}

for (const script of [
  'scripts/ci/run-focused-tests.mjs',
  'scripts/ci/test-focused-test-runner.mjs',
  'scripts/ci/validate-migration-registry.ts',
  'scripts/ci/verify-migration-lifecycle.ts',
]) {
  assert.ok(existsSync(path.join(repository, script)), `Missing ${script}`);
}

assert.equal(fileCount, 58);
assert.equal(expectedResults, 621);
assert.equal(filteredCount, 3);

console.log(
  `MANUAL_CERTIFICATION_CONFIG_PASS | LANES=${Object.keys(expectedLanes).length} ` +
  `FILES=${fileCount} EXPECTED_RESULTS=${expectedResults} ` +
  `EXPLICIT_FILTERED_FILES=${filteredCount} NODE=22 POSTGRES=18 GITHUB_ACTIONS=NOT_ADOPTED`,
);
for (const [lane, configuration] of Object.entries(manifest)) {
  const pass = configuration.tests.reduce((sum, test) => sum + test.pass, 0);
  console.log(`MANUAL_LANE | ${lane} | FILES=${configuration.tests.length} EXPECTED_RESULTS=${pass}`);
}
